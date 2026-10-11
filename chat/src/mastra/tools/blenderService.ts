import { createHash, randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getAssetStorage } from "../../services/assetStorage";
import { requireCurrentProject } from "./requestContext";
import { requireProject } from "./projectTools";
import { cloudBudget } from "../../models/blenderCloud";
import { DEFAULT_BLENDER_LIMITS, DEFAULT_BLENDER_CONCURRENCY } from "../../blenderService/limits";

async function request(path: string, body?: unknown): Promise<any> {
  // Registered only in the browser runtime after server capabilities confirm deployment.
  return cloudBudget(async signal => {
    const origin = (globalThis as unknown as { location: { origin: string } }).location.origin;
    const response = await fetch(new URL(`/api/blender/${path}`, origin), { credentials: "same-origin", signal,
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json() as { error?: unknown };
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Blender 云服务暂时不可用");
    return data;
  }, 25_000);
}
async function project(context: unknown): Promise<string> {
  const slug = requireCurrentProject(context as never); await requireProject(getAssetStorage(), slug); return slug;
}
export const BlenderBatchInput = z.object({ items: z.array(z.object({ label: z.string().min(1).max(128), prompt: z.string().min(1).max(20_000) })).min(1).max(100), concurrency: z.number().int().min(1).max(DEFAULT_BLENDER_LIMITS.owner).default(DEFAULT_BLENDER_CONCURRENCY) });
export const startBlenderBatchTool = createTool({
  id: "start-blender-batch",
  description: `用户要求使用定制 Blender 建模时，提交独立建模项给云端执行。每工作区同时运行最多${DEFAULT_BLENDER_LIMITS.owner}个Blender，全局最多${DEFAULT_BLENDER_LIMITS.global}个，其余排队；用户未指定并发时使用默认${DEFAULT_BLENDER_CONCURRENCY}，用户指定并行数量时按剩余额度设置concurrency，最多${DEFAULT_BLENDER_LIMITS.owner}。每项包含完整要求；任务在网页关闭后仍继续。此工具立即返回batchId和sessionId，不等建模完成、不重复提交确认进度。每个实例8核32GiB，最长60分钟，算力/模型/存储按用量收费。仅在用户已要求建模的范围内提交。不能读取浏览器当前选择的Blender替代这些会话。`,
  inputSchema: BlenderBatchInput,
  execute: async (input, context) => {
    const slug = await project(context), storage = getAssetStorage();
    const callId = (context as { toolCallId?: string }).toolCallId;
    if (!callId) throw new Error("缺少持久调用身份，未提交计费任务");
    const path = `projects/${slug}/blender-submissions/${createHash("sha256").update(callId).digest("hex")}.json`;
    const body = { id: randomUUID(), project: slug, concurrency: input.concurrency, items: input.items.map((item, i) => ({ ...item, id: `item-${i}` })) };
    await storage.createExclusive(path, JSON.stringify(body));
    const acceptedInput = JSON.parse(await storage.readText(path));
    if (JSON.stringify({ ...acceptedInput, id: "" }) !== JSON.stringify({ ...body, id: "" })) throw new Error("相同调用身份不能改变建模要求");
    const result = await request("batches", acceptedInput);
    return { batchId: result.batchId, items: result.sessions.map((s: { id: string; itemId: string; state: string }) => ({ sessionId: s.id, itemId: s.itemId, state: s.state })), note: "已提交，云端会继续执行。可打开小窗观看。后续用blender-sessions查询，用blender-session-action管理或导入产物，不要求用户点击操作按钮。" };
  },
});
export const blenderBatchStatusTool = createTool({
  id: "blender-batch-status", description: "查询已提交Blender批次的每项状态、待回答问题和会话。只查询，不重新建模或付费。batchId必须来自提交结果。",
  inputSchema: z.object({ batchId: z.string().uuid() }),
  execute: async (input, context) => {
    const slug = await project(context), data = await request(`batches/${input.batchId}`);
    if (data.items.some((item: { session: { project: string } }) => item.session.project !== slug)) throw new Error("批次属于其他项目");
    return { items: data.items.map((item: any) => ({ sessionId: item.session.id, state: item.session.state, label: item.job?.label, jobState: item.job?.state, question: item.job?.error, steps: item.job?.step })) };
  },
});
type ExportImporter = (project: string, sessionId: string) => Promise<number>;
let exportImporter: ExportImporter | undefined;
/** Browser runtime supplies its existing verified, transactional IndexedDB importer. */
export function setBlenderExportImporter(importer: ExportImporter | undefined) { exportImporter = importer; }

async function durableAction(context: unknown, slug: string, body: unknown): Promise<any> {
  const callId = (context as { toolCallId?: string }).toolCallId;
  if (!callId) throw new Error("缺少持久调用身份，未提交计费或修改请求");
  const storage = getAssetStorage();
  const path = `projects/${slug}/blender-actions/${createHash("sha256").update(callId).digest("hex")}.json`;
  await storage.createExclusive(path, JSON.stringify(body));
  const accepted = JSON.parse(await storage.readText(path));
  if (JSON.stringify({ ...accepted, requestId: "", key: "" }) !== JSON.stringify({ ...body as object, requestId: "", key: "" })) {
    throw new Error("相同调用身份不能改变 Blender 操作");
  }
  return accepted;
}

export const blenderSessionsTool = createTool({
  id: "blender-sessions",
  description: "查询当前项目的所有云端 Blender 会话、状态、待回答问题和运行额度，供继续工程、暂停、查询产物使用。只查询，不启动沙盒或重做任务。只能使用返回的sessionId，不能编造其他项目身份。",
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
  message: z.string().min(1).max(20_000).optional().describe("仅 answer 使用，来自用户补充的信息"),
  discardUnknown: z.boolean().default(false).describe("仅 answer 使用；用户明确同意退回检查点才可为 true"),
  operationId: z.string().uuid().optional().describe("仅 operation-status 使用，来自 export 返回结果"),
}).strict().superRefine((input, ctx) => {
  if ((input.action === "answer") !== Boolean(input.message)) ctx.addIssue({ code: "custom", path: ["message"], message: "answer 必须提供用户信息，其他操作不接受 message" });
  if ((input.action === "operation-status") !== Boolean(input.operationId)) ctx.addIssue({ code: "custom", path: ["operationId"], message: "operation-status 必须提供操作身份，其他操作不接受 operationId" });
  if (input.discardUnknown && input.action !== "answer") ctx.addIssue({ code: "custom", path: ["discardUnknown"], message: "仅 answer 接受检查点退回授权" });
});
export const blenderSessionActionTool = createTool({
  id: "blender-session-action",
  description: "管理当前项目已存在的云端Blender会话。status查询会话及已导出产物；import把产物校验后加入当前模型库，重复调用不会重复导入；pause保存手动工程并暂停；cancel终止当前批量任务并保存，后续重做须用户明确要求且会重新计费；resume继续已保存的手动工程；answer把用户补充信息交给暂停的批量任务继续；retry仅重做指定失败项，会重新计费，仅在用户要求重做时使用；export导出手动会话的当前场景，立即返回operationId，可用operation-status查询。批量任务自动导出和保存暂停，不需手动export。不要让用户找界面按钮；需要信息就在聊天里询问。执行结果不明时绝不自动重做或设置discardUnknown=true，只有用户明确同意退回检查点才能使用该选项。恢复只启动已有工程，不创建替代会话。",
  inputSchema: BlenderSessionActionInput,
  execute: async (input, context) => {
    const slug = await project(context), data = await request(`sessions/${input.sessionId}`), session = data.session;
    if (session?.project !== slug || session?.id !== input.sessionId) throw new Error("Blender 会话属于其他项目");
    if (input.action === "status") return { session, ...await request(`sessions/${input.sessionId}/exports`) };
    if (input.action === "operation-status") {
      const result = await request(`operations/${input.operationId}`);
      if (result.operation?.sessionId !== input.sessionId) throw new Error("操作属于其他 Blender 会话");
      return result;
    }
    if (input.action === "import") {
      if (!exportImporter) throw new Error("当前运行环境不支持浏览器模型导入");
      return { sessionId: input.sessionId, imported: await exportImporter(slug, input.sessionId) };
    }
    if (input.action === "pause" || input.action === "cancel") {
      if (input.action === "pause" && session.batchId) throw new Error("pause 只暂停手动工程；仅用户要求终止批量任务时才使用 cancel");
      if (session.stopReason || ["paused", "expired"].includes(session.state)) return { session };
      return request(`sessions/${input.sessionId}/end`, { reason: input.action === "cancel" ? "cancelled" : "ended" });
    }
    if (input.action === "resume") {
      if (session.batchId) throw new Error("批量任务需按状态使用 answer 或 retry，不能直接恢复运行器");
      if (!["paused", "expired"].includes(session.state)) return { session };
      return request(`sessions/${input.sessionId}/resume`, {});
    }
    if (input.action === "answer") return request(`sessions/${input.sessionId}/answer`, { message: input.message, discardUnknown: input.discardUnknown });
    if (input.action === "retry") {
      const body = await durableAction(context, slug, { action: input.action, sessionId: input.sessionId, requestId: randomUUID() });
      return request(`sessions/${input.sessionId}/retry`, { requestId: body.requestId });
    }
    if (session.batchId) throw new Error("批量任务由运行器自动导出，不能插入手动场景命令");
    const body = await durableAction(context, slug, { action: "export", sessionId: input.sessionId, epoch: session.epoch, key: randomUUID(), tool: "export_scene", arguments: {} });
    return request(`sessions/${input.sessionId}/operations`, { epoch: body.epoch, key: body.key, tool: body.tool, arguments: body.arguments });
  },
});
export const BLENDER_SERVICE_TOOLS = { "start-blender-batch": startBlenderBatchTool, "blender-batch-status": blenderBatchStatusTool, "blender-sessions": blenderSessionsTool, "blender-session-action": blenderSessionActionTool };
