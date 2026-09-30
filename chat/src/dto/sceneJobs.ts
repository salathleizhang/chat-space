import { z } from "zod";
import {
  CameraEstimateSchema,
  LogicalPathSchema,
  ObjectCandidateSchema,
  SlugSchema,
} from "./library";

/**
 * 可修订的场景事实。analysis.json 是一次视觉分析的确认结果；
 * SceneSpec 则是生成期间可以补充遗漏家具、修正描述的当前事实。
 */
export const SceneSpecObjectSchema = ObjectCandidateSchema.extend({
  origin: z.enum(["analysis", "added"]),
  addedAtRevision: z.number().int().positive(),
});
export type SceneSpecObject = z.infer<typeof SceneSpecObjectSchema>;

export const SceneSpecSchema = z.object({
  schemaVersion: z.literal(1),
  projectSlug: SlugSchema,
  revision: z.number().int().positive(),
  revisionReason: z.string().min(1),
  sourceImage: LogicalPathSchema,
  sourceAnalysisRunId: z.uuid().optional(),
  sceneName: z.string().min(1),
  sceneDescription: z.string().min(1),
  environment: z.object({
    lighting: z.string(),
    mood: z.string(),
    spatialLayout: z.string(),
  }).partial(),
  objects: z.array(SceneSpecObjectSchema).min(1),
  /** 拍摄源图的相机估计；摆放节点用它把每个对象的归一化框反投影成 3D 摆放。 */
  camera: CameraEstimateSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SceneSpec = z.infer<typeof SceneSpecSchema>;

export const SceneJobNodeKindSchema = z.enum([
  "reference",
  "model",
  "plate",
  "world",
  /** 按参考图把全部模型摆回 3D 世界（免费、确定性），写完 scene.json 的 transforms。 */
  "placement",
  "final-review",
]);
export type SceneJobNodeKind = z.infer<typeof SceneJobNodeKindSchema>;

export const SceneJobNodeStatusSchema = z.enum([
  "pending",
  "blocked",
  "running",
  "succeeded",
  "failed",
  "stale",
  "waiting_for_review",
  "obsolete",
]);
export type SceneJobNodeStatus = z.infer<typeof SceneJobNodeStatusSchema>;

export const SceneJobQaSchema = z.object({
  decision: z.enum(["accepted", "repair", "regenerate", "user_review"]),
  score: z.number().min(0).max(100).optional(),
  issues: z.array(z.string().min(1)).default([]),
  issueOwner: z.enum(["reference", "model", "plate", "world", "scene-spec"]).optional(),
  suggestedAction: z.string().min(1).optional(),
  checkedAt: z.iso.datetime(),
});
export type SceneJobQa = z.infer<typeof SceneJobQaSchema>;

export const SceneJobNodeSchema = z.object({
  id: z.string().min(1),
  kind: SceneJobNodeKindSchema,
  objectSlug: SlugSchema.optional(),
  dependsOn: z.array(z.string().min(1)),
  status: SceneJobNodeStatusSchema,
  inputFingerprint: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  outputs: z.array(LogicalPathSchema),
  taskIds: z.array(z.string().min(1)),
  qa: SceneJobQaSchema.optional(),
  error: z.string().optional(),
  updatedAt: z.iso.datetime(),
});
export type SceneJobNode = z.infer<typeof SceneJobNodeSchema>;

export const SceneJobStatusSchema = z.enum([
  "running",
  "paused",
  "waiting_for_user",
  "succeeded",
  "failed",
]);
export type SceneJobStatus = z.infer<typeof SceneJobStatusSchema>;

export const SceneJobSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  projectSlug: SlugSchema,
  specRevision: z.number().int().positive(),
  status: SceneJobStatusSchema,
  /** 不含任何密钥；重启后要由 resume 请求重新注入本机凭证。 */
  parentTaskId: z.string().optional(),
  nodes: z.record(z.string(), SceneJobNodeSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SceneJob = z.infer<typeof SceneJobSchema>;

export const SceneSpecRevisionInputSchema = z.object({
  addObjects: z.array(ObjectCandidateSchema).default([]),
  removeSlugs: z.array(SlugSchema).default([]),
  updateObjects: z.array(ObjectCandidateSchema).default([]),
  reason: z.string().min(1),
}).refine(
  (value) => value.addObjects.length + value.removeSlugs.length + value.updateObjects.length > 0,
  { message: "至少需要新增、删除或修改一个场景对象" },
);
export type SceneSpecRevisionInput = z.input<typeof SceneSpecRevisionInputSchema>;
