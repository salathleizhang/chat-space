import { commitLocal, localEntry } from "../../browser/storage";
import { blenderService } from "./service";

export type BatchRequest = { id: string; project: string; concurrency: number; items: { id: string; label: string; prompt: string }[] };
type Pending = { version: 1; path: string; body: unknown };
export function confirmBlenderRequest(pending: Pending, owner: string, project: string, result: unknown): void {
  const data = result as { session?: { id: string; project: string; owner: string }; sessions?: { id: string; project: string; owner: string; batchId: string }[];
    batchId?: string; operation?: { key: string; sessionId: string; epoch: number } };
  const body = pending.body as { id?: string; items?: unknown[]; key?: string; epoch?: number };
  const validSession = (session: { id: string; project: string; owner: string } | undefined) => session && /^[a-f0-9-]{36}$/.test(session.id) && session.project === project && session.owner === owner;
  let confirmed = false;
  if (pending.path === "sessions" || /^sessions\/[a-f0-9-]{36}\/retry$/.test(pending.path)) confirmed = Boolean(validSession(data?.session));
  else if (pending.path === "batches") confirmed = data?.batchId === body.id && Array.isArray(data.sessions) && data.sessions.length === body.items?.length && data.sessions.every(s => validSession(s) && s.batchId === body.id);
  else if (/^sessions\/[a-f0-9-]{36}\/operations$/.test(pending.path)) confirmed = Boolean(data?.operation && data.operation.key === body.key && data.operation.sessionId === pending.path.split("/")[1] && data.operation.epoch === body.epoch);
  if (!confirmed) throw new Error("Blender 回执与原请求不符，待确认请求已保留");
}
function entryPath(owner: string, project: string, slot: string) {
  if (![owner, project, slot].every(value => /^[A-Za-z0-9_-]{1,160}$/.test(value))) throw new Error("无效的 Blender 请求范围");
  return `.blender-outbox-v1/${owner}/${project}/${slot}.json`;
}
export async function pendingBlenderRequest(owner: string, project: string, slot: string): Promise<Pending | undefined> {
  const entry = await localEntry(entryPath(owner, project, slot));
  if (!entry) return;
  const pending: Pending = JSON.parse(typeof entry.value === "string" ? entry.value : await entry.value.text());
  if (pending.version !== 1 || typeof pending.path !== "string") throw new Error("Blender 待确认请求版本不兼容");
  return pending;
}
/** Persist before sending. A lost response, panel close or browser restart keeps the same intent. */
export async function durableBlenderRequest<T>(owner: string, project: string, slot: string, path: string, body: () => unknown): Promise<T> {
  const key = entryPath(owner, project, slot);
  return navigator.locks.request(`chatspace:blender-outbox:${key}`, async () => {
    let pending = await pendingBlenderRequest(owner, project, slot);
    if (pending && pending.path !== path) throw new Error("先确认上一次 Blender 请求");
    if (!pending) {
      pending = { version: 1, path, body: body() };
      await commitLocal([{ path: key, value: JSON.stringify(pending), updatedAt: Date.now() }]);
    }
    const result = await blenderService<T>(pending.path, pending.body);
    confirmBlenderRequest(pending, owner, project, result);
    await commitLocal([], [key]);
    return result;
  });
}
