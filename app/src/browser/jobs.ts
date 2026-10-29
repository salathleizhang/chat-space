import { projectTaskFile } from "../../../chat/src/common/libraryPaths";
import { CloudTaskPending, withCloudContext, type CloudContext, type CloudOperation } from "../../../chat/src/cloud/context";
import { executeCloudOperation } from "../../../chat/src/cloud/operations";
import { GenerationTaskSchema, type GenerationTask } from "../../../chat/src/dto/tasks";
import { RequestSidecarSchema } from "../../../chat/src/dto/library";
import { serverResumeKeys } from "./config";
import { resumeGeneration } from "../../../chat/src/mastra/tools/resumeGeneration";
import { withAssetStorage, readJson, writeJson } from "../../../chat/src/services/assetStorage";
import { runWithTaskPump } from "../../../chat/src/common/taskPump";
import { BrowserAssetStorage, localEntries } from "./storage";
import { browserErrorMessage } from "./errors";
import { publishCompletedCharacter } from "./characterCompletion";
import { runWithGeneratedModelInfo } from "../../../chat/src/mastra/tools/modelInfo";
import { browserTaskDriverIds } from "./taskDrivers";
export interface LocalJob { task: GenerationTask; descriptor: CloudOperation; started: boolean; receipts: string[]; nextAt: number; done?: boolean; publicationChecked?: boolean }
export const localJobPath = (id: string) => `.jobs/${id}.json`;
export function browserContext(storage: BrowserAssetStorage, ownJob?: LocalJob): CloudContext {
  return { workspace: "browser", pending: [], polling: true, activeTaskIds: async () => {
      const held = (await navigator.locks.query()).held?.flatMap(lock => lock.name ? [lock.name] : []) ?? [];
      const jobs = (await localEntries(".jobs/")).flatMap(entry => {
        if (typeof entry.value !== "string") return [];
        try {
          const job = JSON.parse(entry.value) as LocalJob;
          if (typeof job?.task?.id === "string" && typeof job.nextAt === "number") return [job];
        } catch { /* 单个损坏调度不能影响其它任务的健康状态。 */ }
        return [];
      });
      return browserTaskDriverIds(jobs, held);
    },
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
    if (job.nextAt > Date.now()) return;
    let task = await readJson(storage, projectTaskFile(job.task.projectSlug, id), GenerationTaskSchema);
    const patch = async (changes: Partial<GenerationTask>) => {
      task = { ...task, ...changes, updatedAt: new Date().toISOString() };
      await writeJson(storage, projectTaskFile(task.projectSlug, id), GenerationTaskSchema, task);
    };
    if (job.done) {
      if (job.descriptor.operation === "character" && !job.publicationChecked) {
        if (task.status === "succeeded") {
          await publishCompletedCharacter(storage, task.projectSlug, String(job.descriptor.input.assetSlug), job.receipts, task.result);
          const result = await runWithGeneratedModelInfo(storage, task.projectSlug, String(job.descriptor.input.assetSlug), async () => task.result);
          await patch({ result });
        }
        job.publicationChecked = true;
        await storage.writeText(localJobPath(id), JSON.stringify(job));
      }
      return;
    }
    const context = browserContext(storage, job);
    storage.onSidecar = context.onSidecar;
    const execution = { id, setPhase: (phase: GenerationTask["phase"]) => patch({ phase }), setAssetSlug: (assetSlug: string) => patch({ assetSlug }) };
    try {
      // 纯本地操作（减面）：不花钱、可重入，中断后直接重跑，不走"供应商收据"那套续跑逻辑
      const LOCAL_OPERATIONS = new Set(["retopo"]);
      const result = await withAssetStorage(storage, () => withCloudContext(context, () => runWithTaskPump(id, task.projectSlug, async () => {
        if (Date.now() - Date.parse(task.createdAt) > 90 * 60_000) throw new Error("The task exceeded 90 minutes; resume with the provider receipt");
        if (!job.started) {
          // Commit before sending any paid request. A lost response requires manual recovery.
          job.started = true; await storage.writeText(localJobPath(id), JSON.stringify(job));
          return executeCloudOperation(task, job.descriptor, execution);
        }
        if (LOCAL_OPERATIONS.has(job.descriptor.operation)) return executeCloudOperation(task, job.descriptor, execution);
        if (!job.receipts.length && !["scene-job", "resume"].includes(job.descriptor.operation)) {
          throw new Error("The previous run was interrupted with no provider receipt; to avoid paying twice it was not resubmitted. Check the provider records and try again");
        }
        let resumed: unknown;
        for (const path of job.receipts) {
          const receipt = await readJson(storage, path, RequestSidecarSchema);
          if (receipt.status !== "succeeded" && !receipt.providerTaskId) throw new Error("The submission result is unknown; the paid request was not resent automatically");
          resumed = await resumeGeneration(storage, path, serverResumeKeys(), execution.setPhase);
        }
        if (["scene-job", "resume"].includes(job.descriptor.operation)) return executeCloudOperation(task, job.descriptor, execution);
        const required: Record<string, string> = { segment: "v3/mesh/segment", rig: "/animations/rig", animation: "/animations/retarget", texture: "/models/texture", character: "/animations/rig" };
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
      if (job.descriptor.operation === "character") {
        await publishCompletedCharacter(storage, task.projectSlug, String(job.descriptor.input.assetSlug), job.receipts, result);
        job.publicationChecked = true;
      }
      const measured = ["3d", "retopo", "character"].includes(job.descriptor.operation)
        ? await runWithGeneratedModelInfo(storage, task.projectSlug, task.assetSlug ?? String(job.descriptor.input.assetSlug), async () => result)
        : result;
      await patch({ status: "succeeded", phase: "completed", result: measured, error: undefined });
      job.done = true;
    } catch (error) {
      await Promise.all(context.pending);
      if (error instanceof CloudTaskPending) { job.nextAt = Date.now() + error.delaySeconds * 1000; }
      else { await patch({ status: "failed", phase: "failed", error: browserErrorMessage(error) }); job.done = true; }
    }
    await storage.writeText(localJobPath(id), JSON.stringify(job));
  });
}
