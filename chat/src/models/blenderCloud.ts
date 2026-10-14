import { ChatServiceError } from "../common/errors";
import { BLENDER_ALLOWED_TOOLS, wrapResult } from "./blenderProtocol";
import type { BlenderCallResult } from "./blenderMcp";

export interface BlenderCloudSettings {
  target: string;
  instanceName: string;
  token: string;
  projectSlug: string;
}

/** This first rollout reserves one explicitly configured sandbox for one project.
 * It cannot be shared across projects until the lease allocator is implemented. */
export function readBlenderCloudSettings(env = process.env): BlenderCloudSettings | null {
  if (!env.BLENDER_CONTROL_TOKEN && !env.BLENDER_CLOUD_PROJECT) return null;
  const settings = { target: env.BLENDER_LIVE_TARGET ?? "", instanceName: env.BLENDER_LIVE_INSTANCE_NAME ?? "",
    token: env.BLENDER_CONTROL_TOKEN ?? "", projectSlug: env.BLENDER_CLOUD_PROJECT ?? "" };
  let url: URL;
  try { url = new URL(settings.target); }
  catch { throw new ChatServiceError("The cloud Blender configuration is incomplete or invalid; this will not fall back to the local machine", 503, "blender_cloud_config_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(settings.token) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(settings.instanceName) || !/^[a-z0-9][a-z0-9_-]*$/.test(settings.projectSlug)) {
    throw new ChatServiceError("The cloud Blender configuration is incomplete or invalid; this will not fall back to the local machine", 503, "blender_cloud_config_invalid");
  }
  return settings;
}

export function assertBlenderProject(projectSlug: string): void {
  const cloud = readBlenderCloudSettings();
  if (cloud && cloud.projectSlug !== projectSlug) {
    throw new ChatServiceError("This cloud Blender is already assigned to another project; end that project's session first", 409, "blender_project_mismatch");
  }
}

export { cloudBudget } from "./cloudBudget";
import { cloudBudget } from "./cloudBudget";

async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maxBytes) throw new ChatServiceError("The cloud file exceeds the transfer limit", 413, "blender_cloud_file_too_large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ChatServiceError("The cloud file exceeds the transfer limit", 413, "blender_cloud_file_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export class BlenderCloudClient {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly settings: BlenderCloudSettings, private readonly fetchFn: typeof fetch = fetch) {}
  get running() { return true; }
  get diagnostics() { return { transport: "cloud", instanceName: this.settings.instanceName, projectSlug: this.settings.projectSlug }; }
  async stop() { /* The sandbox lifecycle is owned by the allocator, not this HTTP client. */ }
  private request(path: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<Uint8Array> {
    return cloudBudget(async (signal) => {
      const response = await this.fetchFn(new URL(path, this.settings.target), { ...init, redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...init.headers,
          Authorization: `Bearer ${this.settings.token}`, "x-faas-instance-name": this.settings.instanceName } });
      if (!response.ok) {
        await response.body?.cancel();
        // No upstream body, token, code or headers in errors/diagnostics.
        throw new ChatServiceError(`The cloud Blender returned HTTP ${response.status}; it will not reconnect locally or replay the command automatically`,
          response.status === 401 ? 503 : response.status, "blender_cloud_request_failed");
      }
      return boundedBytes(response, maxBytes);
    }, timeoutMs);
  }
  async call(tool: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<BlenderCallResult> {
    if (!(BLENDER_ALLOWED_TOOLS as readonly string[]).includes(tool)) {
      throw new ChatServiceError("The Blender tool is not on the allowlist", 403, "blender_tool_not_allowed");
    }
    const run = async () => {
      const started = Date.now();
      const bytes = await this.request("/control/call", { method: "POST", body: JSON.stringify({ tool, arguments: args }) },
        options.timeoutMs ?? 185_000, 16 * 1024 * 1024);
      const wrapped = wrapResult(tool, JSON.parse(new TextDecoder().decode(bytes)));
      if (wrapped.isError) throw new ChatServiceError("The cloud Blender tool failed to execute; check the scene", 502, "blender_tool_error");
      return { tool, ...wrapped, ms: Date.now() - started };
    };
    const pending = this.tail.then(run, run);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  downloadExport(exportId: string): Promise<Uint8Array> {
    this.validateExportId(exportId);
    return this.request(`/control/exports/${exportId}`, { method: "GET" }, 300_000, 256 * 1024 * 1024);
  }
  async removeExport(exportId: string): Promise<void> {
    this.validateExportId(exportId);
    await this.request(`/control/exports/${exportId}`, { method: "DELETE" }, 10_000, 1024);
  }
  private validateExportId(value: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid export id");
  }
}
