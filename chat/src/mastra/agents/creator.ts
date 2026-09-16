import { Agent } from "@mastra/core/agent";
import { config } from "../../config";
import type { LlmConfig } from "../../dto/chat";
import { CREATOR_INSTRUCTIONS } from "../prompts/creator";
import {
  analyzeSceneTool,
  analyzeReferenceTool,
  buildCadModelTool,
  confirmReferenceAssetsTool,
  getCadSourceTool,
  generateReferenceImagesTool,
  identifyAssetTool,
  inspectAssetTool,
  listGenerationTasksTool,
  repairAssetsTool,
  resumeGenerationTool,
  segmentPartsTool,
  start3dBatchTool,
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
    id: "gabo-creator",
    name: "Gabo 3D Creator",
    description: "Gabo 的 3D 创作 agent：本地 CAD、火山方舟 3D 模型、Tripo3D 与 World Labs 场景",
    instructions: CREATOR_INSTRUCTIONS,
    tools: {
      "update-plan": updatePlanTool,
      "generate-reference-images": generateReferenceImagesTool,
      "analyze-scene": analyzeSceneTool,
      ...(options.enableAnalyzeReference
        ? { "analyze-reference": analyzeReferenceTool }
        : {}),
      "confirm-reference-assets": confirmReferenceAssetsTool,
      "start-3d-batch": start3dBatchTool,
      "start-world-task": startWorldTaskTool,
      "segment-parts": segmentPartsTool,
      "build-cad-model": buildCadModelTool,
      "get-cad-source": getCadSourceTool,
      "identify-asset": identifyAssetTool,
      "inspect-asset": inspectAssetTool,
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
