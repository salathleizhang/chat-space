import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from "three";
import { parseIndexedName } from "../common/indexedFiles";
import type { AssetTransform, Vec3 } from "../dto/library";
import type { AssetStorage } from "./assetStorage";

/**
 * 模型文件的真实尺寸测量。原先这两段逻辑长在 `tools/sceneAnalysis.ts` 里，
 * 摆放（placement）也要用同一套判断"哪个文件才是当前模型"和"它有多大"，
 * 所以抽到这里，只有一份实现。
 */

const MODEL_EXT_RE = /^(glb|gltf|obj|fbx|stl)$/i;

/** 轴对齐包围盒（世界坐标，已套用摆放）；与 `services/sceneAnalysis.ts` 的 SceneBounds 同构。 */
export interface ModelBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/**
 * 最新一代模型文件：按索引取最大，同索引优先 `.glb`。
 * 一个资产目录里可能同时留着多代产物与多种格式，必须只认最后生成的那一份。
 */
export function latestModelFile(files: string[]): string | null {
  let best: { name: string; index: number; glb: boolean } | null = null;
  for (const name of files) {
    const parsed = parseIndexedName(name);
    if (!parsed || !MODEL_EXT_RE.test(parsed.ext)) continue;
    const glb = parsed.ext.toLowerCase() === "glb";
    if (
      !best ||
      parsed.index > best.index ||
      (parsed.index === best.index && glb && !best.glb)
    ) {
      best = { name, index: parsed.index, glb };
    }
  }
  return best?.name ?? null;
}

export function finiteVec3(value: readonly number[]): value is Vec3 {
  return value.length === 3 && value.every(Number.isFinite);
}

/**
 * 摆放（T·R·S）对应的世界矩阵。欧拉序固定 **XYZ、弧度**，与 `scene.json` 的
 * `AssetTransform` 契约一致；app 侧 `<group position rotation scale>` 也是同一套。
 *
 * 单独抽出来是因为"量包围盒"和"把网格顶点搬到世界空间"必须用**同一份**合成顺序：
 * 采样表面高度时只要这两处差一点，落点就会偏出物体。
 */
export function placementMatrix(transform: AssetTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

/** 把局部包围盒按摆放（T·R·S，XYZ 欧拉序）变换成世界包围盒。 */
export function transformBounds(
  min: Vec3,
  max: Vec3,
  transform: AssetTransform,
): ModelBounds {
  const matrix = placementMatrix(transform);
  const box = new Box3();
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        box.expandByPoint(new Vector3(x, y, z).applyMatrix4(matrix));
      }
    }
  }
  const size = box.getSize(new Vector3());
  return {
    min: box.min.toArray() as Vec3,
    max: box.max.toArray() as Vec3,
    size: size.toArray() as Vec3,
  };
}

/** 直接量 GLB 字节；解析失败返回 undefined（调用方一律按"量不到"处理，不抛错）。 */
export async function glbBoundsFromBytes(bytes: Uint8Array): Promise<ModelBounds | undefined> {
  try {
    const document = await new NodeIO().readBinary(bytes);
    const scenes = document.getRoot().listScenes();
    let min: Vec3 | undefined;
    let max: Vec3 | undefined;
    for (const scene of scenes) {
      const bounds = getBounds(scene);
      if (!finiteVec3(bounds.min) || !finiteVec3(bounds.max)) continue;
      min = min
        ? [Math.min(min[0], bounds.min[0]), Math.min(min[1], bounds.min[1]), Math.min(min[2], bounds.min[2])]
        : [...bounds.min] as Vec3;
      max = max
        ? [Math.max(max[0], bounds.max[0]), Math.max(max[1], bounds.max[1]), Math.max(max[2], bounds.max[2])]
        : [...bounds.max] as Vec3;
    }
    return min && max ? transformBounds(min, max, IDENTITY_TRANSFORM) : undefined;
  } catch {
    return undefined;
  }
}

const IDENTITY_TRANSFORM: AssetTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

/** 量出资产的模型包围盒（含摆放）；非 GLB 或读不出来返回 undefined。 */
export async function readGlbBounds(
  storage: AssetStorage,
  modelPath: string,
  transform: AssetTransform = IDENTITY_TRANSFORM,
): Promise<ModelBounds | undefined> {
  if (!modelPath.toLowerCase().endsWith(".glb")) return undefined;
  try {
    const local = await glbBoundsFromBytes(await storage.readBytes(modelPath));
    return local ? transformBounds(local.min, local.max, transform) : undefined;
  } catch {
    // 读取失败与解析失败同义：调用方按"这个格式量不到"处理，不能让分析/摆放整体失败。
    return undefined;
  }
}
