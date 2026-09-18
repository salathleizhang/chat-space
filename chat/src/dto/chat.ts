import { z } from "zod";
import { LLM_PROVIDER_IDS } from "../config";
import { LogicalPathSchema, ProjectPlanSchema, SlugSchema } from "./library";

/**
 * 对话消息部件：
 * - 图片以资产库逻辑路径引用（自检截图回传的通道——OpenAI 兼容协议的 tool
 *   消息装不了图，检查图必须走用户消息），发送给 LLM 前由服务端内联成 data URI；
 * - 资产附件只传稳定的 slug，服务端从当前项目真实资产库解析名称并转成文本锚点。
 *   它作为消息部件而不是请求顶层字段，才能让历史消息永久保留“当时选中了谁”。
 */
export const ChatContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
  z.object({ type: z.literal("image"), path: LogicalPathSchema }),
  z.object({ type: z.literal("asset"), assetSlug: SlugSchema }),
]);
export type ChatContentPart = z.infer<typeof ChatContentPartSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string().min(1), z.array(ChatContentPartSchema).min(1)]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 本机服务注入固定 LLM 配置；客户端字段会在解析前覆盖。 */
export const LlmConfigSchema = z.object({
  apiKey: z.string().min(1, "本机 chat/.env 未配置 VOLC_KEY"),
  provider: z.enum(LLM_PROVIDER_IDS).optional(),
  baseUrl: z.url().optional(),
  model: z.string().min(1).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const ChatStreamRequestSchema = z.object({
  /** 当前工作台唯一项目：Agent 的所有工具调用都由服务端锁定到该项目 */
  projectSlug: SlugSchema,
  messages: z.array(ChatMessageSchema).min(1),
  /** 当前会话自己的计划快照；防止恢复旧会话时误用项目里另一会话的最新计划。 */
  plan: ProjectPlanSchema.optional(),
  llm: LlmConfigSchema,
  /** 仅本机服务注入的凭证，浏览器提交的同名字段会被丢弃。 */
  worldLabsApiKey: z.string().min(1).optional(),
  tripo3dApiKey: z.string().min(1).optional(),
  seed3dApiKey: z.string().min(1).optional(),
  volcengineApiKey: z.string().min(1).optional(),
  threeDProvider: z.enum(["seed3d-direct", "hyper3d-volc", "hi3d-volc", "tripo-direct"]).optional(),
  /** AgentDock 图片生成模型偏好（软约束）；省略 = 由 agent 自动选择 */
  imageGenerateModel: z.enum(["seedream", "seedream-5", "seedream-5-pro"]).optional(),
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

/**
 * SSE 事件契约：event 名 + data JSON；tool = agent 工具调用透明度（付费操作对用户可见）。
 * tool 事件带 toolCallId 与 args：inspect-asset 等客户端协作工具靠 args 驱动 app 侧动作。
 */
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool-result"),
    name: z.string(),
    toolCallId: z.string().optional(),
    /** 同步图片工具完成后可立即展示的库内逻辑路径。 */
    images: z.array(LogicalPathSchema).optional(),
    /** 后台工具创建的任务 id，客户端据此轮询当前批次。 */
    taskIds: z.array(z.string().min(1)).optional(),
    /** update-plan 的完整结果，客户端直接保存为当前会话快照。 */
    plan: ProjectPlanSchema.optional(),
  }),
  z.object({
    type: z.literal("tool-error"),
    name: z.string(),
    toolCallId: z.string().optional(),
    /** 工具自身抛出的可读错误；不再把所有失败压成只有工具名的空事件。 */
    message: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
