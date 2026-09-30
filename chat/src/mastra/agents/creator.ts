import { Agent } from "@mastra/core/agent";
import { config } from "../../config";
import type { LlmConfig } from "../../dto/chat";
import { CREATOR_INSTRUCTIONS } from "../prompts/creator";
import {
  analyzeSceneTool,
  analyzeReferenceTool,
  askUserTool,
  generateCleanPlateTool,
  generateCharacterTool,
  generateReferenceImagesTool,
  generateSkyboxTool,
  generateTextureTool,
  identifyAssetTool,
  inspectTool,
  listGenerationTasksTool,
  getSceneJobTool,
  placeSceneObjectsTool,
  repairAssetsTool,
  retopologizeTool,
  rigModelTool,
  resumeGenerationTool,
  retrySceneJobNodesTool,
  reviseSceneJobTool,
  segmentPartsTool,
  start3dBatchTool,
  startSceneJobTool,
  startWorldTaskTool,
  updatePlanTool,
} from "../tools";

/**
 * 本机服务注入凭证和固定 LLM 端点；Agent 工具只注册已支持的渠道。
 */
export function createCreatorAgent(
  llm: LlmConfig,
  options: { enableAnalyzeReference?: boolean } = {},
) {
  return new Agent({
    id: "chatspace-creator",
    name: "ChatSpace 3D Creator",
    description: "ChatSpace 的 3D 创作 agent：火山方舟 3D 模型、Tripo3D 与 World Labs 场景",
    instructions: CREATOR_INSTRUCTIONS,
    tools: {
      "ask-user": askUserTool,
      "update-plan": updatePlanTool,
      "generate-reference-images": generateReferenceImagesTool,
      "generate-clean-plate": generateCleanPlateTool,
      "generate-skybox": generateSkyboxTool,
      "generate-texture": generateTextureTool,
      "analyze-scene": analyzeSceneTool,
      "place-scene-objects": placeSceneObjectsTool,
      ...(options.enableAnalyzeReference
        ? { "analyze-reference": analyzeReferenceTool }
        : {}),
      "start-3d-batch": start3dBatchTool,
      "start-world-task": startWorldTaskTool,
      "start-scene-job": startSceneJobTool,
      "revise-scene-job": reviseSceneJobTool,
      "retry-scene-job-nodes": retrySceneJobNodesTool,
      "get-scene-job": getSceneJobTool,
      "segment-parts": segmentPartsTool,
      "retopologize": retopologizeTool,
      "rig-model": rigModelTool,
      "generate-character": generateCharacterTool,
      "identify-asset": identifyAssetTool,
      "inspect": inspectTool,
      "list-generation-tasks": listGenerationTasksTool,
      "resume-generation": resumeGenerationTool,
      "repair-assets": repairAssetsTool,
    },
    model: {
      providerId: "byok-openai-compatible",
      modelId: llm.model ?? config.llm.defaultModel,
      url: llm.baseUrl ?? config.llm.defaultBaseUrl,
      apiKey: llm.apiKey,
    },
  });
}
