import { cloudBudget } from "../models/cloudBudget";
import { boundedBody, sha256 } from "./objects";
import type { Operation, Session } from "./storeCore";
export type ExecutorReceipt = { id: string; state: "queued" | "running" | "succeeded" | "failed" | "unknown"; result: unknown };
export class ManagedExecutor {
  constructor(private readonly target: string, private readonly fetchFn: typeof fetch = fetch, private readonly responseLimit = 256 * 1024 * 1024) {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid executor gateway");
  }
  private async request(session: Session, token: string, path: string, init: RequestInit): Promise<Uint8Array> {
    if (!session.instance) throw new Error("Session has no sandbox");
    return cloudBudget(async signal => {
      const response = await this.fetchFn(new URL(path, this.target), { ...init, signal, redirect: "error",
        headers: { "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${token}`,
          "x-faas-instance-name": session.instance!, "x-chatspace-session": session.id, "x-chatspace-epoch": String(session.epoch) } });
      return boundedBody(response, this.responseLimit);
    }, 300_000);
  }
  async submit(session: Session, token: string, op: Pick<Operation, "id" | "tool" | "arguments" | "inputCheckpoint">): Promise<ExecutorReceipt> {
    return JSON.parse(new TextDecoder().decode(await this.request(session, token, "/control/managed/operations", { method: "POST",
      body: JSON.stringify({ operationId: op.id, sessionId: session.id, epoch: session.epoch,
        inputCheckpointId: op.inputCheckpoint, tool: op.tool, arguments: JSON.parse(op.arguments) }) })));
  }
  async receipt(session: Session, token: string, id: string): Promise<ExecutorReceipt> {
    return JSON.parse(new TextDecoder().decode(await this.request(session, token, `/control/managed/operations/${id}`, { method: "GET" })));
  }
  async health(session: Session, token: string): Promise<{ sessionId: string; epoch: number; unknown: boolean; ready: boolean; protocolVersion: number }> {
    return JSON.parse(new TextDecoder().decode(await this.request(session, token, "/control/managed/health", { method: "GET" })));
  }
  async advanceLease(session: Session, token: string, oldEpoch: number): Promise<void> {
    await this.request({ ...session, epoch: oldEpoch }, token, "/control/managed/lease/advance", { method: "POST", body: JSON.stringify({ epoch: session.epoch }) });
  }
  checkpoint(session: Session, token: string, id: string): Promise<Uint8Array> {
    return this.request(session, token, `/control/managed/files/${id}`, { method: "GET" });
  }
  exportFile(session: Session, token: string, id: string): Promise<Uint8Array> {
    return this.request(session, token, `/control/exports/${id}`, { method: "GET" });
  }
  async uploadRestore(session: Session, token: string, id: string, bytes: Uint8Array): Promise<void> {
    // Immutable transfer; a failed upload does not load the scene.
    try {
      await this.request(session, token, `/control/managed/files/${id}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(bytes) });
    } catch {
      const persisted = await this.checkpoint(session, token, id);
      if (persisted.length !== bytes.length || sha256(persisted) !== sha256(bytes)) throw new Error("Restore upload mismatch");
    }
  }
}
