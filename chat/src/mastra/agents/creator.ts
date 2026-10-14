import { Agent } from "@mastra/core/agent";
import { config } from "../../config";
import type { LlmConfig } from "../../dto/chat";
import { CREATOR_INSTRUCTIONS } from "../prompts/creator";
import { BLENDER_SERVICE_TOOLS } from "../tools/blenderService";
import {
  analyzeSceneTool,
  analyzeReferenceTool,
  askUserTool,
  attachSourceImageTool,
  BLENDER_TOOLS,
  generateAnimationTool,
  generateCleanPlateTool,
  generateCharacterTool,
  generateReferenceImagesTool,
  generateSkyboxTool,
  generateTextureTool,
  identifyAssetTool,
  inspectTool,
  listGenerationTasksTool,
  getSceneJobTool,
  placeObjectTool,
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
    description: "ChatSpace's 3D creation agent: Volcano Engine 3D models, Tripo3D and World Labs scenes",
    instructions: CREATOR_INSTRUCTIONS,
    tools: {
      "ask-user": askUserTool,
      "update-plan": updatePlanTool,
      "generate-reference-images": generateReferenceImagesTool,
      "attach-source-image": attachSourceImageTool,
      "generate-clean-plate": generateCleanPlateTool,
      "generate-skybox": generateSkyboxTool,
      "generate-texture": generateTextureTool,
      "analyze-scene": analyzeSceneTool,
      "place-scene-objects": placeSceneObjectsTool,
      "place-object": placeObjectTool,
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
      "generate-animation": generateAnimationTool,
      "generate-character": generateCharacterTool,
      "identify-asset": identifyAssetTool,
      "inspect": inspectTool,
      "list-generation-tasks": listGenerationTasksTool,
      "resume-generation": resumeGenerationTool,
      "repair-assets": repairAssetsTool,
      /*
        Blender 工具**默认不注册**（`BLENDER_ENABLED=1` 才开）。

        理由不是"省 token"，而是**工具表本身就是给模型的信号**：注册了 8 个 blender-*
        之后，模型会倾向于把它们当成一条可选的建模路线，然后去调一个没有 Blender 会话
        必然失败的会话检查。没配 Blender 时这些工具根本不该存在。

        注意这 8 个是我们自己的工具，不是社区版那 36 个 MCP 工具的转发——社区版实测
        30 个工具带一个喂遥测的 `user_prompt` 参数，直接挂上去会污染模型的选择。
        白名单与理由见 `tools/blenderOps.ts` 与 `models/blenderMcp.ts` 的模块文档。
      */
      ...(config.blender.enabled ? BLENDER_TOOLS : {}),
      ...(config.blender.cloudService ? BLENDER_SERVICE_TOOLS : {}),
    },
    model: {
      providerId: "byok-openai-compatible",
      modelId: llm.model ?? config.llm.defaultModel,
      url: llm.baseUrl ?? config.llm.defaultBaseUrl,
      apiKey: llm.apiKey,
    },
  });
}
