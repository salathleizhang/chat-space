import { ChatServiceError } from "../common/errors";
import { assetDir, projectSceneFile } from "../common/libraryPaths";
import type { AssetTransform, CameraEstimate, ObjectBox, Vec3 } from "../dto/library";
import { assetStableId } from "../dto/library";
import { getProjectState, writeSceneTransforms } from "../mastra/tools/projectTools";
import { buildGroundSampler, loadWorldGroundMesh } from "./groundSampler";
import { imageAspect, readImageSize } from "./imageSize";
import { latestModelFile, readGlbBounds, type ModelBounds } from "./modelBounds";
import type { AssetStorage } from "./assetStorage";
import { readSceneSpec } from "./sceneJobs";
import {
  computePlacement,
  resolvePlacementCamera,
  type PlacementCamera,
} from "./scenePlacement";

/**
 * 摆放编排：把 SceneSpec 里的对象按参考图摆到 3D 世界，写进 `scene.json` 的
 * `transforms`（按资产**稳定 id** 索引，与 gizmo 手动摆放同一张表、同一条通路）。
 *
 * 免费、确定性、不调用任何供应商：输入是分析阶段已经落盘的框与相机估计，
 * 加上（可选）调用方显式传来的覆盖值。SceneJob 的 placement 节点与
 * `place-scene-objects` 工具共用这一个实现。
 *
 * 覆盖语义是**只写我们算出来的那些对象**：没框、没模型的对象保持原有记录
 * （也就保持 app 的网格默认位），其余无关资产一概不动。
 */

export interface ScenePlacementItemOverride {
  slug: string;
  /** 覆盖规格里的框；旧分析没有框时用它补。 */
  box?: ObjectBox;
  heightMeters?: number;
}

export interface ScenePlacementOptions {
  items?: ScenePlacementItemOverride[];
  camera?: CameraEstimate;
}

export interface PlacedObject {
  slug: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  depth: number;
  grounded: boolean;
  clamped: boolean;
}

export type SkippedReason = "no_box" | "no_model" | "unknown_slug";

export interface ScenePlacementReport {
  placed: PlacedObject[];
  skipped: { slug: string; name: string; reason: SkippedReason }[];
  camera: PlacementCamera;
  aspect: number;
  /** `collider` = 用了世界真实地形；`flat` = 退回 y=0 平面。 */
  ground: "collider" | "flat";
  scenePath: string;
}

export async function runScenePlacement(
  storage: AssetStorage,
  projectSlug: string,
  options: ScenePlacementOptions = {},
): Promise<ScenePlacementReport> {
  const spec = await readSceneSpec(storage, projectSlug);
  if (!spec) {
    throw new ChatServiceError(
      "当前项目还没有已确认的完整场景，无法按参考图摆放",
      409,
      "scene_spec_missing",
    );
  }
  const state = await getProjectState(storage, projectSlug);
  const overrides = new Map((options.items ?? []).map((item) => [item.slug, item]));
  const camera = resolvePlacementCamera(options.camera ?? spec.camera);
  const aspect = imageAspect(await readSourceImageSize(storage, spec.sourceImage));

  const world = state.assets.find((asset) => asset.slug === state.project.currentWorld);
  const worldModelFile = world ? latestModelFile(world.files) : null;
  const groundMesh =
    world && world.worldSemantics && worldModelFile
      ? await loadWorldGroundMesh(
          storage,
          `${assetDir(projectSlug, world.slug)}/${worldModelFile}`,
          world.worldSemantics,
        )
      : null;
  const sampleGround = buildGroundSampler(groundMesh);

  const placed: PlacedObject[] = [];
  const skipped: ScenePlacementReport["skipped"] = [];
  const transforms: Record<string, AssetTransform> = {};

  for (const object of spec.objects) {
    const override = overrides.get(object.slug);
    const box = override?.box ?? object.box;
    if (!box) {
      skipped.push({ slug: object.slug, name: object.name, reason: "no_box" });
      continue;
    }
    const asset = state.assets.find((candidate) => candidate.slug === object.slug);
    const modelFile = asset ? latestModelFile(asset.files) : null;
    if (!asset || !modelFile) {
      skipped.push({ slug: object.slug, name: object.name, reason: "no_model" });
      continue;
    }
    const bounds: ModelBounds | undefined = await readGlbBounds(
      storage,
      `${assetDir(projectSlug, asset.slug)}/${modelFile}`,
    );
    const placement = computePlacement(
      {
        box,
        ...(override?.heightMeters ?? object.heightMeters
          ? { heightMeters: override?.heightMeters ?? object.heightMeters }
          : {}),
        ...(bounds ? { bounds } : {}),
      },
      { camera, aspect, sampleGround },
    );
    transforms[assetStableId(asset.identity, asset.slug)] = {
      position: placement.position,
      rotation: placement.rotation,
      scale: placement.scale,
    };
    placed.push({
      slug: object.slug,
      name: object.name,
      position: placement.position,
      rotation: placement.rotation,
      scale: placement.scale,
      depth: placement.depth,
      grounded: placement.grounded,
      clamped: placement.clamped,
    });
  }

  const unknown = [...overrides.keys()].filter(
    (slug) => !spec.objects.some((object) => object.slug === slug),
  );
  for (const slug of unknown) {
    skipped.push({ slug, name: slug, reason: "unknown_slug" });
  }

  if (placed.length > 0) {
    await writeSceneTransforms(storage, projectSlug, transforms);
  }

  return {
    placed,
    skipped,
    camera,
    aspect,
    ground: sampledFromCollider(groundMesh) ? "collider" : "flat",
    scenePath: projectSceneFile(projectSlug),
  };
}

function sampledFromCollider(mesh: { triangleCount: number } | null): boolean {
  return mesh !== null && mesh.triangleCount > 0;
}

/** 源图尺寸读不出来时返回 null，`imageAspect` 会退化成 4:3。 */
async function readSourceImageSize(storage: AssetStorage, path: string) {
  try {
    return (await storage.exists(path)) ? readImageSize(await storage.readBytes(path)) : null;
  } catch {
    return null;
  }
}
