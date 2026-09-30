import { NodeIO, Primitive, type Node as GltfNode } from "@gltf-transform/core";
import { Matrix4 } from "three";
import type { Vec3 } from "../dto/library";
import type { WorldSemantics } from "../models/worldlabs";
import type { AssetStorage } from "./assetStorage";

/**
 * 从 World Labs 的 collider 网格里取"某个 (x, z) 处的地面高度"。
 *
 * 为什么需要它：模型默认被摆在 y=0 的平面上，而生成出来的世界地面并不总是恰好
 * 在 0——有台阶、地台、地毯或倾斜地面时，家具会浮空或陷进地里。有了这张真实
 * 地形高度图，摆放可以把物体脚底落在实际地面上。
 *
 * 三条硬性约定：
 * 1. **几何先做世界对齐**（`flipY` / `metricScaleFactor` / `groundPlaneOffset`），
 *    与 app 的 `worldTransform()`（`app/src/widgets/Viewport/worldTransform.ts`）
 *    同一套组合顺序，否则采样点会比摆放点整体错位。
 * 2. 同一 (x, z) 可能有多层表面（地面、桌面、天花板）。这里取**最接近参考平面**
 *    （默认 y=0）的那一层：天花板不参与，家具因此落在楼板而不是天花板上。
 *    墙面是竖直面，投影到 XZ 后退化成零面积，会被跳过。
 * 3. **任何失败都返回 `null`，由调用方退回平面 y=0**——collider 可能是任何东西
 *    （测试夹具就是四字节的假 GLB），摆放不能因为地形读不出来而整体失败。
 */

/** 每 9 个 float 一个三角形：ax, ay, az, bx, by, bz, cx, cy, cz（世界对齐后的坐标）。 */
export interface GroundMesh {
  positions: Float32Array;
  triangleCount: number;
}

export type GroundTriangle = readonly [Vec3, Vec3, Vec3];

/**
 * 三角形数量上限：collider 常见几十万面，超过这个量级说明文件异常（或不是 collider），
 * 与其冒着把进程内存吃光再算错的风险，不如退回平面摆放。
 */
const MAX_TRIANGLES = 600_000;

const EPSILON = 1e-9;

export function groundMeshFromTriangles(triangles: readonly GroundTriangle[]): GroundMesh {
  const positions = new Float32Array(triangles.length * 9);
  triangles.forEach((triangle, index) => {
    const offset = index * 9;
    triangle.forEach((point, corner) => {
      positions[offset + corner * 3] = point[0];
      positions[offset + corner * 3 + 1] = point[1];
      positions[offset + corner * 3 + 2] = point[2];
    });
  });
  return { positions, triangleCount: triangles.length };
}

/** 把 collider 的原始坐标搬到 app 渲染世界时用的那套坐标（Y-up、米制、地面抬到 0）。 */
export function alignGroundMesh(mesh: GroundMesh, semantics: WorldSemantics): GroundMesh {
  const { flipY, metricScaleFactor, groundPlaneOffset } = semantics;
  const positions = new Float32Array(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index]! * metricScaleFactor;
    const y = mesh.positions[index + 1]! * metricScaleFactor * (flipY ? -1 : 1);
    const z = mesh.positions[index + 2]! * metricScaleFactor * (flipY ? -1 : 1);
    positions[index] = x;
    positions[index + 1] = y + groundPlaneOffset;
    positions[index + 2] = z;
  }
  return { positions, triangleCount: mesh.triangleCount };
}

/**
 * (x, z) 处的地面高度；命中不到（网格不覆盖该点）返回 `null`。
 * `reference` 是"哪一层更像地面"的判据，默认 0（世界对齐后的地面平面）。
 */
