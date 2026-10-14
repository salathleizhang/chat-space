import type { Session } from "../../../../chat/src/blenderService/store";
export type CloudSession = Session;
export type JobSummary = { label: string; state: string; step: number; requests: number; tokens: number; error: string | null };
export const sessionLabels: Record<Session["state"], string> = {
  queued: "Queued", allocating: "Allocating sandbox", preparing: "Starting or resuming project", ready: "Running", saving: "Saving project", cleaning: "Cleaning up",
  pausing: "Pausing", paused: "Paused", quarantined: "Needs attention", expired: "Instance expired",
};
export async function blenderService<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/blender/${path}`, { credentials: "same-origin", ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Blender request failed (${response.status})`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Blender returned an incomplete result; retry with the original request");
  return data as T;
}
