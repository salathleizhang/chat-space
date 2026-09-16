import { z } from "zod";

/**
 * 资产库元数据契约（docs/image-blast-mastra.md §4.2/§5/§7）。
 * zod schema 是元数据的唯一真相：本地落 JSON 侧写，云上同 schema 进 Supabase（决策 3③）。
 */

export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug 只能是小写字母数字与连字符");
export type Slug = z.infer<typeof SlugSchema>;

/** 逻辑路径：相对资产库根，禁绝对路径与目录穿越（云迁移纪律 ①） */
export const LogicalPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.split("/").includes("..") &&
      !p.split("/").includes(""),
    { message: "必须是相对资产库根的逻辑路径（无绝对路径、无 ..、无空段）" },
  );
export type LogicalPath = z.infer<typeof LogicalPathSchema>;

/** 模型导出目标格式：glb 原样直出，gltf 走 gltf-transform 无损重新打包，obj 走 three.js 场景图往返 */
export const ExportFormatSchema = z.enum(["glb", "gltf", "obj"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/** 批量导出请求体：多个逻辑路径统一转成同一目标格式，打包成 zip 返回 */
export const ExportBatchRequestSchema = z.object({
  sources: z.array(LogicalPathSchema).min(1).max(50),
  format: ExportFormatSchema,
});
export type ExportBatchRequest = z.infer<typeof ExportBatchRequestSchema>;

/**
 * "世界"只是资产类型之一，与模型、贴图、动画平级（决策 4）；other = wildcard 任意端点产物。
 * skybox = 纯 HDR/EXR 全景环境贴图（Blockade Labs 等），跟 world（可探索场景，含
 * navmesh/spz）是不同产物，不复用同一个 kind。
 */
export const AssetKindSchema = z.enum([
  "model",
  "texture",
  "animation",
  "world",
  "skybox",
  "image",
  "other",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** 项目信封（project.json） */
export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** 当前生效的天空盒资产 slug（单例指针，非列表）；视口环境贴图按此项加载 */
  currentSkybox: SlugSchema.optional(),
  /** 当前生效的 World 资产 slug（单例指针，非列表）；视口一次只加载一个世界 */
  currentWorld: SlugSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** 图片分析抽出的原子对象候选（"可单独拿起"，不含场景表面） */
export const ObjectCandidateSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
});
export type ObjectCandidate = z.infer<typeof ObjectCandidateSchema>;

/** 尚未发布为正式资产的生成对象：来自场景确认，或文生单物体参考图的明确目标。 */
export const ConfirmedObjectSchema = ObjectCandidateSchema.extend({
  sourceImages: z.array(LogicalPathSchema).optional(),
});
export type ConfirmedObject = z.infer<typeof ConfirmedObjectSchema>;

export const CandidateRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  objects: z.array(ConfirmedObjectSchema),
  updatedAt: z.iso.datetime(),
});
export type CandidateRegistry = z.infer<typeof CandidateRegistrySchema>;

/** 逐图分析（source/<image>.json） */
export const ImageAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  image: LogicalPathSchema,
  observations: z.string().min(1),
  objects: z.array(ObjectCandidateSchema),
  analyzedAt: z.iso.datetime(),
});
export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>;

/** 场景级合并分析（analysis.json） */
export const SceneAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  sceneName: z.string().min(1),
  sceneDescription: z.string().min(1),
  environment: z
    .object({
      lighting: z.string(),
      mood: z.string(),
      spatialLayout: z.string(),
    })
    .partial(),
  /** 跨图去重后的对象候选 */
  objects: z.array(ConfirmedObjectSchema),
  sources: z.array(LogicalPathSchema),
  analyzedAt: z.iso.datetime(),
});
export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>;

/** 资产身份（asset.json）：只存意图与溯源，生成状态在请求侧写（§4.2） */
export const AssetIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  slug: SlugSchema,
  kind: AssetKindSchema,
  name: z.string().min(1),
  /** 生成意图：描述这个资产"应该是什么" */
  intent: z.string().min(1),
  sourceImages: z.array(LogicalPathSchema),
  createdAt: z.iso.datetime(),
});
export type AssetIdentity = z.infer<typeof AssetIdentitySchema>;

/**
 * 项目计划（plan.json）：no-op 状态工具的落盘产物（Manus todo.md 模式）。
 * 计划不是可执行结构——执行者是 creator agent 本人，这里只记"给用户和模型看的进度"。
 */
export const PlanStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: PlanStepStatusSchema.default("pending"),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ProjectPlanSchema = z.object({
  schemaVersion: z.literal(1),
  /** 只有显式重新规划才递增；普通进度更新保持版本不变。 */
  revision: z.number().int().positive().default(1),
  /** 当前版本相对上一版改变结构的原因。 */
  revisionReason: z.string().min(1).optional(),
  title: z.string().optional(),
  steps: z.array(PlanStepSchema).min(1),
  updatedAt: z.iso.datetime(),
});
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

/** 三分量向量：位置 / 欧拉旋转（XYZ 序，弧度）/ 缩放共用，与 three.js 右手 Y-up 一致 */
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** 单个资产在共享场景里的摆放，字段与 three.js Object3D 的 position/rotation/scale 一一对应 */
export const AssetTransformSchema = z.object({
  position: Vec3Schema,
  rotation: Vec3Schema,
  scale: Vec3Schema,
});
export type AssetTransform = z.infer<typeof AssetTransformSchema>;

/**
 * 场景摆放（scene.json）：用户在 3D 视口里用 gizmo 调过的资产变换，按 assetSlug 索引。
 * **只记用户手动摆过的那些**——没有条目的资产由 app 侧按创建顺序算网格默认位（纯派生，
 * 不落盘）。所以这份文件天然稀疏，新资产不需要预先写入。
 */
export const SceneLayoutSchema = z.object({
  schemaVersion: z.literal(1),
  transforms: z.record(SlugSchema, AssetTransformSchema),
  updatedAt: z.iso.datetime(),
});
export type SceneLayout = z.infer<typeof SceneLayoutSchema>;

export const RequestStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

const SECRET_PARAM_KEY_RE = /key|token|secret|password|credential/i;

/**
 * 递归检查 params 里是否有疑似密钥的字段名。wildcard 会把调用方任意构造的 input 原样
 * 存进 params.input（嵌套对象），其内部键不受顶层 refine 约束，必须递归到叶子键。
 */
function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) => SECRET_PARAM_KEY_RE.test(key) || containsSecretKey(nested),
    );
  }
  return false;
}

/**
 * 请求侧写（.N-slug-request.json）：续跑与本地修复的依据（§5 失败恢复）。
 * 程序化保证 BYOK 纪律：params 里出现疑似密钥的字段名直接判校验失败。
 */
export const RequestSidecarSchema = z.object({
  schemaVersion: z.literal(1),
  index: z.number().int().nonnegative(),
  slug: SlugSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  providerTaskId: z.string().optional(),
  params: z
    .record(z.string(), z.unknown())
    .refine((params) => !containsSecretKey(params), {
      message: "请求侧写不得包含密钥类字段（BYOK：key 只活在请求生命周期内）",
    }),
  status: RequestStatusSchema,
  outputs: z.array(
    z.object({
      path: LogicalPathSchema,
      /** 供应商 URL 只是溯源/续跑元数据，前端永远只读本地文件（§5 磁盘优先） */
      providerUrl: z.url().optional(),
    }),
  ),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RequestSidecar = z.infer<typeof RequestSidecarSchema>;
