import { projectTaskFile } from "../common/libraryPaths";
import { GenerationTaskSchema, type GenerationTask } from "../dto/tasks";
import { blenderServiceRequest } from "../models/blenderServiceApi";
import { readJson, writeJson, type AssetStorage } from "./assetStorage";

export const BLENDER_TASK_WORKFLOW = "blender-cloud";
type Session = { id: string; project: string; epoch: number; state: string; batchId?: string | null };
type Job = { state: string; label: string; error?: string | null };

/** Persist a subscription, never a second model execution. Epoch distinguishes authorized continuations. */
export async function trackBlenderTask(storage: AssetStorage, session: Session, label: string): Promise<GenerationTask> {
  const now = new Date().toISOString();
  const task = GenerationTaskSchema.parse({ id: `blender-${session.id}-${session.epoch}`, workflowId: BLENDER_TASK_WORKFLOW,
    projectSlug: session.project, subject: `Blender: ${label}`, status: "running", phase: "queued", batchId: session.batchId ?? undefined,
    result: { blenderSessionId: session.id }, createdAt: now, updatedAt: now });
  const path = projectTaskFile(session.project, task.id);
  await storage.createExclusive(path, JSON.stringify(task));
  return readJson(storage, path, GenerationTaskSchema);
}

/** Existing /tasks heartbeat observes authoritative cloud state. It cannot start, resume or retry work. */
export async function refreshBlenderTasks(storage: AssetStorage, tasks: GenerationTask[]): Promise<GenerationTask[]> {
  if (!tasks.some(t => t.workflowId === BLENDER_TASK_WORKFLOW && t.status === "running")) return tasks;
  const data = await blenderServiceRequest("sessions") as { sessions: Session[]; jobs: Record<string, Job> };
  return Promise.all(tasks.map(async task => {
    if (task.workflowId !== BLENDER_TASK_WORKFLOW || task.status !== "running") return task;
    const id = (task.result as { blenderSessionId?: string } | undefined)?.blenderSessionId;
    const session = data.sessions.find(s => s.id === id && s.project === task.projectSlug), job = id && data.jobs?.[id];
    if (!session || !job) throw new Error("Cannot read the tracked Blender task; no work was resubmitted");
    const failure = ["failed", "cancelled", "waiting-user"].includes(job.state) || ["quarantined", "expired"].includes(session.state);
    // Export and checkpoint publication must finish before notifying the agent to import.
    const succeeded = job.state === "succeeded" && session.state === "paused";
    const status = succeeded ? "succeeded" : failure ? "failed" : "running";
    const phase = succeeded ? "completed" : failure ? "failed" : job.state === "succeeded" ? "publishing"
      : ["queued", "allocating", "preparing"].includes(session.state) ? "queued" : "generating";
    const error = failure ? `${job.state}: ${job.error ?? session.state}` : undefined;
    const next = { ...task, status, phase, error } satisfies GenerationTask;
    if (next.status === task.status && next.phase === task.phase && next.error === task.error) return task;
    next.updatedAt = new Date().toISOString();
    await writeJson(storage, projectTaskFile(task.projectSlug, task.id), GenerationTaskSchema, next);
    return next;
  }));
}
