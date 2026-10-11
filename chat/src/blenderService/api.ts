import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { BLENDER_ALLOWED_TOOLS } from "../models/blenderProtocol";
import { issueIdentity, verifyIdentity } from "./auth";
import { BlenderConflict, type BlenderStore } from "./storeCore";
import type { BlenderScheduler } from "./scheduler";
import type { BlenderJobs } from "./jobs";
import type { BlenderArtifacts } from "./artifacts";
import type { SandboxSecrets } from "./secrets";
import { randomUUID } from "node:crypto";

const SessionInput = z.object({ project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
  requestId: z.string().uuid(), budgetMinutes: z.number().int().min(3).max(60).default(60) }).strict();
const CommandInput = z.object({ epoch: z.number().int().positive(), key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  tool: z.enum(BLENDER_ALLOWED_TOOLS), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();

export function createBlenderApi(store: BlenderStore, scheduler: Pick<BlenderScheduler, "tick">,
  settings: { secret: string; build: string; desktopOrigin: string; pauseEnabled: boolean; target?: string }, jobs?: BlenderJobs, artifacts?: Pick<BlenderArtifacts, "list" | "ticket">, secrets?: SandboxSecrets) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", bodyLimit({ maxSize: 256 * 1024 }));
  app.onError(error => {
    if (error instanceof BlenderConflict || error instanceof z.ZodError) return Response.json({ error: "Invalid request or session conflict" }, { status: 409 });
    return Response.json({ error: "Blender service unavailable" }, { status: 503 });
  });
  app.get("/health", c => c.json({ service: "chatspace-blender", durable: true, pauseEnabled: settings.pauseEnabled }));
  app.post("/internal/tick", c => {
    const identity = verifyIdentity(c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "", settings.secret, "api");
    if (identity?.owner !== "__watchdog") return c.json({ error: "Unauthorized" }, 401);
    scheduler.tick(); return c.json({ accepted: true });
  });
  app.post("/internal/desktop", async c => {
    const gateway = verifyIdentity(c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "", settings.secret, "api");
    if (gateway?.owner !== "__gateway" || !secrets || !settings.target) return c.json({ error: "Unauthorized" }, 401);
    const input = await c.req.json() as { ticket?: string; owner?: string; session?: string; epoch?: number; activity?: boolean };
    const grant = input.ticket ? verifyIdentity(input.ticket, settings.secret, "desktop") : input;
    if (!grant?.owner || !grant.session || !grant.epoch) return c.json({ error: "Invalid desktop grant" }, 401);
    const session = store.session(grant.session, grant.owner);
    if (session.epoch !== grant.epoch || !(session.state === "ready" || session.state === "saving" && store.effect(session.id, session.epoch, "save-mode") === "continue") || session.stopReason || session.deadline <= Date.now()) return c.json({ error: "Desktop lease revoked" }, 409);
    if (input.activity) {
      if (jobs?.get(session.id)) throw new BlenderConflict("Batch viewers cannot keep a manual editor active");
      store.recordDesktopActivity(session.id, session.owner, session.epoch);
    }
    const value = secrets.open(store.credentials(session.id, session.epoch), session.id, session.epoch);
    return c.json({ owner: session.owner, session: session.id, epoch: session.epoch, target: settings.target,
      instance: session.instance, desktop: value.desktop, deadline: session.deadline, readOnly: Boolean(jobs?.get(session.id)) });
  });
  app.use("/v1/*", async (c, next) => {
    const identity = verifyIdentity(c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "", settings.secret, "api");
    if (!identity || identity.owner === "__watchdog") return c.json({ error: "Unauthorized" }, 401);
    c.set("owner", identity.owner); await next();
    c.header("Cache-Control", "private, no-store");
  });
  app.get("/v1/sessions", c => {
    scheduler.tick();
    const sessions = store.list(c.get("owner"));
    const summaries = Object.fromEntries(sessions.flatMap(s => { const job = jobs?.get(s.id); return job ? [[s.id, {
      label: job.label, state: job.state, step: job.step, requests: job.requests, tokens: job.tokens, error: job.error,
    }]] : []; }));
    return c.json({ owner: c.get("owner"), sessions, jobs: summaries, limits: store.limits, budget: store.budgets.summary(c.get("owner")),
      notices: Object.fromEntries(sessions.flatMap(s => { const value = store.effect(s.id, s.epoch, "budget-wait"); return value ? [[s.id, value]] : []; })) });
  });
  app.post("/v1/sessions", async c => {
    if (!settings.pauseEnabled) return c.json({ error: "暂停/恢复权限尚未验收，未分配计费资源" }, 503);
    const input = SessionInput.parse(await c.req.json());
    const session = store.create(c.get("owner"), input.project, settings.build, input.budgetMinutes * 60_000, input.requestId, "interactive");
    scheduler.tick(); return c.json({ session }, 202);
  });
  app.get("/v1/sessions/:id", c => {
    const session = store.session(c.req.param("id"), c.get("owner"));
    return c.json({ session, controller: {
      failureCount: Number(store.effect(session.id, session.epoch, "failures") ?? "0"),
      lastFailure: store.effect(session.id, session.epoch, "provider-error"),
      createRequested: Boolean(store.effect(session.id, session.epoch, "create")),
    } });
  });
  app.post("/v1/sessions/:id/operations", async c => {
    const input = CommandInput.parse(await c.req.json());
    const session = store.session(c.req.param("id"), c.get("owner"));
    if (jobs?.get(session.id)) throw new BlenderConflict("Batch scene commands are owned by the server runner");
    const prior = store.db.query<{ id: string }, [string, string]>("SELECT id FROM operations WHERE sessionId=? AND key=?").get(session.id, input.key);
    const id = prior?.id ?? randomUUID();
    const args = input.tool === "export_scene" ? { ...input.arguments, format: "glb", filepath: `/workspace/.chatspace/exports/${id}/model.glb` } : input.arguments;
    const operation = store.submit(c.get("owner"), session.id, input.epoch, input.key, input.tool, args, id);
    scheduler.tick(); return c.json({ operation }, 202);
  });
  app.get("/v1/operations/:id", c => { scheduler.tick(); return c.json({ operation: store.operation(c.req.param("id"), c.get("owner")) }); });
  app.post("/v1/sessions/:id/end", async c => {
    const { reason } = z.object({ reason: z.enum(["cancelled", "ended", "waiting-user"]).default("ended") }).strict().parse(await c.req.json());
    const session = store.stop(c.req.param("id"), c.get("owner"), reason);
    const job = jobs?.get(session.id);
    if (job && reason === "cancelled" && !["succeeded", "failed"].includes(job.state)) { job.state = "cancelled"; jobs!.save(job); }
    scheduler.tick(); return c.json({ session }, 202);
  });
  app.post("/v1/sessions/:id/answer", async c => {
    if (!settings.pauseEnabled || !jobs) throw new BlenderConflict("Batch service unavailable");
    const input = z.object({ message: z.string().min(1).max(20_000), discardUnknown: z.boolean().default(false) }).strict().parse(await c.req.json());
    const session = jobs.answer(c.get("owner"), c.req.param("id"), input.message, input.discardUnknown);
    scheduler.tick(); return c.json({ session }, 202);
  });
  app.post("/v1/sessions/:id/retry", async c => {
    if (!settings.pauseEnabled || !jobs) throw new BlenderConflict("Batch service unavailable");
    const input = z.object({ requestId: z.string().uuid() }).strict().parse(await c.req.json());
    const session = jobs.retry(c.get("owner"), c.req.param("id"), input.requestId); scheduler.tick(); return c.json({ session }, 202);
  });
  app.post("/v1/sessions/:id/resume", c => {
    if (!settings.pauseEnabled) return c.json({ error: "Resume unavailable" }, 503);
    const session = store.resume(c.req.param("id"), c.get("owner")); scheduler.tick(); return c.json({ session }, 202);
  });
  app.post("/v1/sessions/:id/desktop", c => {
    const session = store.session(c.req.param("id"), c.get("owner"));
    if (session.state !== "ready" || session.stopReason || session.deadline <= Date.now()) throw new BlenderConflict("Desktop lease unavailable");
    const token = issueIdentity({ owner: session.owner, scope: "desktop", session: session.id, epoch: session.epoch, expires: Date.now() + 60_000 }, settings.secret);
    return c.json({ url: new URL(`/desktop/${session.id}/?ticket=${encodeURIComponent(token)}&resize=scale&path=desktop/${session.id}/websockify${jobs?.get(session.id) ? "&view_only=1" : ""}`, settings.desktopOrigin).href, expiresInSeconds: 60 });
  });
  app.post("/v1/batches", async c => {
    if (!settings.pauseEnabled || !jobs) return c.json({ error: "Batch service unavailable" }, 503);
    const input = z.object({ id: z.string().uuid(), project: SessionInput.shape.project, concurrency: z.number().int().min(1).max(store.limits.owner).default(Math.min(3, store.limits.owner)),
      items: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), label: z.string().max(128), prompt: z.string().min(1).max(20_000) }).strict()).min(1).max(100) }).strict().parse(await c.req.json());
    const sessions = jobs.createBatch(c.get("owner"), input.project, input.id, input.items, settings.build, input.concurrency);
    scheduler.tick(); return c.json({ batchId: input.id, sessions }, 202);
  });
  app.get("/v1/batches/:id", c => { scheduler.tick(); return c.json({ items: jobs?.list(c.get("owner"), c.req.param("id")) ?? [] }); });
  app.post("/v1/batches/:id/cancel", c => {
    if (!jobs) throw new BlenderConflict("Batch unavailable");
    const items = jobs.list(c.get("owner"), c.req.param("id"));
    for (const { session, job } of items) if (job && !["succeeded", "failed", "cancelled"].includes(job.state)) {
      job.state = "cancelled"; jobs.save(job); store.stop(session.id, c.get("owner"), "cancelled");
    }
    scheduler.tick(); return c.json({ accepted: true }, 202);
  });
  app.get("/v1/sessions/:id/exports", c => c.json({ exports: artifacts?.list(c.get("owner"), c.req.param("id")) ?? [] }));
  app.get("/v1/exports/:id", c => {
    if (!artifacts) throw new BlenderConflict("Exports unavailable");
    return c.json(artifacts.ticket(c.get("owner"), c.req.param("id")));
  });
  return app;
}
