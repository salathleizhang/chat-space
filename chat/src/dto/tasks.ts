import { z } from "zod";
import { THREE_D_PROVIDER_IDS } from "../models/threeD";
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

/**
 * 生成流程能主动推进的阶段。
 *
 * 长流程必须边走边报：2026-09-26 的 World Labs 世界生成整整 53 分钟都停在 `queued`
 * （phase 只在全部下载完后的 onPublished 才推进），看板和 Agent 都只能看到「还在跑」，
 * 用户因此反复追问。每个阶段都要落一次，进度才是可见的。
 */
export const GenerationPhaseSchema = z.enum(["generating", "downloading", "publishing"]);
export type GenerationPhase = z.infer<typeof GenerationPhaseSchema>;

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

/**
 * 「还在跑、但一直没有进展」的诊断口径（读取时派生，不落盘）。
 *
 * 为什么要有它：2026-10-03 的定时器停摆事故里，任务文件停在提交那一毫秒十几分钟，
 * 而唯一的判据是 60 分钟后的「卡死」。现在 90 秒就能从工作台的 `GET /api/tasks` 里看到，
 * 并且带上「进程里还有没有推进闸门照看它」——`pumpActive: false` 才需要续跑/重试。
 */
export const TaskStallSchema = z.object({
  /** 距上次进展过去多久（毫秒） */
  silentForMs: z.number().int().nonnegative(),
  /** 进程里是否还有在照看它的推进闸门（见 common/taskPump.ts） */
  pumpActive: z.boolean(),
});
export type TaskStall = z.infer<typeof TaskStallSchema>;

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
  /** 续跑任务的来源侧写（逻辑路径）；重启后的自动续跑靠它判重 */
  resumeSidecar: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** 只读诊断：仅当 running 且长时间没有进展时出现 */
  stall: TaskStallSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GenerationTask = z.infer<typeof GenerationTaskSchema>;

export const Start3dBatchRequestSchema = z
  .object({
    projectSlug: SlugSchema,
    /** 省略 = 项目下全部可生成对象（正式资产 + 已确认场景对象 + 单物体生成目标） */
    assetSlugs: z.array(SlugSchema).optional(),
    provider: z.enum(THREE_D_PROVIDER_IDS).default("seed3d-direct"),
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
      ctx.addIssue({ code: "custom", message: "Hi3D face count must be between 100,000 and 2,000,000" });
    }
    if (req.provider === "hyper3d-volc" && req.faceCount && req.faceCount > 1000000) {
      ctx.addIssue({ code: "custom", message: "Hyper3D Raw meshes are limited to 1,000,000 faces" });
    }
    if (req.provider === "tripo-direct") {
      if (!req.tripo3dApiKey) {
        ctx.addIssue({ code: "custom", message: "provider=tripo-direct requires tripo3dApiKey" });
      }
    } else {
      if (!req.seed3dApiKey && !req.volcengineApiKey) {
        ctx.addIssue({ code: "custom", message: "VOLC_KEY is not configured in the local chat/.env" });
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
