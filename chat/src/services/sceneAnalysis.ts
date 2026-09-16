import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { config } from "../config";
import type { LlmConfig } from "../dto/chat";
import type { AssetTransform, Vec3 } from "../dto/library";
import { CURRENT_SCENE_ANALYSIS_INSTRUCTIONS } from "../mastra/prompts/sceneAnalysis";

export interface SceneBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export interface SceneAnalysisAsset {
  label: string;
  slug: string;
  name: string;
  kind: string;
  transform: AssetTransform;
  bounds?: SceneBounds;
  thumbnailDataUri?: string;
}

export interface CurrentSceneSnapshot {
  projectName: string;
  coordinateSystem: "three.js right-handed Y-up";
  environment: {
    skybox: string;
    world: string | null;
  };
  assets: SceneAnalysisAsset[];
}

export const CurrentSceneAnalysisResultSchema = z.object({
  overview: z.string().min(1),
  assets: z.array(
    z.object({
      slug: z.string().min(1),
      visualSummary: z.string().min(1),
      spatialRole: z.string().min(1),
    }),
  ),
  relationships: z.array(z.string()),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type CurrentSceneAnalysisResult = z.infer<
  typeof CurrentSceneAnalysisResultSchema
>;

export interface AnalyzeCurrentSceneArgs {
  snapshot: CurrentSceneSnapshot;
  instructions?: string;
  llm: LlmConfig;
}

export type CurrentSceneAnalyzer = (
  args: AnalyzeCurrentSceneArgs,
) => Promise<CurrentSceneAnalysisResult>;

const llmSceneAnalyzer: CurrentSceneAnalyzer = async ({
  snapshot,
  instructions,
  llm,
}) => {
  const agent = new Agent({
    id: "gabo-current-scene-analyst",
    name: "Gabo Current Scene Analyst",
    instructions: CURRENT_SCENE_ANALYSIS_INSTRUCTIONS,
    model: {
      providerId: "byok-openai-compatible",
      modelId: llm.model ?? config.llm.defaultModel,
      url: llm.baseUrl ?? config.llm.defaultBaseUrl,
      apiKey: llm.apiKey,
    },
  });

  const serializable = {
    ...snapshot,
    assets: snapshot.assets.map(({ thumbnailDataUri: _thumbnail, ...asset }) => asset),
  };
  const content: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [
    {
      type: "text",
      text:
        `分析当前 3D 场景。\n空间数据：${JSON.stringify(serializable)}\n` +
        `用户补充要求：${instructions ?? "无"}`,
    },
  ];
  for (const asset of snapshot.assets) {
    if (!asset.thumbnailDataUri) continue;
    content.push({
      type: "text",
      text: `${asset.label} 缩略图，对应资产 ${asset.name}（${asset.slug}）`,
    });
    content.push({ type: "image", image: asset.thumbnailDataUri });
  }

  const result = await agent.generate(
    [{ role: "user" as const, content }],
    { structuredOutput: { schema: CurrentSceneAnalysisResultSchema } },
  );
  return CurrentSceneAnalysisResultSchema.parse(result.object);
};

let analyzer: CurrentSceneAnalyzer = llmSceneAnalyzer;

export function getCurrentSceneAnalyzer(): CurrentSceneAnalyzer {
  return analyzer;
}

/** 测试注入；传 undefined 恢复真实多模态 LLM 分析器。 */
export function setCurrentSceneAnalyzer(
  next: CurrentSceneAnalyzer | undefined,
): void {
  analyzer = next ?? llmSceneAnalyzer;
}
