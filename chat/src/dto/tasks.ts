import { z } from "zod";
import { LogicalPathSchema, ReferenceImageViewsSchema, SlugSchema } from "./library";

/** 生成任务契约；历史 provider ID 只用于读取旧任务元数据。 */

export const BATCH_3D_PROVIDER_IDS = [
  "trellis",
  "tripo3d",
  "rodin",
  "tripo-direct",
  "hyper3d-direct",
  "seed3d-direct",
  "hyper3d-volc",
  "hi3d-volc",
] as const;

export const TaskStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const TaskPhaseSchema = z.enum([
  "queued",
  "generating",
  "downloading",
  "validating",
  "publishing",
  "completed",
  "failed",
]);

export const Retryable3dTaskSchema = z.object({
  kind: z.literal("3d"),
  assetSlug: SlugSchema,
  name: z.string().min(1),
  intent: z.string().min(1),
  sourceImages: z.array(z.string()),
  referenceViews: ReferenceImageViewsSchema.optional(),
  provider: z.enum(BATCH_3D_PROVIDER_IDS).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const GenerationTaskSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  projectSlug: SlugSchema,
  subject: z.string(),
  status: TaskStatusSchema,
  phase: TaskPhaseSchema.default("queued"),
  assetSlug: SlugSchema.optional(),
  batchId: z.string().optional(),
  /** 创建该任务的进程身份；热重载不变、进程重启才变，用于区分「服务重启」和「模块重载」 */
  bootId: z.string().optional(),
  retry: Retryable3dTaskSchema.optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GenerationTask = z.infer<typeof GenerationTaskSchema>;

export const Start3dBatchRequestSchema = z
  .object({
    projectSlug: SlugSchema,
    /** 省略 = 项目下全部可生成对象（正式资产 + 已确认场景对象 + 单物体生成目标） */
    assetSlugs: z.array(SlugSchema).optional(),
    provider: z.enum(["seed3d-direct", "hyper3d-volc", "hi3d-volc", "tripo-direct"]).default("seed3d-direct"),
    faceCount: z.number().int().min(500).max(2000000).optional(),
    generateType: z.enum(["Normal", "LowPoly", "Geometry"]).optional(),
    enableRigging: z.boolean().optional(),
    enableAnimation: z.boolean().optional(),
    taPose: z.boolean().optional(),
    resolution: z.enum(["1536", "1536pro"]).optional(),
    /** seed3d-direct：面数走档位（high=100 万 / medium=50 万 / low=10 万） */
    subdivisionLevel: z.enum(["high", "medium", "low"]).optional(),
    /** Tripo：自动识别带方位的多视角图，或显式强制单图/多视角。 */
    tripoGenerationMode: z.enum(["auto", "single", "multiview"]).default("auto"),
    tripo3dApiKey: z.string().min(1).optional(),
    seed3dApiKey: z.string().min(1).optional(),
    volcengineApiKey: z.string().min(1).optional(),
  })
  .superRefine((req, ctx) => {
    if (req.provider === "hi3d-volc" && req.faceCount && req.faceCount < 100000) {
      ctx.addIssue({ code: "custom", message: "Hi3D 面数需在 10 万至 200 万之间" });
    }
    if (req.provider === "hyper3d-volc" && req.faceCount && req.faceCount > 1000000) {
      ctx.addIssue({ code: "custom", message: "Hyper3D Raw 网格最多 100 万面" });
    }
    if (req.provider === "tripo-direct") {
      if (!req.tripo3dApiKey) {
        ctx.addIssue({ code: "custom", message: "provider=tripo-direct 需要 tripo3dApiKey" });
      }
    } else {
      if (!req.seed3dApiKey && !req.volcengineApiKey) {
        ctx.addIssue({ code: "custom", message: "本机 chat/.env 未配置 VOLC_KEY" });
      }
    }
  });
export type Start3dBatchRequest = z.infer<typeof Start3dBatchRequestSchema>;

export const StartWorldTaskRequestSchema = z.object({
  projectSlug: SlugSchema,
  /** 旧客户端未传 mode 时保留原来的空环境行为。 */
  mode: z.enum(["direct", "empty-environment"]).default("empty-environment"),
  /** 省略使用最新源图；null 只用文字。 */
  sourceImage: LogicalPathSchema.nullable().optional(),
  prompt: z.string().optional(),
  extraPrompt: z.string().optional(),
  worldLabsApiKey: z.string().min(1),
});
export type StartWorldTaskRequest = z.infer<typeof StartWorldTaskRequestSchema>;
