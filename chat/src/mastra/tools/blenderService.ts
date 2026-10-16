import { createHash, randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getAssetStorage } from "../../services/assetStorage";
import { requireCurrentProject } from "./requestContext";
import { requireProject } from "./projectTools";
import { blenderServiceRequest as request } from "../../models/blenderServiceApi";
import { trackBlenderTask } from "../../services/blenderTasks";
import { DEFAULT_BLENDER_LIMITS, DEFAULT_BLENDER_CONCURRENCY } from "../../blenderService/limits";

export const CLOUD_BLENDER_INSTRUCTIONS = `Cloud Blender is available through the registered cloud session tools. It has a real Blender GUI: the Blender logo at the top of the workbench opens the current project's remote desktop windows, and newly submitted sessions appear automatically. Batch desktops are read-only while the server modeler controls them; a paused or preparing session cannot provide a live desktop. Never describe this service as headless or having no GUI. The main 3D viewport shows exported models only after import; it is separate from the remote desktop.
Report the actual returned session and job states. planning means the model is deciding the next step, not that Blender has executed geometry changes. planning_result_unknown means the planning response was not recovered; it does not establish that the modeling requirements were too complex or that the model could not decide. planning_timeout_result_unknown means the planning request exceeded its time budget. Other planning_* errors identify an HTTP rejection, truncated/empty response, invalid JSON/decision or missing usage receipt. Do not invent an explanation or silently resubmit paid work. Existing waiting-user jobs can continue with answer after the user authorizes another planning attempt; retry is only for failed/cancelled jobs. Do not create a replacement session just to query or watch one.`;

async function project(context: unknown): Promise<string> {
  const slug = requireCurrentProject(context as never); await requireProject(getAssetStorage(), slug); return slug;
}
export const BlenderBatchInput = z.object({ items: z.array(z.object({ label: z.string().min(1).max(128), prompt: z.string().min(1).max(20_000) })).min(1).max(100), concurrency: z.number().int().min(1).max(DEFAULT_BLENDER_LIMITS.owner).default(DEFAULT_BLENDER_CONCURRENCY) });
export const startBlenderBatchTool = createTool({
  id: "start-blender-batch",
  description: `When the user asks to use custom Blender for modeling, submit standalone modeling items for cloud execution. Each workspace runs at most ${DEFAULT_BLENDER_LIMITS.owner} Blender instances at a time, and globally at most ${DEFAULT_BLENDER_LIMITS.global}, with the rest queued; when the user does not specify concurrency, the default ${DEFAULT_BLENDER_CONCURRENCY} is used, and when the user specifies a parallel count, set concurrency according to the remaining quota, at most ${DEFAULT_BLENDER_LIMITS.owner}. Each item contains the complete requirements; tasks continue after the web page is closed. This tool returns batchId and sessionId immediately, and does not wait for modeling to complete or resubmit to confirm progress. Each instance has 8 cores and 32 GiB, for at most 60 minutes; compute/model/storage are billed by usage. Only submit within the scope the user has already asked to model. It cannot read the Blender currently selected in the browser to replace these sessions.`,
  inputSchema: BlenderBatchInput,
  execute: async (input, context) => {
    const slug = await project(context), storage = getAssetStorage();
    const callId = (context as { toolCallId?: string }).toolCallId;
    if (!callId) throw new Error("Missing durable call identity; no billable task was submitted");
    const path = `projects/${slug}/blender-submissions/${createHash("sha256").update(callId).digest("hex")}.json`;
    const body = { id: randomUUID(), project: slug, concurrency: input.concurrency, items: input.items.map((item, i) => ({ ...item, id: `item-${i}` })) };
    await storage.createExclusive(path, JSON.stringify(body));
    const acceptedInput = JSON.parse(await storage.readText(path));
    if (JSON.stringify({ ...acceptedInput, id: "" }) !== JSON.stringify({ ...body, id: "" })) throw new Error("The same call identity cannot change the modeling requirements");
    const result = await request("batches", acceptedInput);
    const tasks = await Promise.all(result.sessions.map((s: any) => trackBlenderTask(storage, s,
      acceptedInput.items.find((item: { id: string }) => item.id === s.itemId)?.label ?? "Model")));
    return { batchId: result.batchId, tasks, items: result.sessions.map((s: { id: string; itemId: string; state: string }) => ({ sessionId: s.id, itemId: s.itemId, state: s.state })), note: "Submitted; the cloud will continue executing. The workbench tracks these tasks and wakes this conversation after they finish. You can open the small window to watch. Use blender-session-action to import artifacts after completion; do not ask the user to click action buttons." };
  },
});
export const blenderBatchStatusTool = createTool({
  id: "blender-batch-status", description: "Query the per-item status, pending questions, and sessions of a submitted Blender batch. Query only; it does not re-model or charge. batchId must come from a submission result.",
  inputSchema: z.object({ batchId: z.string().uuid() }),
  execute: async (input, context) => {
    const slug = await project(context), data = await request(`batches/${input.batchId}`);
    if (data.items.some((item: { session: { project: string } }) => item.session.project !== slug)) throw new Error("The batch belongs to another project");
    return { items: data.items.map((item: any) => ({ sessionId: item.session.id, state: item.session.state, label: item.job?.label, jobState: item.job?.state, question: item.job?.error, steps: item.job?.step })) };
  },
});
type ExportImporter = (project: string, sessionId: string) => Promise<number>;
let exportImporter: ExportImporter | undefined;
/** Browser runtime supplies its existing verified, transactional IndexedDB importer. */
export function setBlenderExportImporter(importer: ExportImporter | undefined) { exportImporter = importer; }

