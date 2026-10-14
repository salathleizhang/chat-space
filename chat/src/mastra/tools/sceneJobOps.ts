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
import { currentThreeDModelSelection, optionalContextString, requireCurrentProject } from "./requestContext";

function runKeys(context: Parameters<typeof optionalContextString>[0]): RunKeys {
  return {
    volcengineApiKey: optionalContextString(context, "volcengineApiKey"),
    tripo3dApiKey: optionalContextString(context, "tripo3dApiKey"),
    threeDModel: currentThreeDModelSelection(context),
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
    "Call this after the user has confirmed the analyze-reference objects and authorized the overall paid generation. It confirms this run, creates a revisable SceneSpec and a persistent SceneJob, then schedules the two branches \"reference image → model\" and \"clean plate → world\" in parallel, and finally places every piece of furniture back into its 3D position from the reference image (placement is free and does not ask for consent again). Call it only once for a normal start; calling it again for the same run after an interruption reuses the original task and does not create a second one.",
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
    "Revise an existing complete scene: add missed furniture, remove misidentified objects, or change object descriptions. The system invalidates only the affected nodes: new furniture gets a new reference image/model, the plate, world, and placement are rebuilt, and the other already-correct models are kept. Revisions can incur extra costs and must be approved by the user first.",
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
    "Locally rebuild the specified failed/low-quality nodes of a complete scene and automatically mark their downstream nodes stale. For example, when the plate is not clean, pass nodes=[\"plate\"] and only the plate, world, and placement are redone (placement is free); get the user's consent before re-running any paid generation.",
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
  description: "Read the nodes, staleness state, attempt counts, and outputs of a complete-scene task in the current project; omitting jobId returns the latest task.",
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
