import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { LogicalPathSchema, SlugSchema } from "../../dto/library";
import { THREE_D_PROVIDER_IDS } from "../../models/threeD";
import {
  listTasks,
  resolve3dObjects,
  startWorldTask,
} from "../../services/tasks";
import {
  currentThreeDModel,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import { startSeed3d3dBatch } from "./seed3dOps";
import { startTripo3dBatch } from "./tripoOps";
import { startArk3dBatch } from "./ark3dOps";

/** creator agent 的生成任务工具：启动即返回任务 id，不阻塞对话流 */

export type WorldSourceMode = "latest" | "text-only" | "explicit-path";

/**
 * 工具调用里的可选字符串偶尔会被模型编码成 `__OMIT__`。它不是资产路径；旧调用
 * 没有 sourceMode 时，把它按真正的“省略”处理。新调用以 sourceMode 为唯一语义，
 * 因而 latest/text-only 即使夹带了占位值也不会误读文件。
 */
export function resolveWorldSourceImage(input: {
  sourceMode?: WorldSourceMode;
  sourceImage?: string | null;
}): string | null | undefined {
  const legacyOmitted = input.sourceImage === "__OMIT__";
  const sourceMode = input.sourceMode ?? (
    input.sourceImage === null
      ? "text-only"
      : input.sourceImage === undefined || legacyOmitted
        ? "latest"
        : "explicit-path"
  );

  if (sourceMode === "latest") return undefined;
  if (sourceMode === "text-only") return null;
  if (!input.sourceImage || legacyOmitted) {
    throw new ChatServiceError(
      "sourceMode=explicit-path 时必须提供真实的 sourceImage 逻辑路径",
      400,
      "world_source_image_missing",
    );
  }
  return input.sourceImage;
}

/** 整批统一的生成选项（与 dto/tasks.ts 的 HTTP 契约对齐） */
export const Batch3dOptionsSchema = z.object({
  assetSlugs: z.array(SlugSchema).optional(),
  provider: z.enum(THREE_D_PROVIDER_IDS).default("seed3d-direct"),
  faceCount: z.number().int().min(500).max(2000000).optional(),
  taPose: z.boolean().optional(),
  resolution: z.enum(["1536", "1536pro"]).optional(),
  /** seed3d-direct：面数走档位而非精确值（high=100 万 / medium=50 万 / low=10 万） */
  subdivisionLevel: z.enum(["high", "medium", "low"]).optional(),
  /** Tripo：auto 会在资产带有 front + 至少另一视角时自动切换多视角生成。 */
  tripoGenerationMode: z.enum(["auto", "single", "multiview"]).default("auto"),
});

export const start3dBatchTool = createTool({
  id: "start-3d-batch",
  description:
    "为当前项目的对象并行生成 3D 模型。可选火山方舟 Seed3D（默认）、Hyper3D Gen-2、数美 Hi3D 2.0，或 Tripo3D；付费启动前须经用户同意。用户在下拉框选定具体 3D 模型时，渠道与模型 ID 由服务端按该选择钉住，provider 参数会被忽略。Tripo 的 tripoGenerationMode=auto 会对带视角标记的参考图自动使用多视角生成，也可指定 single/multiview。Hi3D 使用 Seedream 生成或编辑的参考图 URL。返回任务 id，用 list-generation-tasks 跟进。",
  inputSchema: Batch3dOptionsSchema,
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const { assetSlugs, provider: requestedProvider, ...options } = input;
    /** 用户选定的具体模型优先于 agent 的判断；未选择（Auto）才用请求里的 provider。 */
    const pinned = currentThreeDModel(context);
    const provider = pinned?.provider ?? requestedProvider;
    const model = pinned?.model;
    const objects = await resolve3dObjects(projectSlug, assetSlugs);
    if (provider === "tripo-direct") {
      const tripo3dApiKey = requireContextString(
        context,
        "tripo3dApiKey",
        "本机 chat/.env 未配置 TRIPO_KEY",
      );
      const tasks = startTripo3dBatch(projectSlug, objects, {
        tripo3dApiKey,
        generationMode: options.tripoGenerationMode,
        imageModel: model,
      });
      return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
    }
    if (provider === "hyper3d-volc" || provider === "hi3d-volc") {
      const apiKey = requireContextString(
        context,
        "volcengineApiKey",
        "本机 chat/.env 未配置 VOLC_KEY",
      );
      const tasks = startArk3dBatch(provider, projectSlug, objects, {
        apiKey,
        faceCount: options.faceCount,
        taPose: options.taPose,
        resolution: options.resolution,
        model,
      });
      return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
    }
    const seed3dApiKey = requireContextString(
      context,
      "seed3dApiKey",
      "本机 chat/.env 未配置 VOLC_KEY",
    );
    const tasks = startSeed3d3dBatch(projectSlug, objects, {
      seed3dApiKey,
      subdivisionLevel: options.subdivisionLevel,
      model,
    });
    return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
  },
});

export const startWorldTaskTool = createTool({
  id: "start-world-task",
  description:
    "为当前项目启动 World Labs 场景生成任务（付费操作——启动前须经用户同意）。mode=direct 直接生成世界，不需要图片分析；mode=empty-environment 根据已确认的场景分析去除物体。用 sourceMode 明确选择图片来源：latest 使用最新源图，text-only 不使用图片，explicit-path 使用 sourceImage 指定的逻辑路径。sourceMode 仅为兼容旧调用而允许省略，新调用必须传。",
  inputSchema: z.object({
    mode: z.enum(["direct", "empty-environment"]),
    sourceMode: z.enum(["latest", "text-only", "explicit-path"]).optional(),
    sourceImage: LogicalPathSchema.nullable().optional(),
    prompt: z.string().optional(),
    extraPrompt: z.string().optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const worldLabsApiKey = requireContextString(
      context,
      "worldLabsApiKey",
      "本机 chat/.env 未配置 WORLDLABS_KEY",
    );
    const sourceImage = resolveWorldSourceImage(input);
    const task = startWorldTask(projectSlug, input.mode === "direct"
      ? { worldLabsApiKey, mode: input.mode, sourceImage, prompt: input.prompt }
      : { worldLabsApiKey, mode: input.mode, sourceImage, extraPrompt: input.extraPrompt });
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

export const listGenerationTasksTool = createTool({
  id: "list-generation-tasks",
  description: "查看当前项目的生成任务状态（running / succeeded / failed）与产物路径",
  inputSchema: z.object({}),
  execute: async (_input, context) => ({
    tasks: (await listTasks(requireCurrentProject(context))).map(
      ({ id, subject, status, error, result }) => ({
        id,
        subject,
        status,
        error,
        result,
      }),
    ),
  }),
});
