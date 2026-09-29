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

/** Tripo 多视角输入的标准方位；路径仍同时保存在 sourceImages 以兼容其他供应商。 */
export const ReferenceImageViewsSchema = z.object({
  front: LogicalPathSchema.optional(),
  left: LogicalPathSchema.optional(),
  back: LogicalPathSchema.optional(),
  right: LogicalPathSchema.optional(),
});
export type ReferenceImageViews = z.infer<typeof ReferenceImageViewsSchema>;

/** 尚未发布为正式资产的生成对象：来自场景确认，或文生单物体参考图的明确目标。 */
export const ConfirmedObjectSchema = ObjectCandidateSchema.extend({
  sourceImages: z.array(LogicalPathSchema).optional(),
  referenceViews: ReferenceImageViewsSchema.optional(),
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
  /** 让 Workflow 重试同一次用户确认时保持幂等；旧工程没有该字段也可继续读取。 */
  confirmation: z
    .object({
      runId: z.uuid(),
      selectedSlugs: z.array(SlugSchema).min(1),
      allSelected: z.boolean(),
    })
    .optional(),
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
  /**
   * **稳定身份**：与 slug 解耦，删除资产后再用同一个 slug 新建也不会撞上旧记录。
   * 老工程的 asset.json 没有这个字段（读取时用 `assetStableId` 退化到 slug 派生），
   * 所以是可选的；新建一律经 `createAssetIdentity` 写入。
   */
  id: z.string().min(1).optional(),
  slug: SlugSchema,
  kind: AssetKindSchema,
  name: z.string().min(1),
  /** 生成意图：描述这个资产"应该是什么" */
  intent: z.string().min(1),
  sourceImages: z.array(LogicalPathSchema),
  /** 已确认的多视角方位；省略表示 sourceImages 只是普通参考图集合。 */
  referenceViews: ReferenceImageViewsSchema.optional(),
  createdAt: z.iso.datetime(),
});
export type AssetIdentity = z.infer<typeof AssetIdentitySchema>;

/**
 * 新建资产身份：**唯一**负责发 id 的地方。所有写 asset.json 的路径都得走它，
 * 否则那条路径造出来的资产会退化到 slug 派生的身份，slug 复用时的隔离就漏了。
 */
export function createAssetIdentity(
  input: Omit<AssetIdentity, "schemaVersion" | "id" | "createdAt"> & { createdAt?: string },
): AssetIdentity {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  };
}

/**
 * 资产的稳定 id。老工程的 asset.json 没有 `id`，退化成按 slug 派生——
 * 只要那个 slug 不被复用就等价于稳定；一旦被复用，新建的资产拿到的是新 UUID，
 * 旧派生 id 上的场景记录不会被新资产继承。
 */
export function assetStableId(identity: { id?: string } | undefined, slug: string): string {
  return identity?.id ?? `slug:${slug}`;
}

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

/** 可被工程图片覆盖的贴图通道（three 材质槽位名，与 app 侧 materialOverrides 同表） */
export const MaterialTextureSlotSchema = z.enum([
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
]);
export type MaterialTextureSlot = z.infer<typeof MaterialTextureSlotSchema>;

/**
 * 单个资产的材质覆盖（scene.json 的 materials 条目）。**只做贴图替换，不换材质类**：
 * 覆盖的实现是从供应商文件里的原材质克隆一份、只补用户改过的槽位，所以 glTF 的
 * clearcoat/transmission、OBJ 的 specular、unlit 材质都原样保留。
 *
 * 稀疏到槽位：`textures` 里没有的通道沿用模型自带贴图，**不是**"清空该通道"——清空在
 * app 侧没有独立语义，因为用户能做的事只有"换成另一张图"和"换回原图"。
 *
 * 曾经有过一个 `shader` 档位字段（可切成 Standard/Phong/Toon… 等九个预设），已移除：
 * 这个面板的主要工作是换贴图，多出来的档位要么与"保持原材质"逐像素相同，要么是把
 * 外观改成用户调不回来的样子。旧文件里残留的 `shader` 键会被 zod 默认的 strip 丢掉，
 * 读取不受影响。
 */
export const AssetMaterialSchema = z.object({
  /** partialRecord：稀疏是常态，七个通道里通常只覆盖一两个 */
  textures: z.partialRecord(MaterialTextureSlotSchema, LogicalPathSchema).default({}),
});
export type AssetMaterial = z.infer<typeof AssetMaterialSchema>;

/**
 * 场景文档当前版本。
 *
 * - v1 → v2：新增 `revision`。形状没变，只是补一个字段；有了它，客户端才知道自己这次
 *   合并基于哪一版（此前只有 `updatedAt`，判断不了在途的防抖保存是否已经过期）。
 * - v2 → v3：两张表的键从 **assetSlug 换成资产稳定 id**。这是"删除资产后用同名 slug 重建
 *   会继承旧摆放/旧材质"那个老问题的结构性解法——新资产拿的是新 id，旧记录它永远读不到，
 *   不再依赖删除时顺手清理。
 */
export const SCENE_SCHEMA_VERSION = 3;

/** 场景表里的键：资产稳定 id（不是 slug）。老工程里可能是 `slug:<slug>` 派生值 */
export const SceneKeySchema = z.string().min(1);

