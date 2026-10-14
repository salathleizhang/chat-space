import { Vector3 } from "three";
import { ChatServiceError } from "../common/errors";
import { assetDir, projectSceneFile } from "../common/libraryPaths";
import type { AssetTransform, Vec3 } from "../dto/library";
import { assetStableId } from "../dto/library";
import { getProjectState, writeSceneTransforms, type ProjectState } from "../mastra/tools/projectTools";
import type { AssetStorage } from "./assetStorage";
import { loadModelSurfaceMesh, sampleHighestSurface } from "./groundSampler";
import {
  latestModelFile,
  placementMatrix,
  readGlbBounds,
  transformBounds,
  type ModelBounds,
} from "./modelBounds";
import { computeSceneLayout, type PlaceableAsset } from "./sceneLayout";
import { placementScale } from "./scenePlacement";

/**
 * **显式摆放单个/几个已生成的模型**：免费、确定性、不需要 SceneSpec、不调用任何供应商。
 *
 * 为什么需要它：`place-scene-objects` 走的是"按参考图把整套家具摆回原位"，它的输入是
 * 场景分析（SceneSpec）里的归一化框和相机估计——那份规格只有完整场景任务
 * （start-scene-job）才会产生。于是"给已有场景补一个对象"（用户说"在沙发上放个玩偶"）
 * 和"逐个生成资产"的项目就完全没有可用的摆放通路，工具会以 409「还没有已确认的完整
 * 场景」拒绝，而且 agent 侧无法自行补齐那份规格。
 *
 * 这个实现只回答一个问题：**把某个资产摆在哪**。三种给法可以任意组合：
 * - `position`：直接给世界坐标（语义是"包围盒**底面中心**落在哪"，不是模型原点——
 *   生成器把原点放在几何中心，按原点给坐标会有一半埋进地面）；
 * - `onSurfaceOf`：落到另一个资产的上表面（在该资产当前摆放的世界空间网格上取
 *   最高的一层，默认采样点是它的包围盒中心）；
 * - `heightMeters` / `scale`：统一缩放。生成器把模型归一化到"最长边 = 1 单位"，
 *   所以不给真实高度时不同资产之间没有可比的比例。
 *
 * 结果与 gizmo 手动摆放写的是**同一张表**（`scene.json` 的 transforms，按资产稳定 id
 * 索引），所以用户之后仍可在视口里微调；文件里的其余条目一概不动。
 */

/** `offset` 的 x/z 在目标表面上挪采样点，y 是落点抬高量；单位都是米。 */
export interface SurfaceTarget {
  slug: string;
  offset?: Vec3;
}

export interface ObjectPlacementItem {
  slug: string;
  position?: Vec3;
  onSurfaceOf?: SurfaceTarget;
  heightMeters?: number;
  scale?: number;
  /** 弧度、XYZ 序——与 `scene.json` 的 `AssetTransform.rotation` 同一套。 */
  rotation?: Vec3;
  /** 只绕 +Y 转时的角度写法；与 `rotation` 互斥。 */
  yawDegrees?: number;
}

export type ObjectPlacementSkipReason =
  | "unknown_slug"
  | "world_asset"
  | "no_model"
  | "no_bounds"
  | "surface_target_missing"
  | "surface_target_no_model"
  | "surface_target_no_bounds"
  | "no_surface";

export interface SurfaceHit {
  targetSlug: string;
  /** 落点：世界坐标，x/z 是采样点，y 是表面高度加上 `offset` 的抬高量。 */
  point: Vec3;
  /** 目标网格在该点实际给出的上表面高度（未加 `offset`）。 */
  surfaceY: number;
}

export interface PlacedObjectReport {
  slug: string;
  name: string;
  /** 写进 scene.json 的模型原点位姿。 */
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** 要求落到的位置（包围盒底面中心），便于调用方核对"到底贴上了没有"。 */
  bottomCenter: Vec3;
  /** 摆放之后的世界包围盒。 */
  bounds: ModelBounds;
  surface?: SurfaceHit;
}

export interface ObjectPlacementReport {
  placed: PlacedObjectReport[];
  skipped: { slug: string; name: string; reason: ObjectPlacementSkipReason }[];
  scenePath: string;
}

const IDENTITY_ROTATION: Vec3 = [0, 0, 0];

