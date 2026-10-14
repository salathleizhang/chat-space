import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { assetDir } from "../../common/libraryPaths";
import type { LlmConfig } from "../../dto/chat";
import { assetStableId } from "../../dto/library";
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
import { comparePlaceable, computeSceneLayout } from "../../services/sceneLayout";
import {
  getProjectState,
  thumbnailFileName,
  type AssetState,
} from "./projectTools";
import {
  optionalContextLlm,
  requireCurrentProject,
} from "./requestContext";

interface SceneModelAsset {
  asset: AssetState;
  modelFile: string;
  /** 资产稳定 id——scene.json 的表就是按它索引的。 */
  id: string;
  slug: string;
  createdAt?: string;
}

async function buildCurrentSceneSnapshot(
  storage: AssetStorage,
  projectSlug: string,
): Promise<CurrentSceneSnapshot> {
  const state = await getProjectState(storage, projectSlug);
  const models: SceneModelAsset[] = state.assets
    .map((asset) => ({
      asset,
      modelFile: latestModelFile(asset.files),
      id: assetStableId(asset.identity, asset.slug),
      slug: asset.slug,
      ...(asset.identity?.createdAt ? { createdAt: asset.identity.createdAt } : {}),
    }))
    .filter(
      (entry): entry is SceneModelAsset =>
        Boolean(entry.modelFile) && entry.asset.identity?.kind !== "world",
    )
    .sort(comparePlaceable);

  if (models.length === 0) {
    throw new ChatServiceError(
      "The current 3D scene has no model assets to analyze",
      409,
      "scene_empty",
    );
  }

  /*
    摆放必须按**资产稳定 id**查（scene.json 从 v3 起就是这么索引的），不能用 slug：
    用 slug 查表时手动摆过的资产永远命中不到，于是这里会把网格默认位当成当前坐标
    报给模型——"把玩偶放到沙发上"这类请求就建立在一份错的位置上。
    默认位与视口共用 `computeSceneLayout`，两边给出同一组坐标。
  */
  const layout = computeSceneLayout(models, state.scene?.transforms ?? {});

  const assets = await Promise.all(
    models.map(async ({ asset, modelFile, id }, index) => {
      const dir = assetDir(projectSlug, asset.slug);
      const modelPath = `${dir}/${modelFile}`;
      const transform = layout.get(id)!;
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
    "Analyze the current 3D workbench scene (free): reads the thumbnails, actual effective coordinates, rotation, scale, measurable bounding boxes of the existing model assets plus the current skybox/world, and answers what is in the scene, the spatial relationships, layout problems, and improvement suggestions. It does not read photos uploaded by the user; you look at image content directly — call this tool only for questions about the current 3D scene.",
  inputSchema: z.object({
    instructions: z.string().optional(),
  }),
  execute: async (input, context) => {
    const llm = optionalContextLlm(context);
    if (!llm) {
      throw new ChatServiceError(
        "Missing LLM API key (current-scene analysis requires a multimodal LLM)",
        401,
        "missing_llm_key",
      );
    }
    return runAnalyzeCurrentScene(requireCurrentProject(context), input, llm);
  },
});
