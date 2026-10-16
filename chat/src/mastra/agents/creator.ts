import { Agent } from "@mastra/core/agent";
import { config } from "../../config";
import type { LlmConfig } from "../../dto/chat";
import { CREATOR_INSTRUCTIONS } from "../prompts/creator";
import { BLENDER_SERVICE_TOOLS, CLOUD_BLENDER_INSTRUCTIONS } from "../tools/blenderService";
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
  unwrapUvTool,
  updatePlanTool,
} from "../tools";

/**
 * 本机服务注入凭证和固定 LLM 端点；Agent 工具只注册已支持的渠道。
 *
 * **工具表不得随"本条用户消息"变化**——这是 2026-10-15 事故的类级修复，别再退回去。
 *
 * 以前 `analyze-reference` 是按"本条消息恰好带一张图 + 关键词命中意图正则"裁剪的，
 * 而系统提示词无条件叫模型调它。用户说「将这个场景生成出来」这类措辞不命中正则时：
 * 工具表里没有它 → 模型硬调 → 浏览器本地版抛 `Unknown tool: analyze-reference`；
 * 模型退而调常驻的 `start-scene-job` → 没有待确认分析 → 404，而那句 404 还叫它
 * "call analyze-reference again"，也就是叫它去调一个刚刚不存在的工具。用户看到两条
 * Failed，每次都一样，因为重试不会改变按措辞算出来的工具表。
 *
 * 现在这条纪律是不变量：**能不能看到某个工具只由进程配置决定**（blender 开关这类），
 * 不由这句话的措辞决定。"该不该调"的判断要么写在提示词/工具描述里（模型看得见），
 * 要么留在工具内部，而且必须以"下一步该做什么"的形式报出来，不能是隐藏前置条件。
 * 回归测试：本文件同目录的 creator.test.ts「提示词点名的工具必须在工具表里」。
 */
export function createCreatorAgent(llm: LlmConfig) {
  return new Agent({
    id: "chatspace-creator",
    name: "ChatSpace 3D Creator",
    description: "ChatSpace's 3D creation agent: Tripo3D models and World Labs scenes",
    instructions: CREATOR_INSTRUCTIONS + (config.blender.cloudService ? "\n\n" + CLOUD_BLENDER_INSTRUCTIONS : ""),
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
      "analyze-reference": analyzeReferenceTool,
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
      /*
        unwrap-uv 以前只写在提示词里、没挂进来，正是"提示词点名但工具表里没有"的另一个
        实例（用户说"给小熊展个 UV"，模型只会拿到 `Unknown tool: unwrap-uv`）。
        UV 展开是本产品明确保留的 Hunyuan 能力（提示词第 2 条也点名了 HUNYUAN_KEY），
        工具自己在缺 key 时会给出一句可执行的报错，所以它就该常驻。
        回归：creator.test.ts「提示词点名的工具必须在工具表里」。
      */
      "unwrap-uv": unwrapUvTool,
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
