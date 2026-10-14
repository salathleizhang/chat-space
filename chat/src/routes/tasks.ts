import { Hono } from "hono";
import { z } from "zod";
import { config, withServerCredentials } from "../config";
import {
  Start3dBatchRequestSchema,
  StartWorldTaskRequestSchema,
} from "../dto/tasks";
import { LogicalPathSchema, SlugSchema } from "../dto/library";
import { listResumableSidecars } from "../mastra/tools/resumeGeneration";
import { startTripo3dBatch } from "../mastra/tools/tripoOps";
import { getAssetStorage } from "../services/assetStorage";
import {
  listTasks,
  getTask,
  resolve3dObjects,
  startCustomTask,
  startResumeTask,
  startWorldTask,
} from "../services/tasks";

export const taskRoutes = new Hono();

taskRoutes.post("/3d", async (c) => {
  const req = Start3dBatchRequestSchema.parse(withServerCredentials(await c.req.json()));
  const objects = await resolve3dObjects(req.projectSlug, req.assetSlugs);
  const tasks = startTripo3dBatch(req.projectSlug, objects, {
    tripo3dApiKey: req.tripo3dApiKey!, imageModel: config.tripo.imageModel,
    generationMode: req.tripoGenerationMode,
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
});

/** 失败任务重试：只允许当前启用的 Tripo3D 渠道。 */
taskRoutes.post("/:taskId/retry", async (c) => {
  const req = RetryTaskRequestSchema.parse(withServerCredentials(await c.req.json()));
  const previous = await getTask(req.projectSlug, c.req.param("taskId"));
  if (!previous?.retry || previous.status !== "failed") {
    return c.json(
      { error: { code: "task_not_retryable", message: "This task does not exist, has not failed, or is not retryable" } },
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
  if (provider !== "tripo-direct") {
    return c.json({ error: { code: "provider_unsupported", message: "This model provider is disabled; only Tripo3D is enabled" } }, 409);
  }
  const retried = startTripo3dBatch(req.projectSlug, [object], {
    tripo3dApiKey: req.tripo3dApiKey ?? "",
    imageModel: typeof options.imageModel === "string" ? options.imageModel : pinnedModel ?? config.tripo.imageModel,
    generationMode: options.generationMode === "single" || options.generationMode === "multiview" ? options.generationMode : "auto",
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

/**
 * 凭侧写续跑（不重新提交）：任务化 202。
 * 与「重启自动续跑」共用 `startResumeTask`——两条入口的凭证来源、判重字段、阶段推进
 * 必须是同一份，否则自动续跑会变成没人测过的第二条实现。
 */
taskRoutes.post("/resume", async (c) => {
  const req = ResumeTaskRequestSchema.parse(withServerCredentials(await c.req.json()));
  const task = startResumeTask(req.projectSlug, req.sidecarPath);
  return c.json({ task }, 202);
});

/** 项目里可续跑的侧写清单（queued/running） */
taskRoutes.get("/resumable/:slug", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  return c.json({
    resumable: await listResumableSidecars(getAssetStorage(), slug),
  });
});
