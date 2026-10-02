import { z } from "zod";
import { AskUserQuestionSchema } from "./chat";
import { LogicalPathSchema, ProjectPlanSchema, SlugSchema } from "./library";

/** 会话历史契约（决策 8：会话与资产同源存储，归 chat/ 落盘 sessions/<id>.json） */

export const SessionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "会话 id 只能是字母数字与连字符");

export const SessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  pendingTaskIds: z.array(z.string().min(1)).optional(),
  pendingInspectionAssetSlug: SlugSchema.optional(),
  /** 等待主视口截图的整场景检查机位（视角 id，见 app 的 INSPECTION_VIEW_IDS） */
  pendingSceneInspectionView: z.string().min(1).optional(),
  /** 消息携带的库内图片（用户附件或工具生成图），逻辑路径引用 */
  images: z.array(LogicalPathSchema).optional(),
  /**
   * Agent 自发续跑时本轮拿到的产物（四视角自检图、候选参考图、后台任务结果，
   * 以及刚落盘的参考图/底板/天空盒）。它不是用户输入，只是渲染成 Agent 侧卡片
   * 所需的展示信息；发给模型时走请求的 `resume` 字段，不从这里回放。
   */
  autoTurn: z
    .object({
      kind: z.enum(["inspection", "identify", "tasks", "plan", "reference"]),
      label: z.string().min(1),
      images: z.array(LogicalPathSchema).optional(),
    })
    .optional(),
  /**
   * 用户发送这一条消息时选中的资产快照。slug 才是发给 agent 的身份；
   * name/thumbPath/kind 只为恢复会话后仍能还原附件 UI。
   */
  assets: z
    .array(
      z.object({
        assetSlug: SlugSchema,
        name: z.string().min(1),
        thumbPath: LogicalPathSchema.optional(),
        kind: z.string().min(1).optional(),
      }),
    )
    .optional(),
  /** assistant 回复中的工具执行轨迹；旧会话没有该字段时保持兼容。 */
  activities: z
    .array(
      z.object({
        id: z.string().min(1),
        toolName: z.string().min(1).optional(),
        contentOffset: z.number().int().nonnegative().optional(),
        label: z.string().min(1),
        status: z.enum(["running", "completed", "failed"]),
      }),
    )
    .optional(),
  /** 每轮 Assistant 消息顶部的状态摘要；旧会话没有该字段时保持兼容。 */
  agentStatus: z
    .object({
      label: z.string().min(1),
      /** waiting = 已把问题交给用户，等卡片被点选或用户直接输入 */
      status: z.enum(["running", "waiting", "completed", "failed"]),
    })
    .optional(),
  /**
   * ask-user 提问卡片：待回答时渲染成可点选卡片；回答后由 questionAnswer
   * 记录用户选了什么，卡片转为只读。
   */
  pendingQuestion: AskUserQuestionSchema.optional(),
  questionAnswer: z
    .object({
      questionId: z.string().min(1),
      question: z.string().min(1).max(600),
      optionIds: z.array(z.string().min(1)),
      labels: z.array(z.string().min(1)).max(6),
      text: z.string().min(1).max(1000).optional(),
    })
    .optional(),
  /** 待回答的问题被用户跳过（直接打字回了别的）；卡片置灰但保留在历史里 */
  supersededQuestion: z.boolean().optional(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: SessionIdSchema,
  /** 兼容早期无项目作用域的会话文件；新保存的会话始终带项目 */
  projectSlug: SlugSchema.optional(),
  title: z.string().min(1),
  messages: z.array(SessionMessageSchema),
  /** 会话自己的计划快照；旧会话缺省时按无计划处理，不能借用项目最新计划。 */
  plan: ProjectPlanSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SaveSessionRequestSchema = z.object({
  projectSlug: SlugSchema,
  title: z.string().min(1),
  messages: z.array(SessionMessageSchema),
  plan: ProjectPlanSchema.optional(),
});
export type SaveSessionRequest = z.infer<typeof SaveSessionRequestSchema>;

export const SessionSummarySchema = SessionSchema.pick({
  id: true,
  projectSlug: true,
  title: true,
  createdAt: true,
  updatedAt: true,
}).extend({ messageCount: z.number().int().nonnegative() });
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
