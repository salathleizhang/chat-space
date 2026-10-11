import { createHash } from "node:crypto";
import { BlenderConflict, BlenderStore, type Session } from "./storeCore";
import { DEFAULT_BLENDER_CONCURRENCY } from "./limits";
export interface BatchItem { id: string; label: string; prompt: string }
export interface Job {
  sessionId: string; label: string; prompt: string; state: "queued" | "running" | "planning" | "waiting-user" | "succeeded" | "failed" | "cancelled";
  messages: string; step: number; requests: number; tokens: number; pendingOperation: string | null; error: string | null;
}
export class BlenderJobs {
  constructor(readonly store: BlenderStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, digest TEXT NOT NULL,
      concurrency INTEGER NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS blender_jobs (sessionId TEXT PRIMARY KEY REFERENCES sessions(id), label TEXT NOT NULL, prompt TEXT NOT NULL,
      state TEXT NOT NULL, messages TEXT NOT NULL, step INTEGER NOT NULL, requests INTEGER NOT NULL, tokens INTEGER NOT NULL,
      pendingOperation TEXT, error TEXT);`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS blender_retries (owner TEXT NOT NULL, requestId TEXT NOT NULL, source TEXT NOT NULL,
      sessionId TEXT NOT NULL, PRIMARY KEY(owner,requestId));`);
    store.db.transaction(() => {
      if (store.db.query("SELECT key FROM service_meta WHERE key='model-budget-v1'").get()) return;
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      const existing = store.db.query<{ sessionId: string; owner: string; requests: number }, []>(
        "SELECT j.sessionId,s.owner,j.requests FROM blender_jobs j JOIN sessions s ON s.id=j.sessionId WHERE j.requests>0").all();
      for (const job of existing) {
        const accounted = store.db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(quantity),0) n FROM blender_budget_entries WHERE kind='model-call' AND id LIKE ?")
          .get(`model:${job.sessionId}:%`)!.n;
        // Older databases lack call timestamps. Conservatively charge the missing calls on upgrade day.
        if (job.requests > accounted) store.db.query("INSERT INTO blender_budget_entries VALUES (?,?, 'model-call',?,?,?,1)")
          .run(`legacy-model:${job.sessionId}`, job.owner, day, job.requests - accounted, now);
      }
      store.db.query("INSERT INTO service_meta VALUES ('model-budget-v1', 'complete')").run();
    }).immediate();
  }
  createBatch(owner: string, project: string, id: string, items: BatchItem[], build: string, concurrency = DEFAULT_BLENDER_CONCURRENCY): Session[] {
    if (!/^[a-f0-9-]{36}$/.test(id) || items.length < 1 || items.length > 100 || new Set(items.map(i => i.id)).size !== items.length ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > this.store.limits.owner ||
      items.some(i => !/^[A-Za-z0-9_-]{1,128}$/.test(i.id) || !i.prompt.trim() || i.prompt.length > 20_000 || i.label.length > 128)) throw new BlenderConflict("Invalid batch");
    const digest = createHash("sha256").update(JSON.stringify({ project, items, build, concurrency })).digest("hex");
    return this.store.db.transaction(() => {
      const old = this.store.db.query<{ digest: string }, [string, string]>("SELECT digest FROM batches WHERE id=? AND owner=?").get(id, owner);
      if (old) {
        if (old.digest !== digest) throw new BlenderConflict("Batch key reused with changed instructions");
        return this.store.list(owner).filter(s => s.batchId === id);
      }
      this.store.db.query("INSERT INTO batches VALUES (?,?,?,?,?,?)").run(id, owner, project, digest, concurrency, Date.now());
      return items.map(item => {
        const s = this.store.create(owner, project, build, 3_600_000, id, item.id);
        this.store.db.query("INSERT INTO blender_jobs VALUES (?,?,?,'queued','[]',0,0,0,NULL,NULL)").run(s.id, item.label, item.prompt);
        return s;
      });
    }).immediate();
  }
  get(sessionId: string): Job | null { return this.store.db.query<Job, [string]>("SELECT * FROM blender_jobs WHERE sessionId=?").get(sessionId); }
  save(job: Job): void {
    this.store.db.query("UPDATE blender_jobs SET state=?,messages=?,step=?,requests=?,tokens=?,pendingOperation=?,error=? WHERE sessionId=?")
      .run(job.state, job.messages, job.step, job.requests, job.tokens, job.pendingOperation, job.error, job.sessionId);
  }
  recoverPlanning(): void {
    // A provider response lost at restart might already have incurred a charge; ask before paying again.
    this.store.db.query("UPDATE blender_jobs SET state='waiting-user',error='planning_result_unknown' WHERE state='planning'").run();
  }
  list(owner: string, batch: string): { session: Session; job: Job | null }[] {
    if (!this.store.db.query("SELECT id FROM batches WHERE owner=? AND id=?").get(owner, batch)) throw new BlenderConflict("Batch unavailable");
    return this.store.list(owner).filter(s => s.batchId === batch).map(session => ({ session, job: this.get(session.id) }));
  }
  answer(owner: string, id: string, message: string, discardUnknown: boolean): Session {
    if (!message.trim() || message.length > 20_000) throw new BlenderConflict("Invalid answer");
    return this.store.db.transaction(() => {
      const s = this.store.session(id, owner), job = this.get(id);
      if (!job || job.state !== "waiting-user" || !["paused", "expired"].includes(s.state)) throw new BlenderConflict("Job must finish saving and pausing first");
      if (!discardUnknown && (this.store.effect(id, s.epoch, "executor-unknown") || job.pendingOperation && this.store.operation(job.pendingOperation).state === "unknown"))
        throw new BlenderConflict("Unknown scene operation requires explicit checkpoint rollback");
      const resumed = this.store.resume(id, owner);
      const messages = JSON.parse(job.messages);
      messages.push({ role: "user", content: message + (discardUnknown ? "\n已明确退回最近已保存工程；不要重放结果未知的旧脚本。重新检查真实场景。" : "") });
      job.messages = JSON.stringify(messages); job.state = "queued"; job.error = null; job.pendingOperation = null;
      this.save(job); return resumed;
    }).immediate();
  }
  retry(owner: string, id: string, requestId: string): Session {
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new BlenderConflict("Invalid retry id");
    return this.store.db.transaction(() => {
      const s = this.store.session(id, owner), job = this.get(id);
      const prior = this.store.db.query<{ source: string; sessionId: string }, [string, string]>("SELECT source,sessionId FROM blender_retries WHERE owner=? AND requestId=?").get(owner, requestId);
      if (prior) { if (prior.source !== id) throw new BlenderConflict("Retry id reused"); return this.store.session(prior.sessionId, owner); }
      if (!job || !["failed", "cancelled"].includes(job.state) || !["paused", "expired"].includes(s.state)) throw new BlenderConflict("Failed job must finish pausing first");
      // A retry is a new, explicitly requested attempt, not a replay of uncertain Python.
      const next = this.store.create(owner, s.project, s.build, 3_600_000, s.batchId, `retry-${requestId}`);
      this.store.db.query("INSERT INTO blender_jobs VALUES (?,?,?,'queued','[]',0,0,0,NULL,NULL)").run(next.id, job.label, job.prompt);
      this.store.db.query("INSERT INTO blender_retries VALUES (?,?,?,?)").run(owner, requestId, id, next.id);
      return next;
    }).immediate();
  }
}
