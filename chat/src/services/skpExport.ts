/**
 * GLB → SKP 导出（方案 A2：三角汤 + base color 贴图）。
 *
 * 用 openskp 的 legacy 写入器（输出 SketchUp 2013–2020 世代的 v17 文件，英寸单位）。
 * 每个三角形写成一个面，**不做共面合并**——所以 SketchUp 里每个平面都会留下三角剖分的
 * 对角线，推拉工具按三角形生效。这是刻意的取舍：不引入任何几何重建，只做坐标与贴图的搬运。
 *
 * 三处换算在这里一次对齐：
 *   ① 位置：glTF 是 Y 轴朝上、米；SketchUp 是 Z 轴朝上、英寸。
 *      Y-up → Z-up 是绕 X 轴 +90°：(x, y, z) → (x, -z, y)，再乘 `METRES_TO_INCHES`。
 *   ② UV：glTF 的 v 轴朝下、SketchUp 朝上，所以 v' = 1 - v。
 *   ③ 贴图矩阵：必须按"法线推出来的规范基"写，见 `skpUvFrame.ts` 的说明与下面的常量。
 *
 * 内存口径：写入器约 12.7 KB / 三角面（实测）。Tripo 的高模动辄 100–150 万面（外推约 19 GB），
 * 所以超过准入就先**自动减面**，减不下来才拒绝——那个进程里还压着已付费任务的推进闸门。
 */
import {
  NodeIO,
  type Accessor,
  type Document,
  type Material,
  type Primitive,
  type Texture,
} from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { METRES_TO_INCHES, create, type SkpBuilder, type UvPair } from "openskp";
import { ChatServiceError } from "../common/errors";
import { compensateUv, newellNormal, type Uv, type Vec3 } from "./skpUvFrame";

/** 三角数准入（约 2.5 GB 内存）。可用环境变量 `SKP_MAX_TRIANGLES` 覆盖。 */
export const SKP_MAX_TRIANGLES = 200_000;

/**
 * 超过准入时最多减面几轮。`simplify` 的 `ratio` 是按顶点比例给的，而我们要的是面数，
 * 所以每轮重新数一遍、按实测比例再压一次，而不是赌一轮就够。
 */
const DECIMATE_PASSES = 3;

/** SketchUp 只吃 PNG/JPEG 贴图 */
const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

export interface SkpExportOptions {
  /** 三角数上限，测试可以放小以覆盖减面/拒绝路径 */
  maxTriangles?: number;
  /** 是否携带 base color 贴图；关掉就退化为纯几何（方案 A） */
  textures?: boolean;
}

export interface SkpExportResult {
  bytes: Uint8Array;
  /** 实际写进文件的面数 */
  facesWritten: number;
  /** 其中带显式贴图映射（frontUv 钉住）的面数 */
  facesWithUv: number;
  /** UV 退化（共线）而退回 SketchUp 默认投影的面数 */
  facesWithoutUv: number;
  /** 转换时实际用的三角数（减面后） */
  triangles: number;
  /** 源三角数，仅在被减面时存在 */
  decimatedFrom?: number;
  /** 可选提示（例如贴图格式不受支持而降级） */
  notices: string[];
}

interface MeshPart {
  primitive: Primitive;
  positions: Accessor;
  uvs: Accessor | null;
  indices: Accessor | null;
  world: Float32Array | number[];
}

interface MaterialSlot {
  handle: number;
  textured: boolean;
}

/** 摊平所有带网格的节点；三角数准入与减面判断都基于它 */
function collectParts(document: Document): MeshPart[] {
  const parts: MeshPart[] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) continue;
      parts.push({
        primitive,
        positions,
        uvs: primitive.getAttribute("TEXCOORD_0"),
        indices: primitive.getIndices(),
        world,
      });
    }
  }
  return parts;
}

function countTriangles(parts: readonly MeshPart[]): number {
  return parts.reduce(
    (total, part) => total + Math.floor((part.indices ? part.indices.getCount() : part.positions.getCount()) / 3),
    0,
  );
}

/**
 * 自动减面：先 `weld` 再 `simplify`。`weld` 只合并**逐位相同**的顶点，所以 UV 接缝不会被
 * 揉掉（接缝两侧的顶点 UV 不同，合并不了）。减面会改几何，这是"能导出"与"导不出"之间的
 * 取舍：SketchUp 自己也吃不下百万面，先减到能用的规模比直接失败对用户更有用。
 */
async function decimate(document: Document, targetTriangles: number, triangles: number): Promise<void> {
  await MeshoptSimplifier.ready;
  let current = triangles;
  for (let pass = 0; pass < DECIMATE_PASSES && current > targetTriangles; pass++) {
    const ratio = Math.max(0.001, Math.min(1, (targetTriangles / current) * 0.9));
    await document.transform(
      weld({ overwrite: true }),
      simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001 }),
    );
    const next = countTriangles(collectParts(document));
    if (next >= current) break; // 已经压不动了，别空转
    current = next;
  }
}

