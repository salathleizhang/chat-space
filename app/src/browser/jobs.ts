import { projectTaskFile } from "../../../chat/src/common/libraryPaths";
import { CloudTaskPending, withCloudContext, type CloudContext, type CloudOperation } from "../../../chat/src/cloud/context";
import { executeCloudOperation } from "../../../chat/src/cloud/operations";
import { GenerationTaskSchema, type GenerationTask } from "../../../chat/src/dto/tasks";
import { RequestSidecarSchema } from "../../../chat/src/dto/library";
import { serverResumeKeys } from "./config";
import { resumeGeneration } from "../../../chat/src/mastra/tools/resumeGeneration";
import { withAssetStorage, readJson, writeJson } from "../../../chat/src/services/assetStorage";
import { runWithTaskPump } from "../../../chat/src/common/taskPump";
import { BrowserAssetStorage } from "./storage";
export interface LocalJob { task: GenerationTask; descriptor: CloudOperation; started: boolean; receipts: string[]; nextAt: number; done?: boolean }
export const localJobPath = (id: string) => `.jobs/${id}.json`;
export function browserContext(storage: BrowserAssetStorage, ownJob?: LocalJob): CloudContext {
  return { workspace: "browser", pending: [], polling: true, activeTaskIds: async () => new Set((await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith("chatspace:job:")).map(lock => lock.name!.slice("chatspace:job:".length))),
    enqueue: async (task, descriptor) => {
      const job: LocalJob = { task, descriptor, started: false, receipts: [], nextAt: Date.now() };
      await storage.writeText(localJobPath(task.id), JSON.stringify(job));
      await writeJson(storage, projectTaskFile(task.projectSlug, task.id), GenerationTaskSchema, task);
    },
    onSidecar: async path => {
      if (!ownJob || ownJob.receipts.includes(path)) return;
      ownJob.receipts.push(path);
      await storage.writeText(localJobPath(ownJob.task.id), JSON.stringify(ownJob));
    },
  };
}
/** Browser clock drives one provider attempt; refresh resumes receipts, never submits twice. */
export async function runBrowserJob(id: string) {
  return navigator.locks.request(`chatspace:job:${id}`, { ifAvailable: true }, async lock => {
    if (!lock) return;
    const storage = new BrowserAssetStorage();
    const job = JSON.parse(await storage.readText(localJobPath(id))) as LocalJob;
    if (job.done || job.nextAt > Date.now()) return;
    let task = await readJson(storage, projectTaskFile(job.task.projectSlug, id), GenerationTaskSchema);
    const patch = async (changes: Partial<GenerationTask>) => {
      task = { ...task, ...changes, updatedAt: new Date().toISOString() };
      await writeJson(storage, projectTaskFile(task.projectSlug, id), GenerationTaskSchema, task);
    };
    const context = browserContext(storage, job);
    storage.onSidecar = context.onSidecar;
    const execution = { id, setPhase: (phase: GenerationTask["phase"]) => patch({ phase }), setAssetSlug: (assetSlug: string) => patch({ assetSlug }) };
    try {
      const result = await withAssetStorage(storage, () => withCloudContext(context, () => runWithTaskPump(id, task.projectSlug, async () => {
        if (Date.now() - Date.parse(task.createdAt) > 90 * 60_000) throw new Error("任务超过 90 分钟，请凭供应商回执续跑");
        if (!job.started) {
          // Commit before sending any paid request. A lost response requires manual recovery.
          job.started = true; await storage.writeText(localJobPath(id), JSON.stringify(job));
          return executeCloudOperation(task, job.descriptor, execution);
        }
        if (!job.receipts.length && !["scene-job", "resume"].includes(job.descriptor.operation)) {
          throw new Error("上次执行中断且没有供应商回执；为避免重复付费，没有重新提交。请核对供应商记录后重试");
        }
        let resumed: unknown;
        for (const path of job.receipts) {
          const receipt = await readJson(storage, path, RequestSidecarSchema);
          if (receipt.status !== "succeeded" && !receipt.providerTaskId) throw new Error("提交结果未知，未自动重发付费请求");
          resumed = await resumeGeneration(storage, path, serverResumeKeys(), execution.setPhase);
        }
        if (["scene-job", "resume"].includes(job.descriptor.operation)) return executeCloudOperation(task, job.descriptor, execution);
        const required: Record<string, string> = { segment: "v3/mesh/segment", rig: "/animations/rig", animation: "/animations/retarget", retopo: "/mesh/decimate", texture: "/models/texture", character: "/animations/rig" };
        if (required[job.descriptor.operation]) {
          const receipts = await Promise.all(job.receipts.map(path => readJson(storage, path, RequestSidecarSchema)));
          if (!receipts.some(receipt => receipt.model === required[job.descriptor.operation])) {
            if (job.descriptor.operation === "character") {
              const { runTripoRig } = await import("../../../chat/src/mastra/tools/tripoOps");
              return runTripoRig(storage, { projectSlug: task.projectSlug, assetSlug: String(job.descriptor.input.assetSlug), rigType: "biped",
                spec: job.descriptor.input.spec as never, model: job.descriptor.input.tripoRigModel as never },
                { apiKey: serverResumeKeys().tripo3dApiKey ?? "", onPhase: execution.setPhase });
            }
            return executeCloudOperation(task, job.descriptor, execution);
          }
        }
        return resumed;
      })));
      await Promise.all(context.pending);
      await patch({ status: "succeeded", phase: "completed", result, error: undefined });
      job.done = true;
    } catch (error) {
      await Promise.all(context.pending);
      if (error instanceof CloudTaskPending) { job.nextAt = Date.now() + error.delaySeconds * 1000; }
      else { await patch({ status: "failed", phase: "failed", error: error instanceof Error ? error.message : String(error) }); job.done = true; }
    }
    await storage.writeText(localJobPath(id), JSON.stringify(job));
  });
}
