import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ObjectCandidateSchema, SlugSchema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import {
  listSceneJobs,
  readSceneJob,
  retrySceneJobNodes,
  reviseSceneSpecAndJob,
} from "../../services/sceneJobs";
import {
  createAndStartSceneJob,
  resumeSceneJob,
} from "../../services/sceneJobRunner";
import type { RunKeys } from "../../services/workflowRuns";
import { runConfirmReferenceAssets } from "./referenceAnalysis";
import { optionalContextString, requireCurrentProject } from "./requestContext";

function runKeys(context: Parameters<typeof optionalContextString>[0]): RunKeys {
  return {
    volcengineApiKey: optionalContextString(context, "volcengineApiKey"),
    seed3dApiKey: optionalContextString(context, "seed3dApiKey"),
    worldLabsApiKey: optionalContextString(context, "worldLabsApiKey"),
  };
}

const taskSummary = (task: { id: string; subject: string; status: string }) => ({
  id: task.id,
  subject: task.subject,
  status: task.status,
});

export const startSceneJobTool = createTool({
  id: "start-scene-job",
  description:
    "用户已确认 analyze-reference 的对象并授权整体付费生成后调用。它会确认本次 run，创建可修订 SceneSpec 和持久化 SceneJob，再并行调度「参考图→模型」与「干净底板→世界」两条分支。正常启动只调用一次；同一 run 在中断后重调会复用原任务，不会另建一套。",
  inputSchema: z.object({
    runId: z.uuid(),
    selectedSlugs: z.array(SlugSchema).min(1).optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    await runConfirmReferenceAssets(projectSlug, input);
    const { job, task } = await createAndStartSceneJob(projectSlug, runKeys(context));
    return {
      job: { id: job.id, specRevision: job.specRevision, status: job.status },
      task: taskSummary(task),
    };
  },
});

export const reviseSceneJobTool = createTool({
  id: "revise-scene-job",
  description:
    "修订已存在的完整场景：新增遗漏家具、删除误识别对象或修改对象描述。系统只会失效受影响节点：新家具生成新参考图/模型，底板和世界重建，已正确的其他模型保留。修订可能产生额外费用，必须先得到用户同意。",
  inputSchema: z.object({
    jobId: z.uuid(),
    addObjects: z.array(ObjectCandidateSchema).default([]),
    removeSlugs: z.array(SlugSchema).default([]),
    updateObjects: z.array(ObjectCandidateSchema).default([]),
    reason: z.string().min(1),
    resume: z.boolean().default(true),
  }),
  execute: async ({ jobId, resume, ...revision }, context) => {
    const projectSlug = requireCurrentProject(context);
    const result = await reviseSceneSpecAndJob(getAssetStorage(), projectSlug, jobId, revision);
    const task = resume ? await resumeSceneJob(projectSlug, jobId, runKeys(context)) : undefined;
    return {
      job: { id: result.job.id, specRevision: result.spec.revision, status: result.job.status },
      ...(task ? { task: taskSummary(task) } : {}),
    };
  },
});

export const retrySceneJobNodesTool = createTool({
  id: "retry-scene-job-nodes",
  description:
    "对完整场景的指定失败/质量不合格节点做局部重建，并自动标记它的下游过期。例如底板不干净时传 nodes=[\"plate\"]，只会重做底板和 world；重新付费生成前必须先得到用户同意。",
  inputSchema: z.object({
    jobId: z.uuid(),
    nodes: z.array(z.string().min(1)).min(1),
    resume: z.boolean().default(true),
  }),
  execute: async ({ jobId, nodes, resume }, context) => {
    const projectSlug = requireCurrentProject(context);
    const job = await retrySceneJobNodes(getAssetStorage(), projectSlug, jobId, nodes);
    const task = resume ? await resumeSceneJob(projectSlug, jobId, runKeys(context)) : undefined;
    return {
      job: { id: job.id, specRevision: job.specRevision, status: job.status },
      ...(task ? { task: taskSummary(task) } : {}),
    };
  },
});

export const getSceneJobTool = createTool({
  id: "get-scene-job",
  description: "读取当前项目某个完整场景任务的节点、过期状态、尝试次数和输出；省略 jobId 时返回最新任务。",
  inputSchema: z.object({ jobId: z.uuid().optional() }),
  execute: async ({ jobId }, context) => {
    const projectSlug = requireCurrentProject(context);
    const storage = getAssetStorage();
    const job = jobId
      ? await readSceneJob(storage, projectSlug, jobId)
      : (await listSceneJobs(storage, projectSlug))[0];
    return { job: job ?? null };
  },
});
