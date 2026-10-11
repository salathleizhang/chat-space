// Import only the pinned SDK signer; importing the barrel also loads unrelated cloud services.
import SignerImport from "@volcengine/openapi/lib/base/sign";
import { cloudBudget } from "../models/cloudBudget";

// The SDK exports a CommonJS { default: Signer }. Wrangler's ESM bundle
// preserves that object, while Bun/Vitest unwrap it. Support both transports.
const Signer = typeof SignerImport === "function" ? SignerImport :
  (SignerImport as unknown as { default: typeof SignerImport }).default;

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
    const phase = { value: "fetch" as "fetch" | "body" };
    try {
      return await cloudBudget(async signal => {
        // Workers' native fetch requires the global receiver, even when injected.
        const response = await this.fetchFn.call(globalThis, "https://open.volcengineapi.com/?" + new URLSearchParams(params), {
          method: "POST", headers, body, signal, redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel(); throw new VolcanoError(action, "redirect_refused", mutation);
        }
        phase.value = "body";
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
      // Fixed diagnostic terms only; never preserve a fetch error's URL/body.
      const name = error instanceof Error && ["TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "Error";
      const terms = ["header", "tls", "dns", "abort", "timeout", "unsupported", "cancelled", "canceled"].filter(term => error instanceof Error && error.message.toLowerCase().includes(term));
      throw new VolcanoError(action, `${phase.value === "body" ? "invalid_response" : "connection_result_unknown"}_${name}${terms.length ? "_" + terms.join("_") : ""}`, mutation);
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
    const all = new Map<string, SandboxInfo>();
    // Default lists omit paused disk snapshots. Verified against a real paused
    // customized instance: Paused=true returns Status=Paused, InstanceType="".
    for (const paused of [false, true]) {
      let seen = 0, complete = false;
      for (let page = 1; page <= 100; page++) {
        const result = await this.call("ListSandboxes", { PageNumber: page, PageSize: 100, ...(paused ? { Paused: true } : {}),
          ...(filter.instance ? { SandboxId: filter.instance } : {}),
          ...(filter.sessionId ? { Metadata: { chatspace_session: filter.sessionId, ...(filter.epoch ? { chatspace_epoch: String(filter.epoch) } : {}) } } : {}) });
        if (!Array.isArray(result.Sandboxes)) throw new VolcanoError("ListSandboxes", "invalid_result", false);
        for (const value of result.Sandboxes) {
          const s = value as Record<string, unknown>;
          const id = instanceId(s.Id), status = String(s.Status ?? "");
          const info = { id, status, type: status === "Paused" ? "frozen" : String(s.InstanceType || "activated"),
            expiresAt: String(s.ExpireAt ?? ""), metadata: s.Metadata as Record<string, string> ?? {} };
          // An active record wins if the provider briefly lists both variants.
          if (!all.has(id)) all.set(id, info);
        }
        seen += result.Sandboxes.length;
        if (seen >= Number(result.Total) || result.Sandboxes.length < 100) { complete = true; break; }
      }
      if (!complete) throw new VolcanoError("ListSandboxes", "pagination_limit", false);
      if (filter.instance && all.has(filter.instance)) break;
    }
    return [...all.values()];
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
