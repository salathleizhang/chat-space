import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { assetDir } from "../../common/libraryPaths";
import type { LlmConfig } from "../../dto/chat";
import type { AssetTransform, Vec3 } from "../../dto/library";
import {
  getAssetStorage,
  readAsDataUri,
  type AssetStorage,
} from "../../services/assetStorage";
import { latestModelFile, readGlbBounds } from "../../services/modelBounds";
import {
  getCurrentSceneAnalyzer,
  type CurrentSceneSnapshot,
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

const GRID_CELL_SIZE = 3;
const GRID_MAX_COLUMNS = 3;
const ZERO: Vec3 = [0, 0, 0];
const ONE: Vec3 = [1, 1, 1];

interface SceneModelAsset {
  asset: AssetState;
  modelFile: string;
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
        bounds: await readGlbBounds(storage, modelPath, transform),
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
