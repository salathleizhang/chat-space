import { ChatServiceError } from "../../common/errors";
import type { LlmConfig } from "../../dto/chat";
import { SlugSchema } from "../../dto/library";

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
  | "falApiKey"
  | "worldLabsApiKey"
  | "meshyApiKey"
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

export function requireContextString(
  context: ToolContextLike | undefined,
  key: ProviderKeyName,
  hint: string,
): string {
  const value = optionalContextString(context, key);
  if (!value) throw new ChatServiceError(hint, 401, `missing_${key}`);
  return value;
}
