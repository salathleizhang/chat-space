import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { createTool } from "@mastra/core/tools";
import {
  Box3,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { parseIndexedName } from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import type { LlmConfig } from "../../dto/chat";
import type { AssetTransform, Vec3 } from "../../dto/library";
import {
  getAssetStorage,
  readAsDataUri,
  type AssetStorage,
} from "../../services/assetStorage";
import {
  getCurrentSceneAnalyzer,
  type CurrentSceneSnapshot,
  type SceneBounds,
} from "../../services/sceneAnalysis";
import {
  getProjectState,
  thumbnailFileName,
  type AssetState,
} from "./projectTools";
import {
  optionalContextLlm,
  requireCurrentProject,
} from "./requestContext";

const MODEL_EXT_RE = /^(glb|gltf|obj|fbx|stl)$/i;
const GRID_CELL_SIZE = 3;
const GRID_MAX_COLUMNS = 3;
const ZERO: Vec3 = [0, 0, 0];
const ONE: Vec3 = [1, 1, 1];

interface SceneModelAsset {
  asset: AssetState;
  modelFile: string;
}

function latestModelFile(files: string[]): string | null {
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

function defaultPosition(index: number, total: number): Vec3 {
  const columns = Math.min(GRID_MAX_COLUMNS, Math.max(1, total));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [
    (column - (columns - 1) / 2) * GRID_CELL_SIZE,
    0,
    row === 0 ? 0 : row * -GRID_CELL_SIZE,
  ];
}

function effectiveTransform(
  saved: AssetTransform | undefined,
  index: number,
  total: number,
): AssetTransform {
  return (
    saved ?? {
      position: defaultPosition(index, total),
      rotation: ZERO,
      scale: ONE,
    }
  );
}

function finiteVec3(value: readonly number[]): value is Vec3 {
  return value.length === 3 && value.every(Number.isFinite);
}

function transformBounds(
  min: Vec3,
  max: Vec3,
  transform: AssetTransform,
): SceneBounds {
  const matrix = new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
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

async function measureGlbBounds(
  storage: AssetStorage,
  modelPath: string,
  transform: AssetTransform,
): Promise<SceneBounds | undefined> {
  if (!modelPath.toLowerCase().endsWith(".glb")) return undefined;
  try {
    const document = await new NodeIO().readBinary(await storage.readBytes(modelPath));
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
    return min && max ? transformBounds(min, max, transform) : undefined;
  } catch {
    return undefined;
  }
}

async function buildCurrentSceneSnapshot(
  storage: AssetStorage,
  projectSlug: string,
): Promise<CurrentSceneSnapshot> {
  const state = await getProjectState(storage, projectSlug);
  const models: SceneModelAsset[] = state.assets
    .map((asset) => ({ asset, modelFile: latestModelFile(asset.files) }))
    .filter(
      (entry): entry is SceneModelAsset =>
        Boolean(entry.modelFile) && entry.asset.identity?.kind !== "world",
    )
    .sort((a, b) => {
      const ac = a.asset.identity?.createdAt ?? "";
      const bc = b.asset.identity?.createdAt ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.asset.slug.localeCompare(b.asset.slug);
    });

  if (models.length === 0) {
    throw new ChatServiceError(
      "当前 3D 场景里没有可分析的模型资产",
      409,
      "scene_empty",
    );
  }

  const assets = await Promise.all(
    models.map(async ({ asset, modelFile }, index) => {
      const dir = assetDir(projectSlug, asset.slug);
      const modelPath = `${dir}/${modelFile}`;
      const transform = effectiveTransform(
        state.scene?.transforms[asset.slug],
        index,
        models.length,
      );
      const thumbFile = thumbnailFileName(modelFile);
      const thumbPath = `${dir}/${thumbFile}`;
      return {
        label: `A${index + 1}`,
        slug: asset.slug,
        name: asset.identity?.name ?? asset.slug,
        kind: asset.identity?.kind ?? "other",
        transform,
        bounds: await measureGlbBounds(storage, modelPath, transform),
        thumbnailDataUri: asset.files.includes(thumbFile)
          ? await readAsDataUri(storage, thumbPath)
          : undefined,
      };
    }),
  );

  return {
    projectName: state.project.name,
    coordinateSystem: "three.js right-handed Y-up",
    environment: {
      skybox: state.project.currentSkybox ?? "default",
      world: state.project.currentWorld ?? null,
    },
    assets,
  };
}

export async function runAnalyzeCurrentScene(
  projectSlug: string,
  input: { instructions?: string },
  llm: LlmConfig,
) {
  const snapshot = await buildCurrentSceneSnapshot(getAssetStorage(), projectSlug);
  const result = await getCurrentSceneAnalyzer()({
    snapshot,
    instructions: input.instructions,
    llm,
  });
  return {
    ...result,
    assetCount: snapshot.assets.length,
    thumbnailsProvided: snapshot.assets.filter((asset) => asset.thumbnailDataUri).length,
    boundsProvided: snapshot.assets.filter((asset) => asset.bounds).length,
  };
}

export const analyzeSceneTool = createTool({
  id: "analyze-scene",
  description:
    "分析当前 3D 工作台场景（免费）：读取已有模型资产的缩略图、实际有效坐标、旋转、缩放、可测量包围盒以及当前天空盒/World，回答场景里有什么、空间关系、布局问题和改进建议。它不读取用户上传的照片；图片内容由你直接看，只有当前 3D 场景问题才调用本工具。",
  inputSchema: z.object({
    instructions: z.string().optional(),
  }),
  execute: async (input, context) => {
    const llm = optionalContextLlm(context);
    if (!llm) {
      throw new ChatServiceError(
        "缺少 LLM API key（当前场景分析需要多模态 LLM）",
        401,
        "missing_llm_key",
      );
    }
    return runAnalyzeCurrentScene(requireCurrentProject(context), input, llm);
  },
});
