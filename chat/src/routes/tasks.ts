import { Hono } from "hono";
import { z } from "zod";
import { config, withServerCredentials } from "../config";
import {
  Start3dBatchRequestSchema,
  StartWorldTaskRequestSchema,
} from "../dto/tasks";
import { LogicalPathSchema, SlugSchema } from "../dto/library";
import {
  listResumableSidecars,
  resumeGeneration,
} from "../mastra/tools/resumeGeneration";
import { startSeed3d3dBatch } from "../mastra/tools/seed3dOps";
import { startTripo3dBatch } from "../mastra/tools/tripoOps";
import { startArk3dBatch } from "../mastra/tools/ark3dOps";
import { getAssetStorage } from "../services/assetStorage";
import {
  listTasks,
  getTask,
  resolve3dObjects,
  startCustomTask,
  startWorldTask,
} from "../services/tasks";

export const taskRoutes = new Hono();

taskRoutes.post("/3d", async (c) => {
  const req = Start3dBatchRequestSchema.parse(withServerCredentials(await c.req.json()));
  const objects = await resolve3dObjects(req.projectSlug, req.assetSlugs);
  const tasks = req.provider === "tripo-direct"
    ? startTripo3dBatch(req.projectSlug, objects, {
      tripo3dApiKey: req.tripo3dApiKey!,
      imageModel: config.tripo.imageModel,
      generationMode: req.tripoGenerationMode,
    })
    : req.provider === "hyper3d-volc" || req.provider === "hi3d-volc"
      ? startArk3dBatch(req.provider, req.projectSlug, objects, {
        apiKey: req.volcengineApiKey!,
        faceCount: req.faceCount,
        taPose: req.taPose,
        resolution: req.resolution,
      })
      : startSeed3d3dBatch(req.projectSlug, objects, {
        seed3dApiKey: req.seed3dApiKey ?? req.volcengineApiKey!,
        subdivisionLevel: req.subdivisionLevel,
      });
  return c.json({ tasks }, 202);
});

taskRoutes.post("/world", async (c) => {
  const req = StartWorldTaskRequestSchema.parse(withServerCredentials(await c.req.json()));
  const task = startWorldTask(req.projectSlug, {
    worldLabsApiKey: req.worldLabsApiKey,
    ...(req.mode === "direct"
      ? { mode: "direct" as const, sourceImage: req.sourceImage, prompt: req.prompt }
      : { mode: "empty-environment" as const, sourceImage: req.sourceImage, extraPrompt: req.extraPrompt }),
  });
  return c.json({ task }, 202);
});

taskRoutes.get("/", async (c) => {
  const project = c.req.query("project");
  const projectSlug = project ? SlugSchema.parse(project) : undefined;
  return c.json({ tasks: await listTasks(projectSlug) });
});

const RetryTaskRequestSchema = z.object({
  projectSlug: SlugSchema,
  tripo3dApiKey: z.string().min(1).optional(),
  seed3dApiKey: z.string().min(1).optional(),
  volcengineApiKey: z.string().min(1).optional(),
});

/** 失败任务重试：只允许当前启用的火山和 Tripo3D 渠道。 */
taskRoutes.post("/:taskId/retry", async (c) => {
  const req = RetryTaskRequestSchema.parse(withServerCredentials(await c.req.json()));
  const previous = await getTask(req.projectSlug, c.req.param("taskId"));
  if (!previous?.retry || previous.status !== "failed") {
    return c.json(
      { error: { code: "task_not_retryable", message: "该任务不存在、未失败或不可重试" } },
      409,
    );
  }
  const retry = previous.retry;
  const object = {
    slug: retry.assetSlug,
    name: retry.name,
    intent: retry.intent,
    sourceImages: retry.sourceImages,
    ...(retry.referenceViews ? { referenceViews: retry.referenceViews } : {}),
  };
  const options = retry.options;
  /** 重试必须复用原任务的模型 ID，否则用户选定的模型会被渠道默认值悄悄换掉。 */
  const pinnedModel = typeof options.model === "string" && options.model ? options.model : undefined;
  const provider = retry.provider;
  if (provider !== "tripo-direct" && provider !== "seed3d-direct" &&
      provider !== "hyper3d-volc" && provider !== "hi3d-volc") {
    return c.json({ error: { code: "provider_unsupported", message: "该历史任务的供应商已停用" } }, 409);
  }
  const retried =
    provider === "tripo-direct"
      ? startTripo3dBatch(req.projectSlug, [object], {
          tripo3dApiKey: req.tripo3dApiKey ?? "",
          imageModel: pinnedModel ?? config.tripo.imageModel,
          generationMode:
            options.generationMode === "single" || options.generationMode === "multiview"
              ? options.generationMode
              : "auto",
        })
      : provider === "hyper3d-volc" || provider === "hi3d-volc"
        ? startArk3dBatch(provider, req.projectSlug, [object], {
          apiKey: req.volcengineApiKey ?? "",
          faceCount: typeof options.faceCount === "number" ? options.faceCount : undefined,
          taPose: options.taPose === true,
          resolution: options.resolution === "1536pro" ? "1536pro" : "1536",
          model: pinnedModel,
        })
        : startSeed3d3dBatch(req.projectSlug, [object], {
                seed3dApiKey: req.seed3dApiKey ?? req.volcengineApiKey ?? "",
                model: pinnedModel,
                subdivisionLevel:
                  options.subdivisionLevel === "high" ||
                  options.subdivisionLevel === "medium" ||
                  options.subdivisionLevel === "low"
                    ? options.subdivisionLevel
                    : undefined,
                fileFormat:
                  options.fileFormat === "glb" ||
                  options.fileFormat === "obj" ||
                  options.fileFormat === "usd" ||
                  options.fileFormat === "usdz"
                    ? options.fileFormat
                    : undefined,
              });
  return c.json({ task: retried[0] }, 202);
});

const ResumeTaskRequestSchema = z.object({
  projectSlug: SlugSchema,
  sidecarPath: LogicalPathSchema,
  worldLabsApiKey: z.string().min(1).optional(),
  tripo3dApiKey: z.string().min(1).optional(),
  seed3dApiKey: z.string().min(1).optional(),
});

/** 凭侧写续跑（不重新提交）：任务化 202 */
taskRoutes.post("/resume", async (c) => {
  const req = ResumeTaskRequestSchema.parse(withServerCredentials(await c.req.json()));
  const task = startCustomTask(
    "resume",
    req.projectSlug,
    `续跑：${req.sidecarPath.split("/").pop()}`,
    () =>
      resumeGeneration(getAssetStorage(), req.sidecarPath, {
        worldLabsApiKey: req.worldLabsApiKey,
        tripo3dApiKey: req.tripo3dApiKey,
        seed3dApiKey: req.seed3dApiKey,
      }),
  );
  return c.json({ task }, 202);
});

/** 项目里可续跑的侧写清单（queued/running） */
taskRoutes.get("/resumable/:slug", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  return c.json({
    resumable: await listResumableSidecars(getAssetStorage(), slug),
  });
});