export async function placeObjects(
  storage: AssetStorage,
  projectSlug: string,
  items: readonly ObjectPlacementItem[],
): Promise<ObjectPlacementReport> {
  if (items.length === 0) {
    throw new ChatServiceError("At least one object to place must be specified", 400, "no_placement_items");
  }
  for (const item of items) assertPlaceableItem(item);

  const state = await getProjectState(storage, projectSlug);
  const placeable: PlaceableAsset[] = state.assets
    .filter(
      (asset) =>
        asset.identity?.kind !== "world" && latestModelFile(asset.files) !== null,
    )
    .map((asset) => ({
      id: assetStableId(asset.identity, asset.slug),
      slug: asset.slug,
      ...(asset.identity?.createdAt ? { createdAt: asset.identity.createdAt } : {}),
    }));

  const placed: PlacedObjectReport[] = [];
  const skipped: ObjectPlacementReport["skipped"] = [];
  /**
   * 本次调用已经算出来的摆放。先摆沙发、再把小熊放上去这种一次调用里的两步依赖，
   * 靠它生效——每次都把它叠在做为基准的摆放上重算当前布局。
   */
  const pending: Record<string, AssetTransform> = {};

  for (const item of items) {
    const asset = state.assets.find((candidate) => candidate.slug === item.slug);
    const name = asset?.identity?.name ?? item.slug;
    const skip = (reason: ObjectPlacementSkipReason) =>
      skipped.push({ slug: item.slug, name, reason });

    if (!asset) {
      skip("unknown_slug");
      continue;
    }
    // world 是场景背景，不参与摆放（app 的 computeSceneLayout 也把它排除在外）：
    // 给它写一条记录只会是"成功但永不被应用"的静默空操作，不如明确跳过。
    if (asset.identity?.kind === "world") {
      skip("world_asset");
      continue;
    }
    const modelFile = latestModelFile(asset.files);
    if (!modelFile) {
      skip("no_model");
      continue;
    }
    const localBounds = await readGlbBounds(
      storage,
      `${assetDir(projectSlug, asset.slug)}/${modelFile}`,
    );
    if (!localBounds) {
      skip("no_bounds");
      continue;
    }

    const rotation = resolveRotation(item);
    const scale = resolveScale(item, localBounds);

    let bottomCenter: Vec3;
    let surface: SurfaceHit | undefined;
    if (item.onSurfaceOf) {
      const resolved = await resolveSurface(
        storage,
        projectSlug,
        state,
        placeable,
        { ...state.scene?.transforms, ...pending },
        item.onSurfaceOf,
      );
      if (!resolved.ok) {
        skip(resolved.reason);
        continue;
      }
      surface = resolved.hit;
      bottomCenter = resolved.hit.point;
    } else {
      // `assertPlaceableItem` 已经保证"两者必有其一"；这里只是类型收窄。
      bottomCenter = item.position!;
    }

    const transform = composePlacement(localBounds, bottomCenter, rotation, scale);
    pending[assetStableId(asset.identity, asset.slug)] = transform;
    placed.push({
      slug: item.slug,
      name,
      position: transform.position,
      rotation: transform.rotation,
      scale: transform.scale,
      bottomCenter,
      bounds: transformBounds(localBounds.min, localBounds.max, transform),
      ...(surface ? { surface } : {}),
    });
  }

  if (placed.length > 0) {
    await writeSceneTransforms(storage, projectSlug, pending);
  }

  return { placed, skipped, scenePath: projectSceneFile(projectSlug) };
}

/**
 * 把"包围盒底面中心落在 `bottomCenter`"翻译成模型原点的摆放。
 *
 * 摆放是绕**模型原点**的 T·R·S，而生成器把原点放在几何中心（远近都不在底面上）：
 * 直接写 `position = bottomCenter` 会整体沉下去半个模型，带旋转时还会横向偏。
 * 所以先算出局部底心绕原点转+缩放后的偏移，再反向扣掉——用的是与量包围盒、
 * 与世界空间采样完全相同的那份 `placementMatrix`。
 */
