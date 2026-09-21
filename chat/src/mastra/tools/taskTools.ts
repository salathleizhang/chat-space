import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { LogicalPathSchema, SlugSchema } from "../../dto/library";
import {
  listTasks,
  resolve3dObjects,
  startWorldTask,
} from "../../services/tasks";
import {
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import { startSeed3d3dBatch } from "./seed3dOps";
import { startTripo3dBatch } from "./tripoOps";
import { startArk3dBatch } from "./ark3dOps";

/** creator agent 的生成任务工具：启动即返回任务 id，不阻塞对话流 */

/** 整批统一的生成选项（与 dto/tasks.ts 的 HTTP 契约对齐） */
export const Batch3dOptionsSchema = z.object({
  assetSlugs: z.array(SlugSchema).optional(),
  provider: z.enum(["seed3d-direct", "hyper3d-volc", "hi3d-volc", "tripo-direct"]).default("seed3d-direct"),
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
    "为当前项目的对象并行生成 3D 模型。可选火山方舟 Seed3D（默认）、Hyper3D Gen-2、数美 Hi3D 2.0，或 Tripo3D；付费启动前须经用户同意。Tripo 的 tripoGenerationMode=auto 会对带视角标记的参考图自动使用多视角生成，也可指定 single/multiview。Hi3D 使用 Seedream 生成或编辑的参考图 URL。返回任务 id，用 list-generation-tasks 跟进。",
  inputSchema: Batch3dOptionsSchema,
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const { assetSlugs, provider, ...options } = input;
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
    });
    return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
  },
});

export const startWorldTaskTool = createTool({
  id: "start-world-task",
  description:
    "为当前项目启动 World Labs 场景生成任务（付费操作——启动前须经用户同意）。mode=direct 直接用源图和可选 prompt 生成世界，不需要图片分析；mode=empty-environment 根据已确认的场景分析去除物体，生成空环境。sourceImage 省略时使用最新源图，设为 null 时只用文字。",
  inputSchema: z.object({
    mode: z.enum(["direct", "empty-environment"]),
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
    const task = startWorldTask(projectSlug, input.mode === "direct"
      ? { worldLabsApiKey, mode: input.mode, sourceImage: input.sourceImage, prompt: input.prompt }
      : { worldLabsApiKey, mode: input.mode, sourceImage: input.sourceImage, extraPrompt: input.extraPrompt });
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
