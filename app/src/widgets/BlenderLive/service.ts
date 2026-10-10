import type { Session } from "../../../../chat/src/blenderService/store";
export type CloudSession = Session;
export type JobSummary = { label: string; state: string; step: number; requests: number; tokens: number; error: string | null };
export const sessionLabels: Record<Session["state"], string> = {
  queued: "排队", allocating: "分配沙盒", preparing: "启动 / 恢复工程", ready: "运行中", saving: "保存工程", cleaning: "整理工程",
  pausing: "正在暂停", paused: "已暂停", quarantined: "需要检查", expired: "实例已到期",
};
export async function blenderService<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/blender/${path}`, { credentials: "same-origin", ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Blender 请求失败（${response.status}）`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Blender 返回结果不完整，请用原请求重试");
  return data as T;
}
