import { ChatServiceError } from "../../common/errors";
import type { LlmConfig } from "../../dto/chat";
import { SlugSchema } from "../../dto/library";
import {
  IMAGE_EDIT_MODEL_IDS,
  type ImageEditModel,
} from "../../models/images";
import { threeDModelFor, type ThreeDModelEntry } from "../../models/threeD";

interface ToolContextLike {
  requestContext?: unknown;
}

function readContextValue(context: ToolContextLike | undefined, key: string): unknown {
  const requestContext = context?.requestContext;
  if (
    requestContext &&
    typeof requestContext === "object" &&
    "get" in requestContext &&
    typeof requestContext.get === "function"
  ) {
    return requestContext.get(key);
  }
  return (requestContext as Record<string, unknown> | undefined)?.[key];
}

export function requireCurrentProject(context: ToolContextLike | undefined): string {
  const parsed = SlugSchema.safeParse(readContextValue(context, "projectSlug"));
  if (!parsed.success) {
    throw new ChatServiceError("当前请求没有有效的项目上下文", 400, "missing_project_context");
  }
  return parsed.data;
}

/** BYOK 供应商 key 的 context 字段名（与 dto/chat.ts 请求字段、app 设置一一对应） */
export type ProviderKeyName =
  | "worldLabsApiKey"
  | "tripo3dApiKey"
  | "hunyuanApiKey"
  | "seed3dApiKey"
  | "blockadeLabsApiKey"
  | "volcengineApiKey"
  | "googleApiKey"
  | "openaiApiKey"
  | "openrouterApiKey";

export function optionalContextString(
  context: ToolContextLike | undefined,
  key: ProviderKeyName,
): string | undefined {
  const value = readContextValue(context, key);
  return typeof value === "string" && value ? value : undefined;
}

/** LLM 配置是一个对象，不能走只读取字符串供应商 key 的 optionalContextString。 */
export function optionalContextLlm(
  context: ToolContextLike | undefined,
): LlmConfig | undefined {
  const value = readContextValue(context, "llm");
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const llm = value as Partial<LlmConfig>;
  return typeof llm.apiKey === "string" && llm.apiKey
    ? (llm as LlmConfig)
    : undefined;
}

export function currentImagePaths(
  context: ToolContextLike | undefined,
): string[] {
  const value = readContextValue(context, "currentImagePaths");
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function referenceAnalysisAllowed(
  context: ToolContextLike | undefined,
): boolean {
  return readContextValue(context, "referenceAnalysisAllowed") === true;
}

/** AgentDock 当前图片生成模型；Auto/旧请求统一回退到默认 Seedream 4.5。 */
export function currentImageGenerateModel(
  context: ToolContextLike | undefined,
): ImageEditModel {
  const value = readContextValue(context, "imageGenerateModel");
  return typeof value === "string" &&
    (IMAGE_EDIT_MODEL_IDS as readonly string[]).includes(value)
    ? value as ImageEditModel
    : "seedream";
}

/** AgentDock 当前 3D 模型选择；未选择（Auto）或键未注册时返回 undefined。 */
export function currentThreeDModel(
  context: ToolContextLike | undefined,
): ThreeDModelEntry | undefined {
  return threeDModelFor(readContextValue(context, "threeDModel"));
}

/**
 * 当前会话开始的时刻（epoch ms）；客户端没带时返回 undefined。
 *
 * 用途只有一个：判断某张参考图是不是"本会话的产物"。undefined 表示**做不了这个
 * 判断**，调用方必须按"保持原行为"处理，而不是当成"所有图都是旧的"——那会让同一
 * 会话里的正常复用也每次都要用户点头。
 */
export function currentSessionStartedAt(
  context: ToolContextLike | undefined,
): number | undefined {
  const value = readContextValue(context, "sessionStartedAt");
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function requireContextString(
  context: ToolContextLike | undefined,
  key: ProviderKeyName,
  hint: string,
): string {
  const value = optionalContextString(context, key);
  if (!value) throw new ChatServiceError(hint, 401, `missing_${key}`);
  return value;
}