function imageOf(texture: Texture | null): { bytes: Uint8Array; mime: string; name: string } | null {
  if (!texture) return null;
  const bytes = texture.getImage();
  if (!bytes || bytes.length === 0) return null;
  return {
    bytes,
    mime: texture.getMimeType() || "application/octet-stream",
    name: texture.getName() || texture.getURI() || "texture",
  };
}

/**
 * 每个 glTF 材质对应一个 openskp 材质：有 base color 贴图就走贴图材质，否则退回底色。
 * 只带 base color —— SketchUp 这条路上用不到 normal/roughness，带上去只会让文件更大。
 */
function materialSlot(
  builder: SkpBuilder,
  material: Material | null,
  cache: Map<Material, MaterialSlot>,
  notices: string[],
  useTextures: boolean,
): MaterialSlot | undefined {
  if (!material) return undefined;
  const cached = cache.get(material);
  if (cached) return cached;

  const [r, g, b, a] = material.getBaseColorFactor();
  const name = material.getName() || `Material ${cache.size + 1}`;
  const opacity = a < 1 ? a : undefined;
  const image = useTextures ? imageOf(material.getBaseColorTexture()) : null;

  if (image && SUPPORTED_IMAGE_MIME.has(image.mime)) {
    // appliedHeight/appliedWidth 不传：默认 1 英寸/瓦片，映射由逐面 frontUv 钉住
    const handle = builder.addTextureMaterial(
      name,
      image.bytes,
      /\.(png|jpe?g)$/i.test(image.name) ? image.name : `${name}.jpg`,
      undefined,
      undefined,
      opacity,
    );
    const slot = { handle, textured: true };
    cache.set(material, slot);
    return slot;
  }
  if (image) {
    notices.push(`贴图 ${image.name} 是 ${image.mime}，SketchUp 只吃 PNG/JPEG，已退化为底色`);
  }
  const slot: MaterialSlot = {
    handle: builder.addMaterial(
      name,
      [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)],
      opacity,
    ),
    textured: false,
  };
  cache.set(material, slot);
  return slot;
}

/** 世界矩阵变换一个点（gl-matrix 列主序：平移在 12/13/14），并做 Y-up→Z-up 与米→英寸 */
function applyWorld(world: Float32Array | number[], point: number[], scale: number): Vec3 {
  const x = world[0]! * point[0]! + world[4]! * point[1]! + world[8]! * point[2]! + world[12]!;
  const y = world[1]! * point[0]! + world[5]! * point[1]! + world[9]! * point[2]! + world[13]!;
  const z = world[2]! * point[0]! + world[6]! * point[1]! + world[10]! * point[2]! + world[14]!;
  return [x * scale, -z * scale, y * scale];
}

/**
 * 三个 UV 张成的面积（×2）。共线时为 0，无法确定仿射映射。
 * 阈值必须与写入器的判据同量级：openskp 的 `solve3x3` 在 `|det| < 1e-9` 时抛错，
 * 而 det 就是这个面积——守卫比它宽的话，近共线的窄面会从我这儿溜进去、让整份导出失败。
 */
const UV_AREA_MIN = 1e-9;

function uvArea2(uvs: readonly Uv[]): number {
  return Math.abs(
    (uvs[1]![0] - uvs[0]![0]) * (uvs[2]![1] - uvs[0]![1]) -
      (uvs[1]![1] - uvs[0]![1]) * (uvs[2]![0] - uvs[0]![0]),
  );
}

/**
 * 算出该喂给写入器的 UV；**算不出来就返回 undefined**，让这个面退回 SketchUp 的默认投影。
 *
 * 两个必须守住的点：① UV 共线的面（减面会让 UV 退化，源里也常见）会让 openskp 的 `solve3x3`
 * 抛 `SkpWriteError`，那是**整份导出**失败——一个坏面不该毁掉整个文件；② 几何退化虽已在上游
 * 按面积过滤，但补偿解算本身也可能数值上不可逆。
 */
function pinnedUvFor(points: readonly Vec3[], uvs: readonly Uv[]): Uv[] | undefined {
  if (!(uvArea2(uvs) > UV_AREA_MIN)) return undefined;
  try {
    return compensateUv(points, newellNormal(points), uvs);
  } catch {
    return undefined;
  }
}

