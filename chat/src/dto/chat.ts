import { z } from "zod";
import { LLM_PROVIDER_IDS } from "../config";
import { ENABLED_THREE_D_MODEL_SELECTIONS } from "../models/threeD";
import { LogicalPathSchema, ProjectPlanSchema, SlugSchema } from "./library";

/**
 * 对话消息部件：
 * - 图片以资产库逻辑路径引用（用户附件的通道），发送给 LLM 前由服务端内联成
 *   data URI；Agent 自己产出的图片走 `resume`，不占用户消息；
 * - 资产附件只传稳定的 slug，服务端从当前项目真实资产库解析名称并转成文本锚点。
 *   它作为消息部件而不是请求顶层字段，才能让历史消息永久保留“当时选中了谁”。
 */
export const ChatContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
  z.object({ type: z.literal("image"), path: LogicalPathSchema }),
  z.object({ type: z.literal("asset"), assetSlug: SlugSchema }),
]);
export type ChatContentPart = z.infer<typeof ChatContentPartSchema>;

/**
 * 用户在 ask-user 卡片上作出的选择。
 *
 * 它走请求顶层的 `answer` 字段，而不是一条用户消息：用户点的是卡片，不是发言，
 * 历史里不该凭空多出一条用户气泡，"同意"这类词也不该占掉会话标题。服务端每轮
 * 无状态、不保存提问状态，所以问题原文与选项文字必须随答案一起回来。
 */
export const AskUserAnswerSchema = z
  .object({
    questionId: z.string().min(1),
    /** 原问题文本；服务端据此把这一轮上下文补全 */
    question: z.string().min(1).max(600),
    optionIds: z.array(z.string().min(1)),
    /** 与 optionIds 一一对应的可读文字 */
    labels: z.array(z.string().min(1)).max(6),
    /** allowOther 的自由输入 */
    text: z.string().min(1).max(1000).optional(),
  })
  /*
    一一对应必须在这里锁住：服务端拿 labels 当"用户选了什么"报给模型，
    数量对不上就会把用户的选择说错，而这属于会误导后续付费决策的错误。
  */
  .refine((answer) => answer.labels.length === answer.optionIds.length, {
    message: "labels must correspond one-to-one with optionIds",
    path: ["labels"],
  });
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string().min(1), z.array(ChatContentPartSchema).min(1)]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * ask-user 提问卡片：Agent 需要用户本人做决定（付费同意、方案取舍、对象确认）
 * 时给出的可点选问题。选项内容完全由模型决定，因此这里只有形状约束，
 * 没有固定枚举——「同意/停止」只是其中一种常见填法。
 */
export const AskUserOptionSchema = z.object({
  /** 稳定 id，回传时用它标识选中项 */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "option id may only contain letters, digits, - and _"),
  /** 按钮文字，例如「同意」「停止」 */
  label: z.string().min(1).max(40),
  /** 第二行说明，例如将调用哪个平台、大概做什么 */
  description: z.string().min(1).max(300).optional(),
  tone: z.enum(["default", "primary", "danger"]).optional(),
  recommended: z.boolean().optional(),
});
export type AskUserOption = z.infer<typeof AskUserOptionSchema>;

/** 模型给出的提问草稿；questionId 由服务端补齐，模型看不到也不需要它。 */
export const AskUserQuestionDraftSchema = z.object({
  /** 卡片角标，例如「付费确认」 */
  header: z.string().min(1).max(24).optional(),
  question: z.string().min(1).max(600),
  /** 需要展开说明的清单，例如这一轮会跑哪些付费步骤 */
  details: z.array(z.string().min(1).max(300)).max(12).optional(),
  options: z.array(AskUserOptionSchema).min(1).max(6),
  multiSelect: z.boolean().optional(),
  /** 是否给一个自由输入逃生口 */
  allowOther: z.boolean().optional(),
});
export type AskUserQuestionDraft = z.infer<typeof AskUserQuestionDraftSchema>;