/**
 * 磁盘上的形态：`schemaVersion` 只要求是正整数，因为工程目录里可能躺着任意旧版本。
 * **读取一律经 `migrateSceneLayout` 收敛**，绝不用当前 schema 直接 parse 旧文件。
 *
 * v3 之前两张表按 slug 索引，slug 与稳定 id 的字符集不同（id 可能含 `:`、UUID 的连字符与
 * 大小写），所以这里的键放宽成非空串——版本判定在前，键的语义由迁移负责。
 */
const StoredSceneLayoutSchema = z.object({
  /** 缺失按 v1 处理：这个键是后加的，手写文件也可能没有 */
  schemaVersion: z.number().int().positive().default(1),
  transforms: z.record(SceneKeySchema, AssetTransformSchema),
  materials: z.record(SceneKeySchema, AssetMaterialSchema).default({}),
  revision: z.number().int().nonnegative().optional(),
  updatedAt: z.iso.datetime(),
});

/**
 * 场景摆放（scene.json）：用户在 3D 视口里用 gizmo 调过的资产变换，**按资产稳定 id 索引**。
 * **只记用户手动摆过的那些**——没有条目的资产由 app 侧按创建顺序算网格默认位（纯派生，
 * 不落盘）。所以这份文件天然稀疏，新资产不需要预先写入。
 *
 * `materials` 是同一份文件里的**兄弟表**而不是塞进 `AssetTransform`：写入是按键浅合并，
 * 嵌进变换值里的话，一次只带 transforms 的保存会把该资产的材质整份抹掉。旧文件没有这个键，
 * default 让读取照常通过。
 *
 * 这是**当前形态（v3）**：写入用它，迁移的产物也用它。`revision` 每次写入自增，迁移自
 * v1 的文档是 **0**，表示"还没按新方案写过"，所以 `revision > 0` 可以直接当作
 * "这份文档已被新版本程序改过"。
 */
export const SceneLayoutSchema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  transforms: z.record(SceneKeySchema, AssetTransformSchema),
  materials: z.record(SceneKeySchema, AssetMaterialSchema).default({}),
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.iso.datetime(),
});
export type SceneLayout = z.infer<typeof SceneLayoutSchema>;

/**
 * 把任意已落盘的 scene.json 收敛成当前版本。逐级升级，以后新增版本时在这里续一段并补测试。
 *
 * `assetIdsBySlug` 是 v3 迁移所需的 **slug → 稳定 id** 映射——只有服务层看得见资产目录，
 * 所以由调用方传入。旧文件里指向已不存在资产的 slug 用 `slug:<slug>` 兜底，与老资产
 * asset.json 缺 `id` 时的派生规则一致，于是它仍能被那个老资产认领。
 *
 * 版本**高于**当前时直接报错、不猜着解析：静默降级会把新字段丢掉，用户再保存一次
 * 就等于毁了那份文档，而报错至少能让用户去升级程序。
 *
 * 抛 `Error`（不是 ChatServiceError）：dto 层刻意只依赖 zod，调用方负责补上路径与错误码。
 */
export function migrateSceneLayout(
  raw: unknown,
  assetIdsBySlug: ReadonlyMap<string, string>,
): SceneLayout {
  const parsed = StoredSceneLayoutSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `场景文档不符合契约：${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const stored = parsed.data;
  if (stored.schemaVersion > SCENE_SCHEMA_VERSION) {
    throw new Error(
      `场景文档的 schemaVersion=${stored.schemaVersion} 高于当前支持的 ${SCENE_SCHEMA_VERSION}，请升级应用后再打开该工程`,
    );
  }
  // v1/v2 → v3：两张表从 slug 键改写为稳定 id 键。
  // **只在版本真的低于 3 时改写**——v3 文档的键已经是 id，再查一遍映射表只会把它二次
  // 改写成 `slug:<id>`（这些测试就是这么发现它的）。查不到的 slug 用 `slug:<slug>` 兜底，
  // 与老资产 asset.json 缺 id 时的派生规则一致。
  const needsRekey = stored.schemaVersion < SCENE_SCHEMA_VERSION;
  const rekey = <T>(table: Record<string, T>): Record<string, T> => {
    if (!needsRekey) return table;
    const next: Record<string, T> = {};
    for (const [slug, value] of Object.entries(table)) {
      next[assetIdsBySlug.get(slug) ?? `slug:${slug}`] = value;
    }
    return next;
  };
  return SceneLayoutSchema.parse({
    ...stored,
    schemaVersion: SCENE_SCHEMA_VERSION,
    transforms: rekey(stored.transforms),
    materials: rekey(stored.materials),
    // v1 → v2 补的字段：0 = 迁移自无版本号的旧文档
    revision: stored.revision ?? 0,
  });
}

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

/**
 * 这份侧写还能凭 `resume-generation` 接续吗？已提交（有 providerTaskId）但没跑完的、
 * 以及超时/中断写成 failed 的，都可以只轮询 + 下载，不重新提交付费请求。
 *
 * 判断必须和 `listResumableSidecars` 一致：2026-09-26 出过一次「repair-assets 什么
 * 也没说，于是把供应商侧早已完成的任务又提交了一遍」的双重付费，两处共用这一个谓词。
 */
export function isResumableSidecar(sidecar: RequestSidecar): boolean {
  const hasProviderTaskId = Boolean(sidecar.providerTaskId);
  return (
    sidecar.status === "queued" ||
    sidecar.status === "running" ||
    (sidecar.status === "failed" && hasProviderTaskId)
  );
}