/**
 * 把一个 GLB 转成 SKP。源必须是自包含的 glb（与 gltf/obj 导出同一条准入）。
 *
 * 超过 `maxTriangles` 时先自动减面；减不下来才抛错。
 *
 * @throws ChatServiceError `skp_too_many_triangles`（减面后仍超限）/ `skp_empty_scene`（没有可写几何）
 */
export async function glbToSkp(glb: Uint8Array, options: SkpExportOptions = {}): Promise<SkpExportResult> {
  const envCap = Number(process.env.SKP_MAX_TRIANGLES);
  const maxTriangles =
    options.maxTriangles ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : SKP_MAX_TRIANGLES);
  const useTextures = options.textures ?? true;
  const notices: string[] = [];

  const document = await io.readBinary(glb);
  let parts = collectParts(document);
  let triangles = countTriangles(parts);
  let decimatedFrom: number | undefined;

  if (triangles > maxTriangles) {
    decimatedFrom = triangles;
    await decimate(document, maxTriangles, triangles);
    parts = collectParts(document);
    triangles = countTriangles(parts);
    if (triangles > maxTriangles) {
      throw new ChatServiceError(
        `The model has ${decimatedFrom.toLocaleString()} triangles and could not be reduced below the SKP export` +
          ` limit of ${maxTriangles.toLocaleString()} (the writer needs roughly 12.7 KB of memory per face).`,
        413,
        "skp_too_many_triangles",
      );
    }
    notices.push(`模型已自动减面：${decimatedFrom.toLocaleString()} → ${triangles.toLocaleString()} 三角面`);
  }
  if (triangles === 0) {
    throw new ChatServiceError("The model has no triangles to export", 422, "skp_empty_scene");
  }

  const builder = create();
  const cache = new Map<Material, MaterialSlot>();
  // 格式硬要求：材质必须先于任何几何写进去
  for (const material of document.getRoot().listMaterials()) {
    materialSlot(builder, material, cache, notices, useTextures);
  }

  const point: number[] = [0, 0, 0];
  const uv: number[] = [0, 0];
  const corners: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const uvs: Uv[] = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  let facesWritten = 0;
  let facesWithUv = 0;
  let facesWithoutUv = 0;

  for (const { primitive, positions, uvs: uvAccessor, indices, world } of parts) {
    const slot = materialSlot(builder, primitive.getMaterial(), cache, notices, useTextures);
    const count = indices ? indices.getCount() : positions.getCount();
    // 只有"材质带贴图且有 TEXCOORD_0"的面才钉 UV；否则交给写入器的默认投影
    const pinned = Boolean(slot?.textured && uvAccessor);

    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vertexIndex = indices ? indices.getScalar(i + k) : i + k;
        positions.getElement(vertexIndex, point);
        corners[k] = applyWorld(world, point, METRES_TO_INCHES);
        if (pinned) {
          uvAccessor!.getElement(vertexIndex, uv);
          // glTF 的 v 朝下、SketchUp 朝上
          uvs[k] = [uv[0]!, 1 - uv[1]!];
        }
      }

      // 退化三角形（面积为 0）在 SketchUp 侧是坏面，直接丢
      const [a, b, c] = corners as [Vec3, Vec3, Vec3];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(area2 > 1e-9) || !Number.isFinite(area2)) continue;

      const points: Vec3[] = [
        [a[0], a[1], a[2]],
        [b[0], b[1], b[2]],
        [c[0], c[1], c[2]],
      ];
      let frontUv: UvPair[] | undefined;
      if (pinned) {
        // 见 skpUvFrame.ts：写入器按"第一条边"建基是 TS 移植 bug，真 SketchUp 用的是法线规范基
        const fed = pinnedUvFor(points, uvs);
        if (fed) {
          frontUv = [
            [points[0]!, fed[0]!],
            [points[1]!, fed[1]!],
            [points[2]!, fed[2]!],
          ];
        } else {
          facesWithoutUv++;
        }
      }
      const material = slot ? { material: slot.handle } : {};
      if (frontUv) {
        try {
          builder.addFace(points, { ...material, frontUv });
          facesWithUv++;
        } catch {
          // 兜底：映射被写入器拒收时退回默认投影再写一次。
          // writeFace 是"先算 UV 矩阵、再写字节"，算不出来时一个字节都没落盘，所以重写是安全的。
          builder.addFace(points, material);
          facesWithoutUv++;
        }
      } else {
        builder.addFace(points, material);
      }
      facesWritten++;
    }
  }

  if (facesWithoutUv > 0) {
    notices.push(`${facesWithoutUv} 个面的 UV 退化（三点的 UV 共线），未钉贴图映射，走 SketchUp 默认投影`);
  }

  return {
    bytes: builder.toBytes(),
    facesWritten,
    facesWithUv,
    facesWithoutUv,
    triangles,
    decimatedFrom,
    notices,
  };
}