/** 落进对话的问题：草稿 + 服务端生成的 questionId，两个布尔开关已归一化。 */
export const AskUserQuestionSchema = AskUserQuestionDraftSchema.extend({
  questionId: z.string().min(1),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

/** 本机服务注入固定 LLM 配置；客户端字段会在解析前覆盖。 */
export const LlmConfigSchema = z.object({
  apiKey: z.string().min(1, "VOLC_KEY is not configured in the local chat/.env"),
  provider: z.enum(LLM_PROVIDER_IDS).optional(),
  baseUrl: z.url().optional(),
  model: z.string().min(1).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/**
 * Agent 自发续跑：客户端协作工具（四视角自检、参考图身份确认、后台任务完成、
 * 图片产物落盘）的产物要回到模型眼前，但发起者是 Agent 自己，不是用户。
 * `plan` 是同一机制里没有产物的一种：计划还有没做完的步骤，客户端据此把 Agent
 * 拉起来接着做；`reference` 是图片工具落盘的那一种：图已经贴进对话，客户端把
 * Agent 拉起来，让它用 ask-user 卡片问用户下一步（例如要不要继续做 3D），而不是
 * 用正文让用户手打「继续」。
 *
 * 为什么仍然由服务端拼成一条 user 消息：OpenAI 兼容协议的 tool 消息装不了图，
 * 图片只能走 user 角色。但这条消息只活在本次请求的上下文里——工作台不把它写进
 * 会话记录，界面也只展示成 Agent 侧的自检卡片，因此它既不会冒充用户输入，
 * 也不会在后续每一轮里被重复内联回传。
 */
export const ChatResumeSchema = z.object({
  kind: z.enum(["inspection", "identify", "tasks", "plan", "reference"]),
  /** 面向模型的续跑指令；措辞属于 Agent 的工作上下文，不是用户说的话 */
  text: z.string().min(1),
  /** 本轮要交回模型的库内图片（如 2×2 四视角检查图） */
  images: z.array(LogicalPathSchema).optional(),
});
export type ChatResume = z.infer<typeof ChatResumeSchema>;

export const ChatStreamRequestSchema = z.object({
  /** 当前工作台唯一项目：Agent 的所有工具调用都由服务端锁定到该项目 */
  projectSlug: SlugSchema,
  messages: z.array(ChatMessageSchema).min(1),
  /** 当前会话自己的计划快照；防止恢复旧会话时误用项目里另一会话的最新计划。 */
  plan: ProjectPlanSchema.optional(),
  /**
   * 当前会话开始的时刻（epoch ms）。服务端**无法自己知道**会话边界（`source/` 是项目级
   * 目录，没有任何"这一轮"的标记），而"参考图能不能自动复用"必须按它会话判断：上一轮
   * 生成的参考图不许静默复用，要复用得先问用户。客户端本来就有这个值（会话的
   * `createdAt`，新建会话则是按下按钮那一刻），直接带过来即可。
   *
   * 省略 = 客户端没带（旧客户端）。此时服务端**不**做本轮判断，保持原行为——
   * "不知道会话边界"不等于"所有图都是上一轮的"。
   */
  sessionStartedAt: z.number().int().nonnegative().optional(),
  /** Agent 自发续跑的本轮上下文；不进入 messages，因此不落会话历史。 */
  resume: ChatResumeSchema.optional(),
  /** ask-user 卡片的点选结果；与 resume 同款，只活在本轮上下文里。 */
  answer: AskUserAnswerSchema.optional(),
  llm: LlmConfigSchema,
  /** 仅本机服务注入的凭证，浏览器提交的同名字段会被丢弃。 */
  worldLabsApiKey: z.string().min(1).optional(),
  tripo3dApiKey: z.string().min(1).optional(),
  hunyuanApiKey: z.string().min(1).optional(),
  seed3dApiKey: z.string().min(1).optional(),
  volcengineApiKey: z.string().min(1).optional(),
  /** AgentDock 的 3D 生成模型选择（硬约束：渠道与模型 ID 都由服务端钉住）；省略 = 由 agent 自动选择 */
  threeDModel: z.enum(ENABLED_THREE_D_MODEL_SELECTIONS).optional(),
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
    /** ask-user 的提问；服务端发出后即中止本轮，等待用户点选或输入。 */
    question: AskUserQuestionSchema.optional(),
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
