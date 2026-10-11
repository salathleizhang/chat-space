import type { SqlDatabase } from "./sql";
import { createHash, randomUUID } from "node:crypto";
import { BlenderBudgets, type BudgetLimits } from "./budgets";
import { DEFAULT_BLENDER_LIMITS } from "./limits";

export type SessionState = "queued" | "allocating" | "preparing" | "ready" | "saving" | "cleaning" | "pausing" | "paused" | "quarantined" | "expired";
export type OperationState = "queued" | "dispatched" | "succeeded" | "failed" | "unknown";
export interface Session {
  id: string; owner: string; project: string; batchId: string | null; itemId: string | null;
  state: SessionState; epoch: number; instance: string | null; build: string;
  checkpoint: string | null; createdAt: number; updatedAt: number; deadline: number;
  stopReason: string | null; lastActivity: number;
  budgetMs: number;
}
export interface Operation {
  id: string; sessionId: string; epoch: number; inputCheckpoint: string | null;
  key: string; digest: string; tool: string; arguments: string; state: OperationState;
  result: string | null; createdAt: number; updatedAt: number;
}
export interface Checkpoint {
  id: string; sessionId: string; epoch: number; build: string; manifestKey: string;
  sceneKey: string; sha256: string; bytes: number; createdAt: number;
}
const ACTIVE = "'allocating','preparing','ready','saving','cleaning','pausing','quarantined'";
export class BlenderConflict extends Error {}

