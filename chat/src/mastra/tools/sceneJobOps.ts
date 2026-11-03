import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { ObjectCandidateSchema, SlugSchema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import {
  resolveCurrentSceneJob,
  retrySceneJobNodes,
  reviseSceneSpecAndJob,
} from "../../services/sceneJobs";
import {
  createAndStartSceneJob,
  resumeSceneJob,
} from "../../services/sceneJobRunner";
import type { RunKeys } from "../../services/workflowRuns";
import { runConfirmReferenceAssets } from "./referenceAnalysis";
import {
  conversationImagePaths,
  currentImagePaths,
  currentSessionStartedAt,
  currentThreeDModelSelection,
  optionalContextString,
  requireCurrentProject,
} from "./requestContext";

function runKeys(context: Parameters<typeof optionalContextString>[0]): RunKeys {
  return {
    volcengineApiKey: optionalContextString(context, "volcengineApiKey"),
    tripo3dApiKey: optionalContextString(context, "tripo3dApiKey"),
    threeDModel: currentThreeDModelSelection(context),
    worldLabsApiKey: optionalContextString(context, "worldLabsApiKey"),
  };
}

/**
 * 解析这次要操作的 SceneJob。jobId 只是可选指向手段（同 runId 的道理：
 * 让模型保管不透明 UUID，跨会话一定丢），解析由服务端从项目状态完成。
 */
async function requireSceneJob(
  projectSlug: string,
  jobId: string | undefined,
  action: string,
) {
  const job = await resolveCurrentSceneJob(getAssetStorage(), projectSlug, jobId);
  if (!job) {
    throw new ChatServiceError(
      `This project has no complete-scene task to ${action}; start one with start-scene-job first`,
      404,
      "scene_job_not_found",
    );
  }
  return job;
}

const taskSummary = (task: { id: string; subject: string; status: string }) => ({
  id: task.id,
  subject: task.subject,
  status: task.status,
});

export const startSceneJobTool = createTool({
  id: "start-scene-job",
  description:
    "Call this after the user has confirmed the analyze-reference objects and authorized the overall paid generation. It confirms this run, creates a revisable SceneSpec and a persistent SceneJob, then schedules the two branches \"reference image → model\" and \"clean plate → world\" in parallel, and finally places every piece of furniture back into its 3D position from the reference image (placement is free and does not ask for consent again). Call it only once for a normal start; calling it again for the same run after an interruption reuses the original task and does not create a second one. **runId is optional**: pass the one analyze-reference returned if you still have it, but omit it when unsure — the server finds the pending analysis by itself (the project's pending one, the one matching the reference image in this conversation, or the analysis already confirmed for this project). Never invent or retype a runId placeholder.",
  inputSchema: z.object({
    /*
      这里刻意不是 z.uuid()：模型丢过上下文后最常见的动作就是"补一个占位 UUID"，
      而 zod 的 uuid 校验按设计接受全零 UUID。它只是消歧参数，服务端自己有能力解析，
      所以任何形状的 runId 都收下、由 normalizeRunId 归一（见 referenceAnalysis.ts）。
    */
    runId: z.string().max(64).optional(),
    selectedSlugs: z.array(SlugSchema).min(1).optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const confirmation = await runConfirmReferenceAssets(projectSlug, input, {
      imagePaths: currentImagePaths(context),
      conversationImagePaths: conversationImagePaths(context),
      sessionStartedAt: currentSessionStartedAt(context),
    });
    const { job, task } = await createAndStartSceneJob(projectSlug, runKeys(context));
    return {
      job: { id: job.id, specRevision: job.specRevision, status: job.status },
      task: taskSummary(task),
      /*
        复用是合法结果（中断重试 / 新会话丢了 runId），但必须是**可见**的：
        Agent 才知道自己启动的是项目里已有的那份确认，而不是刚分析的那一份。
      */
      ...(confirmation.reused
        ? {
            reusedPreviousAnalysis: {
              runId: confirmation.reused.runId,
              analyzedAt: confirmation.reused.analyzedAt,
              note:
                "No new pending reference image analysis was found, so this project's already confirmed scene analysis was reused " +
                "(this is the normal path when a previous start was interrupted). If the user asked for a different scene, call analyze-reference on that image first.",
            },
          }
        : {}),
    };
  },
});

export const reviseSceneJobTool = createTool({
  id: "revise-scene-job",
  description:
    "Revise an existing complete scene: add missed furniture, remove misidentified objects, or change object descriptions. The system invalidates only the affected nodes: new furniture gets a new reference image/model, the plate, world, and placement are rebuilt, and the other already-correct models are kept. Revisions can incur extra costs and must be approved by the user first. **jobId is optional** — omit it and the server revises the project's current scene task; do not guess a UUID.",
  inputSchema: z.object({
    jobId: z.string().max(64).optional(),
    addObjects: z.array(ObjectCandidateSchema).default([]),
    removeSlugs: z.array(SlugSchema).default([]),
    updateObjects: z.array(ObjectCandidateSchema).default([]),
    reason: z.string().min(1),
    resume: z.boolean().default(true),
  }),
  execute: async ({ jobId, resume, ...revision }, context) => {
    const projectSlug = requireCurrentProject(context);
    const storage = getAssetStorage();
    const target = await requireSceneJob(projectSlug, jobId, "revise");
    const result = await reviseSceneSpecAndJob(storage, projectSlug, target.id, revision);
    const task = resume ? await resumeSceneJob(projectSlug, target.id, runKeys(context)) : undefined;
    return {
      job: { id: result.job.id, specRevision: result.spec.revision, status: result.job.status },
      ...(task ? { task: taskSummary(task) } : {}),
    };
  },
});

export const retrySceneJobNodesTool = createTool({
  id: "retry-scene-job-nodes",
  description:
    "Locally rebuild the specified failed/low-quality nodes of a complete scene and automatically mark their downstream nodes stale. For example, when the plate is not clean, pass nodes=[\"plate\"] and only the plate, world, and placement are redone (placement is free); get the user's consent before re-running any paid generation. **jobId is optional** — omit it and the server uses the project's current scene task.",
  inputSchema: z.object({
    jobId: z.string().max(64).optional(),
    nodes: z.array(z.string().min(1)).min(1),
    resume: z.boolean().default(true),
  }),
  execute: async ({ jobId, nodes, resume }, context) => {
    const projectSlug = requireCurrentProject(context);
    const target = await requireSceneJob(projectSlug, jobId, "rebuild");
    const job = await retrySceneJobNodes(getAssetStorage(), projectSlug, target.id, nodes);
    const task = resume ? await resumeSceneJob(projectSlug, target.id, runKeys(context)) : undefined;
    return {
      job: { id: job.id, specRevision: job.specRevision, status: job.status },
      ...(task ? { task: taskSummary(task) } : {}),
    };
  },
});

export const getSceneJobTool = createTool({
  id: "get-scene-job",
  description: "Read the nodes, staleness state, attempt counts, and outputs of a complete-scene task in the current project; omitting jobId returns the task of the current scene spec (or the latest one).",
  inputSchema: z.object({ jobId: z.string().max(64).optional() }),
  execute: async ({ jobId }, context) => {
    const projectSlug = requireCurrentProject(context);
    const job = await resolveCurrentSceneJob(getAssetStorage(), projectSlug, jobId);
    return { job: job ?? null };
  },
});