function composePlacement(
  localBounds: ModelBounds,
  bottomCenter: Vec3,
  rotation: Vec3,
  scale: number,
): AssetTransform {
  const localBottomCenter: Vec3 = [
    (localBounds.min[0] + localBounds.max[0]) / 2,
    localBounds.min[1],
    (localBounds.min[2] + localBounds.max[2]) / 2,
  ];
  const offset = new Vector3(...localBottomCenter).applyMatrix4(
    placementMatrix({ position: [0, 0, 0], rotation, scale: [scale, scale, scale] }),
  );
  return {
    position: [
      bottomCenter[0] - offset.x,
      bottomCenter[1] - offset.y,
      bottomCenter[2] - offset.z,
    ],
    rotation,
    scale: [scale, scale, scale],
  };
}

/** 目标资产上表面的世界高度；失败时返回跳过原因。 */
async function resolveSurface(
  storage: AssetStorage,
  projectSlug: string,
  state: ProjectState,
  placeable: readonly PlaceableAsset[],
  transforms: Record<string, AssetTransform>,
  target: SurfaceTarget,
): Promise<{ ok: true; hit: SurfaceHit } | { ok: false; reason: ObjectPlacementSkipReason }> {
  const asset = state.assets.find((candidate) => candidate.slug === target.slug);
  if (!asset) return { ok: false, reason: "surface_target_missing" };
  const modelFile = latestModelFile(asset.files);
  if (!modelFile) return { ok: false, reason: "surface_target_no_model" };

  const modelPath = `${assetDir(projectSlug, asset.slug)}/${modelFile}`;
  // 目标"现在在哪"必须与视口一致：手动记录优先，否则网格默认位。
  const transform = computeSceneLayout(placeable, transforms).get(
    assetStableId(asset.identity, asset.slug),
  );
  if (!transform) return { ok: false, reason: "surface_target_missing" };

  const bounds = await readGlbBounds(storage, modelPath, transform);
  if (!bounds) return { ok: false, reason: "surface_target_no_bounds" };

  const offset = target.offset ?? [0, 0, 0];
  const x = (bounds.min[0] + bounds.max[0]) / 2 + offset[0];
  const z = (bounds.min[2] + bounds.max[2]) / 2 + offset[2];
  const mesh = await loadModelSurfaceMesh(storage, modelPath, transform);
  const surfaceY = mesh ? sampleHighestSurface(mesh, x, z) : null;
  if (surfaceY === null || !Number.isFinite(surfaceY)) {
    return { ok: false, reason: "no_surface" };
  }

  return {
    ok: true,
    hit: {
      targetSlug: target.slug,
      point: [x, surfaceY + offset[1], z],
      surfaceY,
    },
  };
}

function resolveRotation(item: ObjectPlacementItem): Vec3 {
  if (item.rotation) return item.rotation;
  if (item.yawDegrees !== undefined) {
    return [0, (item.yawDegrees * Math.PI) / 180, 0];
  }
  return IDENTITY_ROTATION;
}

function resolveScale(item: ObjectPlacementItem, bounds: ModelBounds): number {
  if (item.heightMeters !== undefined) {
    return placementScale({ heightMeters: item.heightMeters, bounds });
  }
  return item.scale ?? 1;
}

/**
 * 互斥参数一律**明确报错**，不做"谁优先"的静默取舍：同时传 `position` 和
 * `onSurfaceOf` 时，任何一个被悄悄忽略都会得到一个看起来成功、其实不是用户要的摆放。
 */
function assertPlaceableItem(item: ObjectPlacementItem): void {
  const fail = (message: string) => {
    throw new ChatServiceError(
      `Invalid placement parameters for object "${item.slug}": ${message}`,
      400,
      "invalid_placement_item",
    );
  };
  if (item.position && item.onSurfaceOf) fail("position and onSurfaceOf are mutually exclusive");
  if (!item.position && !item.onSurfaceOf) fail("either position or onSurfaceOf is required");
  if (item.heightMeters !== undefined && item.scale !== undefined) {
    fail("heightMeters and scale are mutually exclusive");
  }
  if (item.rotation && item.yawDegrees !== undefined) fail("rotation and yawDegrees are mutually exclusive");
  if (item.heightMeters !== undefined && !(item.heightMeters > 0)) fail("heightMeters must be positive");
  if (item.scale !== undefined && !(item.scale > 0)) fail("scale must be positive");
  for (const [label, value] of [
    ["position", item.position],
    ["rotation", item.rotation],
    ["offset", item.onSurfaceOf?.offset],
  ] as const) {
    if (value && !value.every((component) => Number.isFinite(component))) {
      fail(`${label} must be three finite numbers`);
    }
  }
}