async function durableAction(context: unknown, slug: string, body: unknown): Promise<any> {
  const callId = (context as { toolCallId?: string }).toolCallId;
  if (!callId) throw new Error("Missing durable call identity; no billable or modification request was submitted");
  const storage = getAssetStorage();
  const path = `projects/${slug}/blender-actions/${createHash("sha256").update(callId).digest("hex")}.json`;
  await storage.createExclusive(path, JSON.stringify(body));
  const accepted = JSON.parse(await storage.readText(path));
  if (JSON.stringify({ ...accepted, requestId: "", key: "" }) !== JSON.stringify({ ...body as object, requestId: "", key: "" })) {
    throw new Error("The same call identity cannot change the Blender operation");
  }
  return accepted;
}

export const blenderSessionsTool = createTool({
  id: "blender-sessions",
  description: "Query all cloud Blender sessions of the current project, their status, pending questions, and running quota, for continuing work, pausing, and querying artifacts. Query only; it does not start a sandbox or redo tasks. Only use the returned sessionId; do not fabricate identities of other projects.",
  inputSchema: z.object({}).strict(),
  execute: async (_input, context) => {
    const slug = await project(context), data = await request("sessions");
    return { sessions: data.sessions.filter((s: { project: string }) => s.project === slug).map((s: any) => ({
      sessionId: s.id, state: s.state, epoch: s.epoch, checkpoint: Boolean(s.checkpoint), job: data.jobs?.[s.id],
    })), limits: data.limits, defaultConcurrency: data.defaultConcurrency, budget: data.budget };
  },
});
export const BlenderSessionActionInput = z.object({
  action: z.enum(["status", "import", "pause", "cancel", "resume", "retry", "export", "answer", "operation-status"]),
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(20_000).optional().describe("Used only by answer; information supplied by the user"),
  discardUnknown: z.boolean().default(false).describe("Used only by answer; can be true only when the user explicitly agrees to roll back to the checkpoint"),
  operationId: z.string().uuid().optional().describe("Used only by operation-status; comes from the result returned by export"),
}).strict().superRefine((input, ctx) => {
  if ((input.action === "answer") !== Boolean(input.message)) ctx.addIssue({ code: "custom", path: ["message"], message: "answer must provide user information; other operations do not accept message" });
  if ((input.action === "operation-status") !== Boolean(input.operationId)) ctx.addIssue({ code: "custom", path: ["operationId"], message: "operation-status must provide an operation identity; other operations do not accept operationId" });
  if (input.discardUnknown && input.action !== "answer") ctx.addIssue({ code: "custom", path: ["discardUnknown"], message: "Only answer accepts checkpoint rollback authorization" });
});
export const blenderSessionActionTool = createTool({
  id: "blender-session-action",
  description: "Manage existing cloud Blender sessions of the current project. status queries the session and already-exported artifacts; import validates artifacts and adds them to the current model library, and repeated calls do not import twice; pause saves the manual project and pauses; cancel terminates the current batch task and saves, and any later redo requires an explicit user request and is billed again; resume continues a saved manual project; answer hands user-supplied information to a paused batch task to continue; retry redoes only the specified failed items and is billed again, and is used only when the user asks to redo; export exports the current scene of a manual session and immediately returns operationId, which can be queried with operation-status. Batch tasks export and save-pause automatically, so no manual export is needed. Do not make the user look for UI buttons; ask for information in the chat. When the execution result is unclear, never automatically redo or set discardUnknown=true; that option can be used only when the user explicitly agrees to roll back to the checkpoint. Resume only starts an existing project and does not create a replacement session.",
  inputSchema: BlenderSessionActionInput,
  execute: async (input, context) => {
    const slug = await project(context), data = await request(`sessions/${input.sessionId}`), session = data.session;
    if (session?.project !== slug || session?.id !== input.sessionId) throw new Error("The Blender session belongs to another project");
    if (input.action === "status") return { session, ...await request(`sessions/${input.sessionId}/exports`) };
    if (input.action === "operation-status") {
      const result = await request(`operations/${input.operationId}`);
      if (result.operation?.sessionId !== input.sessionId) throw new Error("The operation belongs to another Blender session");
      return result;
    }
    if (input.action === "import") {
      if (!exportImporter) throw new Error("The current runtime environment does not support browser model import");
      return { sessionId: input.sessionId, imported: await exportImporter(slug, input.sessionId) };
    }
    if (input.action === "pause" || input.action === "cancel") {
      if (input.action === "pause" && session.batchId) throw new Error("pause only pauses manual projects; use cancel only when the user asks to terminate a batch task");
      if (session.stopReason || ["paused", "expired"].includes(session.state)) return { session };
      return request(`sessions/${input.sessionId}/end`, { reason: input.action === "cancel" ? "cancelled" : "ended" });
    }
    if (input.action === "resume") {
      if (session.batchId) throw new Error("Batch tasks must use answer or retry according to their state; the runner cannot be resumed directly");
      if (!["paused", "expired"].includes(session.state)) return { session };
      return request(`sessions/${input.sessionId}/resume`, {});
    }
    if (input.action === "answer") {
      const result = await request(`sessions/${input.sessionId}/answer`, { message: input.message, discardUnknown: input.discardUnknown });
      return { ...result, tasks: [await trackBlenderTask(getAssetStorage(), result.session, "Continued model")] };
    }
    if (input.action === "retry") {
      const body = await durableAction(context, slug, { action: input.action, sessionId: input.sessionId, requestId: randomUUID() });
      const result = await request(`sessions/${input.sessionId}/retry`, { requestId: body.requestId });
      return { ...result, tasks: [await trackBlenderTask(getAssetStorage(), result.session, "Retried model")] };
    }
    if (session.batchId) throw new Error("Batch tasks are exported automatically by the runner; manual scene commands cannot be inserted");
    const body = await durableAction(context, slug, { action: "export", sessionId: input.sessionId, epoch: session.epoch, key: randomUUID(), tool: "export_scene", arguments: {} });
    return request(`sessions/${input.sessionId}/operations`, { epoch: body.epoch, key: body.key, tool: body.tool, arguments: body.arguments });
  },
});
export const BLENDER_SERVICE_TOOLS = { "start-blender-batch": startBlenderBatchTool, "blender-batch-status": blenderBatchStatusTool, "blender-sessions": blenderSessionsTool, "blender-session-action": blenderSessionActionTool };
