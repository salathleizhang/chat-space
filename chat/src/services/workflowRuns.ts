import { RequestContext } from "@mastra/core/di";
import type { ChatStreamRequest, LlmConfig } from "../dto/chat";

/** 对话请求的临时配置只进入 Mastra RequestContext，不进入工具参数或资产侧写。 */

export interface RunKeys {
  projectSlug?: string;
  llm?: LlmConfig;
  /** 最新一条用户消息实际附带的图片路径；供参考图工具做硬边界校验。 */
  currentImagePaths?: string[];
  /** 最新用户文本明确要求把附图提取/生成成 3D 资产。 */
  referenceAnalysisAllowed?: boolean;
  /** AgentDock 当前图片生成模型；天空盒编辑等工具直接消费，不暴露为工具参数。 */
  imageGenerateModel?: ChatStreamRequest["imageGenerateModel"];
  /** AgentDock 当前 3D 模型选择；start-3d-batch 直接消费，不暴露为工具参数。 */
  threeDModel?: ChatStreamRequest["threeDModel"];
  /**
   * 当前会话开始的时刻（epoch ms）；参考图能否自动复用按它判断
   * （见 mastra/tools/referenceResolution.ts）。缺省 = 不做本轮判断。
   */
  sessionStartedAt?: ChatStreamRequest["sessionStartedAt"];
  worldLabsApiKey?: string;
  tripo3dApiKey?: string;
  hunyuanApiKey?: string;
  seed3dApiKey?: string;
  blockadeLabsApiKey?: string;
  volcengineApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
}

export function buildRequestContext(keys: RunKeys): RequestContext {
  const ctx: RequestContext = new RequestContext();
  if (keys.projectSlug) ctx.set("projectSlug", keys.projectSlug);
  if (keys.llm) ctx.set("llm", keys.llm);
  if (keys.currentImagePaths) ctx.set("currentImagePaths", keys.currentImagePaths);
  if (keys.referenceAnalysisAllowed) ctx.set("referenceAnalysisAllowed", true);
  if (keys.imageGenerateModel) ctx.set("imageGenerateModel", keys.imageGenerateModel);
  if (keys.threeDModel) ctx.set("threeDModel", keys.threeDModel);
  // 0 是合法时刻（epoch），所以按 undefined 判而不是真值判。
  if (keys.sessionStartedAt !== undefined) ctx.set("sessionStartedAt", keys.sessionStartedAt);
  if (keys.worldLabsApiKey) ctx.set("worldLabsApiKey", keys.worldLabsApiKey);
  if (keys.tripo3dApiKey) ctx.set("tripo3dApiKey", keys.tripo3dApiKey);
  if (keys.hunyuanApiKey) ctx.set("hunyuanApiKey", keys.hunyuanApiKey);
  if (keys.seed3dApiKey) ctx.set("seed3dApiKey", keys.seed3dApiKey);
  if (keys.blockadeLabsApiKey) ctx.set("blockadeLabsApiKey", keys.blockadeLabsApiKey);
  if (keys.volcengineApiKey) ctx.set("volcengineApiKey", keys.volcengineApiKey);
  if (keys.googleApiKey) ctx.set("googleApiKey", keys.googleApiKey);
  if (keys.openaiApiKey) ctx.set("openaiApiKey", keys.openaiApiKey);
  if (keys.openrouterApiKey) ctx.set("openrouterApiKey", keys.openrouterApiKey);
  return ctx;
}
