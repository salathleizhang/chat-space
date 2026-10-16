import { cloudBudget } from "./cloudBudget";

/** Browser workspace identity stays in the same-origin server proxy. */
export async function blenderServiceRequest(path: string, body?: unknown): Promise<any> {
  return cloudBudget(async signal => {
    const origin = (globalThis as unknown as { location: { origin: string } }).location.origin;
    const response = await fetch(new URL(`/api/blender/${path}`, origin), { credentials: "same-origin", signal,
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json() as { error?: unknown };
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Blender cloud service is temporarily unavailable");
    return data;
  }, 25_000);
}
