// Import only the pinned SDK signer; importing the barrel also loads unrelated cloud services.
import Signer from "@volcengine/openapi/lib/base/sign";
import { cloudBudget } from "../models/cloudBudget";

export interface VolcanoSettings { accessKeyId: string; secretKey: string; sessionToken?: string; region: string; functionId: string; imageInfoId: string }
export interface SandboxInfo { id: string; status: string; type: string; expiresAt: string; metadata: Record<string, string> }
export class VolcanoError extends Error {
  constructor(readonly action: string, readonly code: string, readonly unknown: boolean) { super(`Volcano ${action}: ${code}`); }
}
/** Deliberately no automatic retries on mutations: reconcile labels before creating a replacement. */
export class VolcanoSandboxes {
  constructor(private readonly settings: VolcanoSettings, private readonly fetchFn: typeof fetch = fetch) {}
  private async call(action: string, input: Record<string, unknown>, mutation = false): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ FunctionId: this.settings.functionId, ...input });
    const params = { Action: action, Version: "2024-06-06" };
    const headers: Record<string, string> = { Host: "open.volcengineapi.com", "Content-Type": "application/json" };
    const request = { method: "POST", region: this.settings.region, pathname: "/", params, headers, body };
    new Signer(request, "vefaas").addAuthorization(this.settings);
    try {
      return await cloudBudget(async signal => {
        const response = await this.fetchFn("https://open.volcengineapi.com/?" + new URLSearchParams(params), {
          method: "POST", headers, body, signal, redirect: "error",
        });
        // Do not expose provider messages or DescribeSandbox Envs (which contain credentials).
        const data = await response.json() as { ResponseMetadata?: { Error?: { Code?: string } }; Result?: Record<string, unknown> };
        if (!response.ok || data.ResponseMetadata?.Error || !data.Result) {
          const code = data.ResponseMetadata?.Error?.Code ?? `HTTP_${response.status}`;
          throw new VolcanoError(action, /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : "provider_error", mutation && response.status >= 500);
        }
        return data.Result;
      }, 45_000);
    } catch (error) {
      if (error instanceof VolcanoError) throw error;
      throw new VolcanoError(action, "connection_result_unknown", mutation);
    }
  }
  async create(sessionId: string, epoch: number, secrets: { desktop: string; control: string }, timeoutMinutes = 60): Promise<string> {
    const result = await this.call("CreateSandbox", {
      Timeout: timeoutMinutes, CpuMilli: 8000, MemoryMB: 32768,
      InstanceImageInfo: { Id: this.settings.imageInfoId, Port: 8080, Command: "/opt/cloud-gateway/entrypoint.sh" },
      Metadata: { chatspace_session: sessionId, chatspace_epoch: String(epoch) },
      Envs: [{ Key: "VNC_PW", Value: secrets.desktop }, { Key: "BLENDER_CONTROL_TOKEN", Value: secrets.control },
        { Key: "CHATSPACE_MANAGED", Value: "1" }, { Key: "CHATSPACE_SESSION_ID", Value: sessionId },
        { Key: "CHATSPACE_LEASE_EPOCH", Value: String(epoch) }],
    }, true);
    return instanceId(result.SandboxId);
  }
  async list(filter: { sessionId?: string; epoch?: number; instance?: string } = {}): Promise<SandboxInfo[]> {
    const all: SandboxInfo[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.call("ListSandboxes", { PageNumber: page, PageSize: 100,
        ...(filter.instance ? { SandboxId: filter.instance } : {}),
        ...(filter.sessionId ? { Metadata: { chatspace_session: filter.sessionId, ...(filter.epoch ? { chatspace_epoch: String(filter.epoch) } : {}) } } : {}) });
      if (!Array.isArray(result.Sandboxes)) throw new VolcanoError("ListSandboxes", "invalid_result", false);
      all.push(...result.Sandboxes.map(value => {
        const s = value as Record<string, unknown>;
        return { id: instanceId(s.Id), status: String(s.Status ?? ""), type: String(s.InstanceType ?? ""),
          expiresAt: String(s.ExpireAt ?? ""), metadata: s.Metadata as Record<string, string> ?? {} };
      }));
      if (all.length >= Number(result.Total) || result.Sandboxes.length < 100) return all;
    }
    throw new VolcanoError("ListSandboxes", "pagination_limit", false);
  }
  async pause(instance: string): Promise<void> { await this.call("PauseSandbox", { SandboxId: instanceId(instance), Type: "disk" }, true); }
  async resume(instance: string, timeoutMinutes = 60): Promise<string> {
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 3 || timeoutMinutes > 60) throw new Error("Invalid resume timeout");
    return instanceId((await this.call("ResumeSandbox", { SandboxId: instanceId(instance), Timeout: timeoutMinutes, Async: true }, true)).SandboxId);
  }
  async extend(instance: string, minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 3 || minutes > 60) throw new Error("Invalid timeout budget");
    await this.call("SetSandboxTimeout", { SandboxId: instanceId(instance), Timeout: minutes }, true);
  }
}
function instanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid sandbox ID");
  return value;
}
