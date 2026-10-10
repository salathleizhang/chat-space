import { randomUUID } from "node:crypto";
import { onTaskPumpTick, tickTaskPumps } from "../common/taskPump";
import { BlenderStore, type Session, type Operation } from "./store";
import { SandboxSecrets } from "./secrets";
import type { VolcanoSandboxes } from "./volcano";
import type { ManagedExecutor, ExecutorReceipt } from "./executor";
import type { Checkpoints } from "./checkpoints";

interface Dependencies {
  sandboxes: Pick<VolcanoSandboxes, "create" | "list" | "pause"> & Partial<Pick<VolcanoSandboxes, "resume">>;
  executor: Pick<ManagedExecutor, "submit" | "receipt" | "health" | "checkpoint"> & Partial<Pick<ManagedExecutor, "advanceLease" | "uploadRestore">>;
  checkpoints: Pick<Checkpoints, "commit"> & Partial<Pick<Checkpoints, "read">>;
  runner?: { step: (session: Session) => Promise<void>; interrupt?: (session: Session, reason: string) => void };
  publishExport?: (session: Session, operation: Operation) => Promise<void>;
}
/** Tick-driven state machine. Every external effect is journaled before leaving the process. */
export class BlenderScheduler {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly nextAt = new Map<string, number>();
  private readonly unsubscribe: () => void;
  constructor(readonly store: BlenderStore, private readonly secrets: SandboxSecrets, private readonly deps: Dependencies) {
    store.recoverDispatched();
    this.unsubscribe = onTaskPumpTick(() => this.advance(Date.now()));
  }
  close() { this.unsubscribe(); }
  tick(now = Date.now()) { tickTaskPumps(undefined, now); this.advance(now); }
  async drain(): Promise<void> { await Promise.all([...this.flights.values()]); }
  private advance(now: number) {
    // Reserve slots synchronously, before starting async create calls.
    for (;;) { const s = this.store.reserveNext(now); if (!s) break; }
    for (const session of this.store.list()) {
      if (["queued", "paused", "expired"].includes(session.state) || this.flights.has(session.id) || (this.nextAt.get(session.id) ?? 0) > now) continue;
      const work = this.step(session, now).then(() => this.store.clearEffect(session.id, session.epoch, "failures")).catch(() => {
        // Do not log raw provider bodies, credentials, user code or signed URLs.
        this.nextAt.set(session.id, Date.now() + 10_000);
        const failures = Number(this.store.effect(session.id, session.epoch, "failures") ?? "0") + 1;
        this.store.setEffect(session.id, session.epoch, "failures", String(failures));
        const current = this.store.session(session.id);
        if (failures >= 6 && current.epoch === session.epoch && ["preparing", "ready", "saving"].includes(current.state)) {
          this.quarantine(current, "sandbox_unreachable");
        }
      }).finally(() => { if (this.flights.get(session.id) === work) this.flights.delete(session.id); });
      this.flights.set(session.id, work);
    }
  }
  private token(s: Session): string { return this.secrets.open(this.store.credentials(s.id, s.epoch), s.id, s.epoch).control; }
  private quarantine(s: Session, reason: string, executorUnknown = false) {
    if (executorUnknown) this.store.setEffect(s.id, s.epoch, "executor-unknown", "1");
    this.store.transition(s.id, s.epoch, [s.state], "quarantined");
    this.deps.runner?.interrupt?.(s, reason);
  }
  private async step(s: Session, now: number): Promise<void> {
    this.nextAt.set(s.id, now + 5_000);
    if (s.instance && ["preparing", "ready", "saving", "cleaning"].includes(s.state) && now - s.updatedAt >= 30_000 &&
      Number(this.store.effect(s.id, s.epoch, "checked-at") ?? "0") + 30_000 <= now) {
      const instances = await this.deps.sandboxes.list({ instance: s.instance });
      this.store.setEffect(s.id, s.epoch, "checked-at", String(now));
      if (!instances.length) {
        this.store.transition(s.id, s.epoch, [s.state], "expired");
        if (!this.store.recoverExpired(s.id, s.epoch, now)) this.deps.runner?.interrupt?.(s, "sandbox_expired");
        return;
      }
      if (instances.length !== 1 || instances[0]!.type === "frozen" || ["Failed", "Terminating"].includes(instances[0]!.status)) {
        this.quarantine(s, "sandbox_state_unavailable"); return;
      }
    }
    if (s.state === "allocating") {
      const sourceRaw = this.store.effect(s.id, s.epoch, "resume-source");
      if (sourceRaw) {
        const source = JSON.parse(sourceRaw) as { instance: string; epoch: number };
        if (!this.deps.sandboxes.resume) throw new Error("Resume adapter missing");
        const requested = this.store.effect(s.id, s.epoch, "resume");
        if (requested) {
          const candidates = (await this.deps.sandboxes.list({ sessionId: s.id, epoch: source.epoch })).filter(i => i.type === "activated" && !["Failed", "Terminating"].includes(i.status));
          if (candidates.length === 1) this.store.transition(s.id, s.epoch, ["allocating"], "preparing", candidates[0]!.id);
          else this.quarantine(s, "resume_result_unknown");
          return;
        }
        const value = this.secrets.open(this.store.credentials(s.id, source.epoch), s.id, source.epoch);
        this.store.saveCredentials(s.id, s.epoch, this.secrets.seal(value, s.id, s.epoch));
        this.store.setEffect(s.id, s.epoch, "resume", "requested");
        const instance = await this.deps.sandboxes.resume(source.instance);
        this.store.transition(s.id, s.epoch, ["allocating"], "preparing", instance); return;
      }
      if (this.store.effect(s.id, s.epoch, "create")) {
        // A previous process might have died between cloud creation and saving its response.
        const matches = await this.deps.sandboxes.list({ sessionId: s.id, epoch: s.epoch });
        if (matches.length === 1) { this.store.transition(s.id, s.epoch, ["allocating"], "preparing", matches[0]!.id); return; }
        // Empty/ambiguous results are not permission to repeat a potentially billed create.
        this.quarantine(s, "allocation_result_unknown"); return;
      }
      const value = this.secrets.generate();
      this.store.saveCredentials(s.id, s.epoch, this.secrets.seal(value, s.id, s.epoch));
      this.store.setEffect(s.id, s.epoch, "create", "requested");
      const instance = await this.deps.sandboxes.create(s.id, s.epoch, value, Math.max(3, Math.ceil(s.budgetMs / 60_000)));
      this.store.transition(s.id, s.epoch, ["allocating"], "preparing", instance);
      return;
    }
    if (s.state === "preparing") {
      const sourceRaw = this.store.effect(s.id, s.epoch, "resume-source");
      if (sourceRaw && !this.store.effect(s.id, s.epoch, "lease-advanced")) {
        const source = JSON.parse(sourceRaw) as { epoch: number };
        try { await this.deps.executor.health(s, this.token(s)); }
        catch {
          if (!this.deps.executor.advanceLease) throw new Error("Lease advancement adapter missing");
          await this.deps.executor.advanceLease(s, this.token(s), source.epoch);
        }
        this.store.setEffect(s.id, s.epoch, "lease-advanced", "confirmed");
      }
      const health = await this.deps.executor.health(s, this.token(s));
      if (health.sessionId !== s.id || health.epoch !== s.epoch || health.unknown || health.protocolVersion !== 1) {
        this.quarantine(s, health.unknown ? "scene_result_unknown" : "executor_identity_mismatch", health.unknown); return;
      }
      if (!health.ready) {
        if (now - s.updatedAt >= 180_000) {
          this.quarantine(s, "blender_startup_failed");
        }
        return;
      }
      if (s.checkpoint && !await this.restore(s)) return;
      this.store.transition(s.id, s.epoch, ["preparing"], "ready"); return;
    }
    if (s.state === "ready") {
      const pending = this.store.pendingOperations(s.id);
      if (pending.length) {
        const op = pending[0]!;
        const receipt = await this.deps.executor.receipt(s, this.token(s), op.id);
        this.record(s, op, receipt); return;
      }
      const exportDue = this.store.effect(s.id, s.epoch, "export-due");
      if (exportDue) {
        if (!this.deps.publishExport) throw new Error("Export publishing adapter missing");
        await this.deps.publishExport(s, this.store.operation(exportDue));
        this.store.clearEffect(s.id, s.epoch, "export-due"); return;
      }
      if (s.itemId === "interactive" && !this.store.hasQueuedOperations(s.id)) {
        const savedAt = this.store.effect(s.id, s.epoch, "checkpoint-at");
        if (!savedAt) this.store.setEffect(s.id, s.epoch, "checkpoint-at", String(now));
        else if (now - Number(savedAt) >= 60_000) this.store.setEffect(s.id, s.epoch, "checkpoint-due", "1");
      }
      // Leave time for an in-flight command, a packed checkpoint upload and the pause request.
      if (!s.stopReason && s.deadline - 120_000 <= now) s = this.store.stop(s.id, s.owner, "budget");
      if (this.store.effect(s.id, s.epoch, "checkpoint-due") && !s.stopReason) {
        this.store.setEffect(s.id, s.epoch, "save-mode", "continue");
        this.store.transition(s.id, s.epoch, ["ready"], "saving"); return;
      }
      if (!s.stopReason && !this.store.hasQueuedOperations(s.id) && this.deps.runner) {
        await this.deps.runner.step(s);
        s = this.store.session(s.id);
      }
      if (s.stopReason || !this.store.hasQueuedOperations(s.id) && now - s.lastActivity >= 5 * 60_000) {
        this.store.setEffect(s.id, s.epoch, "save-mode", "end");
        this.store.transition(s.id, s.epoch, ["ready"], "saving"); return;
      }
      const op = this.store.claimOperation(s.id, s.epoch);
      if (!op) return;
      try { this.record(s, op, await this.deps.executor.submit(s, this.token(s), op)); }
      catch { this.store.finishOperation(op.id, s.epoch, "unknown", { error: "receipt_required" }); }
      return;
    }
    if (s.state === "saving") {
      let raw = this.store.effect(s.id, s.epoch, "save");
      if (!raw) {
        const id = randomUUID(), fileId = randomUUID();
        raw = JSON.stringify({ id, fileId, requested: false });
        this.store.setEffect(s.id, s.epoch, "save", raw);
      }
      const effect = JSON.parse(raw) as { id: string; fileId: string; requested: boolean; committed?: boolean };
      if (effect.committed) { this.afterSave(s); return; }
      let receipt: ExecutorReceipt;
      if (!effect.requested) {
        effect.requested = true;
        this.store.setEffect(s.id, s.epoch, "save", JSON.stringify(effect));
        receipt = await this.deps.executor.submit(s, this.token(s), { id: effect.id, tool: "_checkpoint", arguments: JSON.stringify({ fileId: effect.fileId }), inputCheckpoint: s.checkpoint });
      } else receipt = await this.deps.executor.receipt(s, this.token(s), effect.id);
      if (receipt.state === "unknown" || receipt.state === "failed") { this.quarantine(s, "checkpoint_not_confirmed", true); return; }
      if (receipt.state !== "succeeded") return;
      const scene = await this.deps.executor.checkpoint(s, this.token(s), effect.fileId);
      await this.deps.checkpoints.commit(s, scene, effect.fileId);
      this.store.setEffect(s.id, s.epoch, "save", JSON.stringify({ ...effect, committed: true }));
      this.afterSave(s); return;
    }
    if (s.state === "cleaning") {
      // Cross-owner reset has not been proven for this customized desktop yet.
      // Keep the snapshot private to its lease; do not advertise it as a clean pool member.
      this.store.setEffect(s.id, s.epoch, "reuse", "requires-verified-reset");
      this.store.transition(s.id, s.epoch, ["cleaning"], "pausing"); return;
    }
    if (s.state === "pausing") {
      if (!s.instance) { this.quarantine(s, "sandbox_identity_missing"); return; }
      const existing = await this.deps.sandboxes.list({ instance: s.instance });
      if (existing.length === 0) { this.store.transition(s.id, s.epoch, ["pausing"], "expired"); return; }
      if (existing.length === 1 && existing[0]!.type === "frozen") { this.store.transition(s.id, s.epoch, ["pausing"], "paused"); return; }
      if (!this.store.effect(s.id, s.epoch, "pause")) {
        this.store.setEffect(s.id, s.epoch, "pause", "requested");
        await this.deps.sandboxes.pause(s.instance);
      }
      return;
    }
    if (s.state === "quarantined") {
      // Resource uncertainty is visible and occupies capacity. Only confirmed expiry frees it.
      const instances = s.instance ? await this.deps.sandboxes.list({ instance: s.instance }) :
        await this.deps.sandboxes.list({ sessionId: s.id, epoch: s.epoch });
      if (instances.length === 0 && now > s.deadline + 60_000) { this.store.transition(s.id, s.epoch, ["quarantined"], "expired"); return; }
      if (instances.length === 1 && instances[0]!.type === "frozen") {
        this.store.transition(s.id, s.epoch, ["quarantined"], "paused", instances[0]!.id); return;
      }
      if (instances.length === 1 && !this.store.effect(s.id, s.epoch, "quarantine-pause")) {
        this.store.setEffect(s.id, s.epoch, "quarantine-pause", "requested");
        await this.deps.sandboxes.pause(instances[0]!.id);
      }
    }
  }
  private record(s: Session, op: Operation, receipt: ExecutorReceipt) {
    if (receipt.id !== op.id) throw new Error("Wrong executor receipt");
    if (["succeeded", "failed", "unknown"].includes(receipt.state)) {
      this.store.db.transaction(() => {
        this.store.finishOperation(op.id, s.epoch, receipt.state as "succeeded" | "failed" | "unknown", receipt.result);
        if (receipt.state === "succeeded" && ["execute_blender_code", "export_scene"].includes(op.tool)) this.store.setEffect(s.id, s.epoch, "checkpoint-due", "1");
        if (receipt.state === "succeeded" && op.tool === "export_scene") this.store.setEffect(s.id, s.epoch, "export-due", op.id);
      }).immediate();
      if (receipt.state === "unknown") {
        this.quarantine(s, "scene_result_unknown", true);
      }
    }
  }
  private afterSave(s: Session) {
    this.store.setEffect(s.id, s.epoch, "checkpoint-at", String(Date.now()));
    if (!s.stopReason && this.store.effect(s.id, s.epoch, "save-mode") === "continue") {
      this.store.clearEffect(s.id, s.epoch, "save");
      this.store.clearEffect(s.id, s.epoch, "checkpoint-due");
      this.store.transition(s.id, s.epoch, ["saving"], "ready");
    } else this.store.transition(s.id, s.epoch, ["saving"], "cleaning");
  }
  private async restore(s: Session): Promise<boolean> {
    if (!this.deps.checkpoints.read || !this.deps.executor.uploadRestore) throw new Error("Checkpoint restoration adapter missing");
    let raw = this.store.effect(s.id, s.epoch, "restore");
    if (!raw) {
      raw = JSON.stringify({ id: randomUUID(), fileId: randomUUID(), uploaded: false, requested: false, complete: false });
      this.store.setEffect(s.id, s.epoch, "restore", raw);
    }
    const effect = JSON.parse(raw) as { id: string; fileId: string; uploaded: boolean; requested: boolean; complete: boolean };
    if (effect.complete) return true;
    if (!effect.uploaded) {
      await this.deps.executor.uploadRestore(s, this.token(s), effect.fileId, await this.deps.checkpoints.read(s));
      effect.uploaded = true; this.store.setEffect(s.id, s.epoch, "restore", JSON.stringify(effect));
    }
    let receipt: ExecutorReceipt;
    if (!effect.requested) {
      effect.requested = true; this.store.setEffect(s.id, s.epoch, "restore", JSON.stringify(effect));
      receipt = await this.deps.executor.submit(s, this.token(s), { id: effect.id, tool: "_restore", arguments: JSON.stringify({ fileId: effect.fileId }), inputCheckpoint: s.checkpoint });
    } else receipt = await this.deps.executor.receipt(s, this.token(s), effect.id);
    if (receipt.state === "unknown" || receipt.state === "failed") {
      this.quarantine(s, "restore_not_confirmed", true); return false;
    }
    if (receipt.state !== "succeeded") return false;
    effect.complete = true; this.store.setEffect(s.id, s.epoch, "restore", JSON.stringify(effect)); return true;
  }
}