/** One capacity pool. Admission, budgets and lease fencing share synchronous transactions. */
export class BlenderStore {
  readonly db: SqlDatabase;
  readonly budgets: BlenderBudgets;
  constructor(database: SqlDatabase, readonly limits = DEFAULT_BLENDER_LIMITS, budgetLimits?: BudgetLimits) {
    if (![limits.global, limits.owner, limits.queued].every(n => Number.isInteger(n) && n > 0)) throw new Error("Invalid Blender quotas");
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, batchId TEXT, itemId TEXT,
        state TEXT NOT NULL, epoch INTEGER NOT NULL, instance TEXT, build TEXT NOT NULL,
        checkpoint TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deadline INTEGER NOT NULL,
        stopReason TEXT, lastActivity INTEGER NOT NULL, budgetMs INTEGER NOT NULL, UNIQUE(owner,batchId,itemId));
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), epoch INTEGER NOT NULL,
        inputCheckpoint TEXT, key TEXT NOT NULL, digest TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(sessionId,key));
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), epoch INTEGER NOT NULL,
        build TEXT NOT NULL, manifestKey TEXT NOT NULL, sceneKey TEXT NOT NULL, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_credentials (sessionId TEXT NOT NULL, epoch INTEGER NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY(sessionId,epoch));
      CREATE TABLE IF NOT EXISTS lifecycle_effects (sessionId TEXT NOT NULL, epoch INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(sessionId,epoch,kind));
      CREATE TABLE IF NOT EXISTS batches (id TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, digest TEXT NOT NULL,
        concurrency INTEGER NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS resource_leases (instanceId TEXT NOT NULL, sessionId TEXT NOT NULL REFERENCES sessions(id),
        epoch INTEGER NOT NULL, state TEXT NOT NULL, build TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(instanceId,sessionId,epoch));
      CREATE INDEX IF NOT EXISTS session_owner ON sessions(owner,state);
      CREATE INDEX IF NOT EXISTS operation_queue ON operations(sessionId,state,createdAt);`);
    this.budgets = new BlenderBudgets(this.db, budgetLimits);
    // Upgrading an existing controller cannot make already-running cloud resources free.
    // Unknown/quarantined resources retain their full hold, even if this exceeds the new cap.
    this.db.transaction(() => {
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      for (const s of this.db.query<Session, []>(`SELECT * FROM sessions WHERE state IN (${ACTIVE})`).all()) {
        const quantity = Math.max(180_000, Math.ceil(s.budgetMs / 60_000) * 60_000);
        this.db.query("INSERT OR IGNORE INTO blender_budget_entries VALUES (?,?, 'runtime',?,?,?,0)")
          .run(`runtime:${s.id}:${s.epoch}`, s.owner, day, quantity, Math.min(now, s.deadline - s.budgetMs));
      }
    }).immediate();
  }
  close() { this.db.close(); }
  saveCredentials(id: string, epoch: number, sealed: string): void {
    this.db.query("INSERT INTO sandbox_credentials VALUES (?,?,?)").run(id, epoch, sealed);
  }
  credentials(id: string, epoch: number): string {
    const row = this.db.query<{ sealed: string }, [string, number]>("SELECT sealed FROM sandbox_credentials WHERE sessionId=? AND epoch=?").get(id, epoch);
    if (!row) throw new BlenderConflict("Sandbox credentials unavailable");
    return row.sealed;
  }
  effect(id: string, epoch: number, kind: string): string | null {
    return this.db.query<{ value: string }, [string, number, string]>("SELECT value FROM lifecycle_effects WHERE sessionId=? AND epoch=? AND kind=?").get(id, epoch, kind)?.value ?? null;
  }
  setEffect(id: string, epoch: number, kind: string, value: string): void {
    this.db.query("INSERT INTO lifecycle_effects VALUES (?,?,?,?) ON CONFLICT(sessionId,epoch,kind) DO UPDATE SET value=excluded.value").run(id, epoch, kind, value);
  }
  clearEffect(id: string, epoch: number, kind: string): void {
    this.db.query("DELETE FROM lifecycle_effects WHERE sessionId=? AND epoch=? AND kind=?").run(id, epoch, kind);
  }
  pendingOperations(sessionId: string): Operation[] {
    return this.db.query<Operation, [string]>("SELECT o.* FROM operations o JOIN sessions s ON s.id=o.sessionId WHERE o.sessionId=? AND o.epoch=s.epoch AND o.state IN ('dispatched','unknown') ORDER BY o.rowid").all(sessionId);
  }
  hasQueuedOperations(sessionId: string): boolean {
    return Boolean(this.db.query("SELECT o.id FROM operations o JOIN sessions s ON s.id=o.sessionId WHERE o.sessionId=? AND o.epoch=s.epoch AND o.state='queued'").get(sessionId));
  }
  session(id: string, owner?: string): Session {
    const row = this.db.query<Session, [string]>("SELECT * FROM sessions WHERE id=?").get(id);
    if (!row || owner !== undefined && row.owner !== owner) throw new BlenderConflict("Session unavailable");
    return row;
  }
  list(owner?: string): Session[] {
    return owner === undefined ? this.db.query<Session, []>("SELECT * FROM sessions ORDER BY createdAt,rowid").all() :
      this.db.query<Session, [string]>("SELECT * FROM sessions WHERE owner=? ORDER BY createdAt,rowid").all(owner);
  }
  create(owner: string, project: string, build: string, budgetMs: number, batchId: string | null = null, itemId: string | null = null): Session {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project) || !build || !Number.isSafeInteger(budgetMs) || budgetMs < 60_000 || budgetMs > 3_600_000) throw new BlenderConflict("Invalid session request");
    return this.db.transaction(() => {
      if (batchId && itemId) {
        const previous = this.db.query<Session, [string, string, string]>("SELECT * FROM sessions WHERE owner=? AND batchId=? AND itemId=?").get(owner, batchId, itemId);
        if (previous) {
          if (previous.project !== project || previous.build !== build) throw new BlenderConflict("Idempotency key reused with different session");
          return previous;
        }
      }
      const queued = this.db.query<{ n: number }, [string]>("SELECT count(*) n FROM sessions WHERE owner=? AND state='queued'").get(owner)!.n;
      if (queued >= this.limits.queued) throw new BlenderConflict("Queue quota reached");
      const now = Date.now(), id = randomUUID();
      this.db.query("INSERT INTO sessions VALUES (?,?,?,?,?,'queued',0,NULL,?,NULL,?,?,0,NULL,?,?)")
        .run(id, owner, project, batchId, itemId, build, now, now, now, budgetMs);
      return this.session(id);
    }).immediate();
  }
  /** Round robin between owners; quarantined/unconfirmed pauses still consume a slot. */
  reserveNext(now = Date.now()): Session | null {
    return this.db.transaction(() => {
      const total = this.db.query<{ n: number }, []>(`SELECT count(*) n FROM sessions WHERE state IN (${ACTIVE})`).get()!.n;
      if (total >= this.limits.global) return null;
      const last = this.db.query<{ value: string }, []>("SELECT value FROM service_meta WHERE key='last-owner'").get()?.value ?? "";
      const candidates = this.db.query<Session, [number]>(`SELECT s.* FROM sessions s WHERE state='queued' AND stopReason IS NULL
        AND (SELECT count(*) FROM sessions a WHERE a.owner=s.owner AND a.state IN (${ACTIVE}))<?
        AND (s.batchId IS NULL OR (SELECT count(*) FROM sessions a WHERE a.owner=s.owner AND a.batchId=s.batchId AND a.state IN (${ACTIVE}))
          < COALESCE((SELECT concurrency FROM batches b WHERE b.owner=s.owner AND b.id=s.batchId),${this.limits.owner}))
        ORDER BY s.createdAt,s.rowid`).all(this.limits.owner);
      const owners = [...new Set(candidates.map(s => s.owner))];
      if (!owners.length) return null;
      const owner = owners[(owners.indexOf(last) + 1) % owners.length]!;
      const ordered = [...candidates.filter(s => s.owner === owner), ...candidates.filter(s => s.owner !== owner)];
      const chosen = ordered.find(s => {
        const quantity = Math.max(180_000, Math.ceil(s.budgetMs / 60_000) * 60_000);
        const accepted = this.budgets.reserve(`runtime:${s.id}:${s.epoch + 1}`, s.owner, "runtime", quantity, now);
        if (!accepted) this.setEffect(s.id, s.epoch, "budget-wait", "daily_runtime_limit");
        return accepted;
      });
      if (!chosen) return null;
      this.db.query("UPDATE sessions SET state='allocating',epoch=epoch+1,updatedAt=?,deadline=?+budgetMs WHERE id=? AND state='queued'").run(now, now, chosen.id);
      this.db.query("INSERT INTO service_meta VALUES ('last-owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(chosen.owner);
      return this.session(chosen.id);
    }).immediate();
  }
  transition(id: string, epoch: number, from: SessionState[], state: SessionState, instance?: string): Session {
    return this.db.transaction(() => {
      const row = this.session(id);
      if (row.epoch !== epoch || !from.includes(row.state)) throw new BlenderConflict("Stale lease or invalid transition");
      const now = Date.now();
      this.db.query("UPDATE sessions SET state=?,instance=?,updatedAt=?,lastActivity=? WHERE id=?")
        .run(state, instance ?? row.instance, now, state === "ready" && row.state === "preparing" ? now : row.lastActivity, id);
      if (state === "paused" || state === "expired") this.budgets.settleRuntime(`runtime:${id}:${epoch}`, now);
      const resource = instance ?? row.instance;
      if (resource) {
        const other = this.db.query("SELECT instanceId FROM resource_leases WHERE instanceId=? AND sessionId<>? AND state<>'expired'").get(resource, id);
        if (other) throw new BlenderConflict("Resource requires verified reset before reassignment");
        this.db.query("INSERT INTO resource_leases VALUES (?,?,?,?,?,?) ON CONFLICT(instanceId,sessionId,epoch) DO UPDATE SET state=excluded.state,updatedAt=excluded.updatedAt")
          .run(resource, id, epoch, state, row.build, Date.now());
      }
      return this.session(id);
    }).immediate();
  }
  stop(id: string, owner: string, reason: "cancelled" | "waiting-user" | "budget" | "ended"): Session {
    const row = this.session(id, owner);
    this.db.query("UPDATE sessions SET stopReason=?,state=CASE WHEN state='queued' THEN 'paused' ELSE state END,updatedAt=? WHERE id=?").run(reason, Date.now(), id);
    return this.session(row.id);
  }
  recordDesktopActivity(id: string, owner: string, epoch: number, now = Date.now()): void {
    this.db.transaction(() => {
      const session = this.session(id, owner);
      const live = session.state === "ready" || session.state === "saving" && this.effect(id, epoch, "save-mode") === "continue";
      if (session.epoch !== epoch || session.itemId !== "interactive" || !live || session.stopReason || session.deadline <= now) {
        throw new BlenderConflict("Manual desktop lease unavailable");
      }
      // Read/connection heartbeats and checkpoints never call this or extend the budget.
      this.db.query("UPDATE sessions SET lastActivity=? WHERE id=?").run(now, id);
    }).immediate();
  }
  submit(owner: string, sessionId: string, epoch: number, key: string, tool: string, args: Record<string, unknown>, operationId: string = randomUUID()): Operation {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) throw new BlenderConflict("Invalid operation key or id");
    const argumentsJson = JSON.stringify(args), digest = createHash("sha256").update(JSON.stringify([epoch, tool, args])).digest("hex");
    if (argumentsJson.length > 128_000) throw new BlenderConflict("Operation too large");
    return this.db.transaction(() => {
      const session = this.session(sessionId, owner);
      if (session.epoch !== epoch) throw new BlenderConflict("Stale lease");
      const old = this.db.query<Operation, [string, string]>("SELECT * FROM operations WHERE sessionId=? AND key=?").get(sessionId, key);
      if (old) { if (old.digest !== digest) throw new BlenderConflict("Operation key reused"); return old; }
      if (session.state !== "ready" || session.stopReason || session.deadline <= Date.now()) throw new BlenderConflict("Session cannot accept commands");
      const pending = this.db.query<{ n: number }, [string, number]>("SELECT count(*) n FROM operations WHERE sessionId=? AND epoch=? AND state IN ('queued','dispatched','unknown')").get(sessionId, epoch)!.n;
      if (pending >= 20) throw new BlenderConflict("Operation queue full");
      const now = Date.now(), id = operationId;
      this.db.query("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,'queued',NULL,?,?)").run(id, sessionId, epoch, session.checkpoint, key, digest, tool, argumentsJson, now, now);
      this.db.query("UPDATE sessions SET lastActivity=? WHERE id=?").run(now, sessionId);
      return this.operation(id, owner);
    }).immediate();
  }
  operation(id: string, owner?: string): Operation {
    const op = this.db.query<Operation, [string]>("SELECT * FROM operations WHERE id=?").get(id);
    if (!op) throw new BlenderConflict("Operation unavailable");
    this.session(op.sessionId, owner);
    return op;
  }
  claimOperation(sessionId: string, epoch: number): Operation | null {
    return this.db.transaction(() => {
      const s = this.session(sessionId);
      if (s.epoch !== epoch || s.state !== "ready" || s.stopReason || s.deadline <= Date.now()) return null;
      if (this.db.query("SELECT id FROM operations WHERE sessionId=? AND epoch=? AND state IN ('dispatched','unknown')").get(sessionId, epoch)) return null;
      const op = this.db.query<Operation, [string, number]>("SELECT * FROM operations WHERE sessionId=? AND epoch=? AND state='queued' ORDER BY createdAt,rowid LIMIT 1").get(sessionId, epoch);
      if (!op) return null;
      this.db.query("UPDATE operations SET state='dispatched',inputCheckpoint=?,updatedAt=? WHERE id=?").run(s.checkpoint, Date.now(), op.id);
      return this.operation(op.id);
    }).immediate();
  }
  finishOperation(id: string, epoch: number, state: Exclude<OperationState, "queued" | "dispatched">, result: unknown): void {
    this.db.transaction(() => {
      const op = this.operation(id), s = this.session(op.sessionId);
      if (op.epoch !== epoch || s.epoch !== epoch || !["dispatched", "unknown"].includes(op.state)) throw new BlenderConflict("Stale operation receipt");
      const data = JSON.stringify(result);
      if (data.length > 16 * 1024 * 1024) throw new BlenderConflict("Receipt too large");
      this.db.query("UPDATE operations SET state=?,result=?,updatedAt=? WHERE id=?").run(state, data, Date.now(), id);
    }).immediate();
  }
  commitCheckpoint(checkpoint: Checkpoint): void {
    this.db.transaction(() => {
      const s = this.session(checkpoint.sessionId);
      if (s.epoch !== checkpoint.epoch || s.build !== checkpoint.build || !["ready", "saving"].includes(s.state)) throw new BlenderConflict("Stale checkpoint");
      const existing = this.db.query<Checkpoint, [string]>("SELECT * FROM checkpoints WHERE id=?").get(checkpoint.id);
      if (existing) {
        if (existing.sessionId !== checkpoint.sessionId || existing.sha256 !== checkpoint.sha256 || existing.build !== checkpoint.build) throw new BlenderConflict("Checkpoint id reused");
        return;
      }
      this.db.query("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?)").run(checkpoint.id, checkpoint.sessionId, checkpoint.epoch, checkpoint.build,
        checkpoint.manifestKey, checkpoint.sceneKey, checkpoint.sha256, checkpoint.bytes, checkpoint.createdAt);
      this.db.query("UPDATE sessions SET checkpoint=?,updatedAt=? WHERE id=?").run(checkpoint.id, Date.now(), s.id);
    }).immediate();
  }
  checkpoint(id: string): Checkpoint {
    const c = this.db.query<Checkpoint, [string]>("SELECT * FROM checkpoints WHERE id=?").get(id);
    if (!c) throw new BlenderConflict("Checkpoint unavailable");
    return c;
  }
  /** Restart must reconcile receipts. Never turn sent operations back into executable queue entries. */
  recoverDispatched(): void {
    this.db.query("UPDATE operations SET state='unknown',updatedAt=? WHERE state='dispatched'").run(Date.now());
  }
  /** Reallocate only from a committed scene and a known receipt boundary, within the original budget. */
  recoverExpired(id: string, epoch: number, now: number): boolean {
    return this.db.transaction(() => {
      const s = this.session(id);
      const remaining = s.deadline - now;
      const attempts = Number(this.effect(id, epoch, "recovery-count") ?? "0");
      if (s.epoch !== epoch || s.state !== "expired" || s.stopReason || !s.checkpoint || remaining < 180_000 || attempts >= 2 ||
        this.effect(id, epoch, "checkpoint-due") || this.pendingOperations(id).length) return false;
      this.setEffect(id, epoch + 1, "recovery-count", String(attempts + 1));
      this.setEffect(id, epoch + 1, "recovered-from", s.checkpoint);
      this.db.query("UPDATE sessions SET state='queued',budgetMs=?,instance=NULL,updatedAt=? WHERE id=?").run(remaining, now, id);
      // These commands were never sent. Preserve their identities and input, fence their new dispatch.
      const queued = this.db.query<Operation, [string, number]>("SELECT * FROM operations WHERE sessionId=? AND epoch=? AND state='queued'").all(id, epoch);
      for (const op of queued) {
        const digest = createHash("sha256").update(JSON.stringify([epoch + 1, op.tool, JSON.parse(op.arguments)])).digest("hex");
        this.db.query("UPDATE operations SET epoch=?,digest=?,inputCheckpoint=?,updatedAt=? WHERE id=?").run(epoch + 1, digest, s.checkpoint, now, op.id);
      }
      return true;
    }).immediate();
  }
  resume(id: string, owner: string): Session {
    return this.db.transaction(() => {
      const s = this.session(id, owner);
      if (!["paused", "expired"].includes(s.state) || !s.checkpoint) throw new BlenderConflict("Confirmed pause/expiry and checkpoint required");
      // Uncertain Python freezes that executor permanently; rollback uses a fresh sandbox.
      if (s.state === "paused" && s.instance && !this.effect(id, s.epoch, "executor-unknown") && !this.pendingOperations(id).some(op => op.state === "unknown"))
        this.setEffect(id, s.epoch + 1, "resume-source", JSON.stringify({ instance: s.instance, epoch: s.epoch }));
      this.db.query("UPDATE sessions SET state='queued',stopReason=NULL,updatedAt=? WHERE id=?").run(Date.now(), id);
      return this.session(id);
    }).immediate();
  }
}
