import { createHash, randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getAssetStorage } from "../../services/assetStorage";
import { requireCurrentProject } from "./requestContext";
import { requireProject } from "./projectTools";
import { cloudBudget } from "../../models/blenderCloud";

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
export const startBlenderBatchTool = createTool({
  id: "start-blender-batch",
  description: "用户要求使用定制 Blender 建模时，提交独立建模项给云端执行。一个用户可同时运行最多3个Blender，其余排队。每项包含完整要求；任务在网页关闭后仍继续。此工具立即返回batchId和sessionId，不等建模完成、不重复提交确认进度。每个实例8核32GiB，最长60分钟，算力/模型/存储按用量收费。仅在用户已要求建模的范围内提交。不能读取浏览器当前选择的Blender替代这些会话。",
  inputSchema: z.object({ items: z.array(z.object({ label: z.string().min(1).max(128), prompt: z.string().min(1).max(20_000) })).min(1).max(100), concurrency: z.number().int().min(1).max(3).default(3) }),
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
    return { batchId: result.batchId, items: result.sessions.map((s: { id: string; itemId: string; state: string }) => ({ sessionId: s.id, itemId: s.itemId, state: s.state })), note: "已提交，云端会继续执行。在Blender云工作台观看、回答问题及领取产物。" };
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
export const BLENDER_SERVICE_TOOLS = { "start-blender-batch": startBlenderBatchTool, "blender-batch-status": blenderBatchStatusTool };