export function sampleGroundHeight(
  mesh: GroundMesh,
  x: number,
  z: number,
  reference = 0,
): number | null {
  const positions = mesh.positions;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const offset = triangle * 9;
    const ax = positions[offset]!;
    const ay = positions[offset + 1]!;
    const az = positions[offset + 2]!;
    const bx = positions[offset + 3]!;
    const by = positions[offset + 4]!;
    const bz = positions[offset + 5]!;
    const cx = positions[offset + 6]!;
    const cy = positions[offset + 7]!;
    const cz = positions[offset + 8]!;
    // 先在 XZ 包围盒上排除：绝大多数三角形在这一步就出局。
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx)) continue;
    if (z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue;
    const v0x = bx - ax;
    const v0z = bz - az;
    const v1x = cx - ax;
    const v1z = cz - az;
    const denominator = v0x * v1z - v1x * v0z;
    // 竖直面投影到 XZ 后退化成零面积，跳过（墙面不该被当成地面）。
    if (Math.abs(denominator) < EPSILON) continue;
    const px = x - ax;
    const pz = z - az;
    const u = (px * v1z - v1x * pz) / denominator;
    const v = (v0x * pz - px * v0z) / denominator;
    if (u < -EPSILON || v < -EPSILON || u + v > 1 + EPSILON) continue;
    const y = ay + u * (by - ay) + v * (cy - ay);
    const distance = Math.abs(y - reference);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = y;
    }
  }
  return best;
}

/** 把地面网格包成"查询不抛错"的采样器：网格缺失或不覆盖该点一律给 `null`。 */
export function buildGroundSampler(mesh: GroundMesh | null): (x: number, z: number) => number | null {
  if (!mesh || mesh.triangleCount === 0) return () => null;
  return (x, z) => sampleGroundHeight(mesh, x, z);
}

/**
 * 读世界资产的 collider GLB 并做世界对齐。读不出、不是 GLB、面数超限、
 * 或位置属性不是 Float32（量化过的网格）都返回 `null`，交由调用方退回平面。
 */
export async function loadWorldGroundMesh(
  storage: AssetStorage,
  modelPath: string,
  semantics: WorldSemantics,
): Promise<GroundMesh | null> {
  if (!modelPath.toLowerCase().endsWith(".glb")) return null;
  try {
    const document = await new NodeIO().readBinary(await storage.readBytes(modelPath));
    const triangles: GroundTriangle[] = [];
    for (const scene of document.getRoot().listScenes()) {
      for (const node of scene.listChildren()) {
        collectNodeTriangles(node, new Matrix4(), triangles);
      }
    }
    if (triangles.length === 0 || triangles.length > MAX_TRIANGLES) return null;
    return alignGroundMesh(groundMeshFromTriangles(triangles), semantics);
  } catch {
    return null;
  }
}

/** 遍历节点树，把每个三角形的三个顶点乘上累积节点矩阵。 */
function collectNodeTriangles(
  node: GltfNode,
  parent: Matrix4,
  out: GroundTriangle[],
): void {
  if (out.length > MAX_TRIANGLES) return;
  const local = node.getMatrix();
  const world = local ? new Matrix4().fromArray(local).premultiply(parent) : parent;
  for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    if (out.length > MAX_TRIANGLES) return;
    if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
    const attribute = primitive.getAttribute("POSITION");
    const array = attribute?.getArray();
    // 量化/归一化的位置属性是整数数组，手工反量化容易出错，直接放弃采样。
    if (!attribute || attribute.getElementSize() !== 3 || !(array instanceof Float32Array)) continue;
    const indices = primitive.getIndices()?.getArray();
    const count = indices ? indices.length : attribute.getCount();
    for (let index = 0; index + 3 <= count; index += 3) {
      const a = indices ? indices[index]! : index;
      const b = indices ? indices[index + 1]! : index + 1;
      const c = indices ? indices[index + 2]! : index + 2;
      out.push([
        applyMatrix(world, array, a),
        applyMatrix(world, array, b),
        applyMatrix(world, array, c),
      ]);
    }
  }
  for (const child of node.listChildren()) collectNodeTriangles(child, world, out);
}

/** 手工做 4×4 × 点：逐顶点建 Vector3 在大网格上会产生大量垃圾对象。 */
function applyMatrix(matrix: Matrix4, positions: Float32Array, index: number): Vec3 {
  const x = positions[index * 3]!;
  const y = positions[index * 3 + 1]!;
  const z = positions[index * 3 + 2]!;
  const e = matrix.elements;
  return [
    e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
    e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
    e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
  ];
}
