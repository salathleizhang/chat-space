import { DurableObject } from "cloudflare:workers";
import { TosClient } from "@volcengine/tos-sdk";
import { BlenderStore, type Session } from "../../chat/src/blenderService/storeCore";
import { createBlenderApi } from "../../chat/src/blenderService/api";
import { readServiceSettings } from "../../chat/src/blenderService/config";
import { BlenderScheduler } from "../../chat/src/blenderService/scheduler";
import { SandboxSecrets } from "../../chat/src/blenderService/secrets";
import { VolcanoSandboxes } from "../../chat/src/blenderService/volcano";
import { ManagedExecutor } from "../../chat/src/blenderService/executor";
import { BlenderJobs } from "../../chat/src/blenderService/jobs";
import { BlenderBatchRunner, volcanoPlanner } from "../../chat/src/blenderService/batchRunner";
import { issueIdentity, verifyIdentity } from "../../chat/src/blenderService/auth";
import { boundedBody } from "../../chat/src/blenderService/objects";
import { DESKTOP_ACTIVITY_SCRIPT, withDesktopActivity } from "../../chat/src/blenderService/desktopActivity";
import { desktopDisplayScript, withDesktopDisplay } from "../../chat/src/blenderService/desktopDisplay";
import { tickTaskPumps } from "../../chat/src/common/taskPump";
import { cloudBudget } from "../../chat/src/models/cloudBudget";
import { DurableSql } from "./sql";
import { StreamingFiles } from "./transfers";
import { relayArk, relayCors } from "./llmRelay";

const pool = (env: Env) => env.BLENDER_POOLS.getByName(env.BLENDER_POOL, { locationHint: "apac" });
type Grant = { owner: string; session: string; epoch: number; instance: string; desktop: string; target: string; deadline: number; readOnly: boolean };
type DesktopIdentity = { ticket: string } | { owner: string; session: string; epoch: number };
function settings(env: Env) {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") values[key] = value;
  return readServiceSettings({ ...values, BLENDER_SERVICE_DATABASE: "durable-object", BLENDER_DESKTOP_ORIGIN: "https://blender.invalid" });
}
function unavailable(status = 503) { return Response.json({ error: "Blender service unavailable" }, { status, headers: { "Cache-Control": "no-store" } }); }
function configured(env: Env) { return Boolean(env.BLENDER_SERVICE_SECRET?.length >= 32 && env.VOLC_ACCESSKEY && env.VOLC_SECRETKEY && env.TOS_ACCESS_KEY && env.TOS_SECRET_KEY && env.VOLC_KEY); }
/** Cannot enqueue or advance work, so they must not pull the pool alarm in (see `dispatch`). */
const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

/** One bounded regional capacity pool coordinates admission across its sandbox slots.
 * Desktop HTTP/binary traffic bypasses it; individual desktop sockets have their own DO.
 * Changing BLENDER_POOL creates a separate quota ledger, so it is deployment-only, never client input. */
export class BlenderPool extends DurableObject<Env> {
  private runtime?: ReturnType<BlenderPool["initialize"]>;
  private initialize() {
    const config = settings(this.env), store = new BlenderStore(new DurableSql(this.ctx.storage), undefined, config.budgets);
    const secrets = new SandboxSecrets(config.secret), executor = new ManagedExecutor(config.target, fetch, 1024 * 1024);
    const files = new StreamingFiles(store, new TosClient(config.tos), config.tos.bucket, config.target), jobs = new BlenderJobs(store);
    const publish = async (s: Session, op: import("../../chat/src/blenderService/storeCore").Operation) => {
      const token = secrets.open(store.credentials(s.id, s.epoch), s.id, s.epoch).control;
      await files.publish(s, token, op);
    };
    // Streaming adapter implements publication; the buffered commit path is unreachable here.
    const runner = this.env.VOLC_KEY && this.env.BLENDER_AGENT_MODEL ? new BlenderBatchRunner(jobs, volcanoPlanner(this.env.VOLC_KEY, this.env.BLENDER_AGENT_MODEL),
      { list: (owner, id) => files.list(owner, id), commit: async () => { throw new Error("Buffered publication forbidden in Workers"); } }, executor, secrets, publish) : undefined;
    const scheduler = new BlenderScheduler(store, secrets, {
      sandboxes: new VolcanoSandboxes(config.volcano), executor, runner,
      checkpoints: { commit: async () => { throw new Error("Buffered checkpoint forbidden in Workers"); } },
      saveCheckpoint: (s, token, id) => files.save(s, token, id), restoreCheckpoint: (s, token, id) => files.restore(s, token, id), publishExport: publish,
      beforeCheckpoint: async s => {
        // A read-only batch viewer cannot race a save. Keep its framebuffer stream
        // through intermediate checkpoints; editor inputs and final saves stay fenced.
        if (jobs.get(s.id) && store.effect(s.id, s.epoch, "save-mode") === "continue") return;
        await this.env.BLENDER_DESKTOPS.getByName(s.id).revoke();
      },
    }, true);
    return { config, store, secrets, files, jobs, scheduler, runner };
  }
  private getRuntime() { return this.runtime ??= this.initialize(); }
  /** RPC from the Worker only; /internal endpoints are never exposed publicly. */
  async dispatch(request: Request): Promise<Response> {
    const runtime = this.getRuntime();
    // Arm before mutation; a crash between receipt and wake cannot strand a queued task.
    // Reads must not arm. The workbench polls the session list every few seconds, and each arm is a
    // DO row read (`getAlarm`) plus a row written (`setAlarm`) *and* pins this pool to the 5-second
    // alarm that the alarm handler deliberately backs off from when idle — enough, on the free tier,
    // to exhaust both the 5M rows-read and the 100k rows-written daily allowance with no work running.
    if (!READ_ONLY_METHODS.has(request.method)) await this.arm();
    const response = await createBlenderApi(runtime.store, { tick: () => { /* platform Alarm owns work */ } },
      { ...runtime.config, desktopOrigin: new URL(request.url).origin }, runtime.runner ? runtime.jobs : undefined, runtime.files, runtime.secrets).fetch(request);
    return response;
  }
  private async arm(): Promise<void> {
    const next = Date.now() + 5_000, current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
  /** Independent Cron reaches this RPC even while an Alarm's network request is stuck. */
  async wake(): Promise<void> {
    tickTaskPumps();
    if (!this.runtime && !this.ctx.storage.sql.databaseSize) return;
    await this.arm();
    // A long transfer in one Alarm must not stall other slots until all its flights finish.
    const { scheduler } = this.getRuntime(); scheduler.tick(); await scheduler.drain();
  }
  async alarm(): Promise<void> {
    // Persist the next wake before I/O. Platform retries and Cron are independent of JS timers.
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    try {
      const { store, scheduler } = this.getRuntime();
      scheduler.tick(); await scheduler.drain();
      const active = store.list().filter(s => !["queued", "paused", "expired"].includes(s.state));
      for (const s of active) await this.env.BLENDER_DESKTOPS.getByName(s.id).revalidate();
      const queued = store.list().some(s => s.state === "queued" && !s.stopReason);
      await this.ctx.storage.setAlarm(Date.now() + (active.length ? 5_000 : queued ? 60_000 : 300_000));
    } catch {
      // Never include provider bodies or credentials in logs. Next wake is already durable.
      console.warn(JSON.stringify({ event: "blender_alarm_failed" }));
    }
  }
  async desktop(input: DesktopIdentity, activity = false): Promise<Grant | null> {
    try { return this.desktopGrant(input, activity); } catch { return null; }
  }
  private desktopGrant(input: DesktopIdentity, activity: boolean): Grant {
    const { store, config, secrets, jobs } = this.getRuntime();
    const identity = "ticket" in input ? verifyIdentity(input.ticket, config.secret, "desktop") : input;
    if (!identity?.owner || !identity.session || !identity.epoch) throw new Error("Desktop unauthorized");
    const s = store.session(identity.session, identity.owner);
    const readOnly = Boolean(jobs.get(s.id));
    const viewable = s.state === "ready" || readOnly && s.state === "saving" && store.effect(s.id, s.epoch, "save-mode") === "continue";
    if (s.epoch !== identity.epoch || !viewable || s.stopReason || s.deadline <= Date.now() || !s.instance) throw new Error("Desktop lease revoked");
    if (activity) { if (readOnly) throw new Error("Read-only desktop"); store.recordDesktopActivity(s.id, s.owner, s.epoch); }
    const value = secrets.open(store.credentials(s.id, s.epoch), s.id, s.epoch);
    return { owner: s.owner, session: s.id, epoch: s.epoch, instance: s.instance, target: config.target, desktop: value.desktop, deadline: s.deadline, readOnly };
  }
}

function scoped(request: Request) {
  const url = new URL(request.url), match = url.pathname.match(/^\/desktop\/([a-f0-9-]{36})(\/.*)$/);
  if (!match) throw new Error("Invalid desktop route");
  const id = match[1]!, name = `__Host-cs-blender-${id}`;
  const ticket = url.searchParams.get("ticket") ?? request.headers.get("Cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="))?.slice(name.length + 1);
  if (!ticket) throw new Error("Missing desktop ticket");
  const bootstrap = url.searchParams.has("ticket"); url.searchParams.delete("ticket"); url.searchParams.delete("faasInstanceName");
  return { id, name, ticket, bootstrap, url, path: match[2]!, query: url.search };
}
function targetURL(scope: ReturnType<typeof scoped>, grant: Grant): URL {
  const base = new URL(grant.target), target = new URL(scope.path + scope.query, base);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || target.origin !== base.origin) throw new Error("Invalid upstream");
  return target;
}
function desktopHeaders(grant: Grant): Headers {
  return new Headers({ Authorization: "Basic " + Buffer.from(`${grant.readOnly ? "kasm_viewer" : "kasm_user"}:${grant.desktop}`).toString("base64"), "x-faas-instance-name": grant.instance, "Accept-Encoding": "identity" });
}
async function desktopHTTP(request: Request, env: Env, signal: AbortSignal): Promise<Response> {
  const scope = scoped(request), activity = scope.path === "/__lease/activity" && request.method === "POST";
  if (activity ? request.headers.get("Origin") !== scope.url.origin || scope.bootstrap : !["GET", "HEAD"].includes(request.method)) return unavailable(405);
  const grant = await pool(env).desktop({ ticket: scope.ticket }, activity);
  if (!grant || grant.session !== scope.id) return unavailable(401);
  if (scope.bootstrap) {
    const ticket = issueIdentity({ owner: grant.owner, session: grant.session, epoch: grant.epoch, scope: "desktop", expires: Date.now() + 300_000 }, env.BLENDER_SERVICE_SECRET);
    return new Response(null, { status: 303, headers: { Location: scope.url.pathname + scope.query,
      "Set-Cookie": `${scope.name}=${ticket}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  if (activity || scope.path === "/__lease/renew") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (scope.path === "/__lease/display.js") return new Response(request.method === "HEAD" ? null : desktopDisplayScript(grant.session, env.BLENDER_FRAME_ORIGINS.split(/\s+/)), {
    headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  if (scope.path === "/__lease/activity.js") {
    if (grant.readOnly) return unavailable(403);
    return new Response(request.method === "HEAD" ? null : DESKTOP_ACTIVITY_SCRIPT, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const response = await fetch(targetURL(scope, grant), { method: request.method, headers: desktopHeaders(grant), redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unavailable(502); }
  const headers = new Headers(response.headers);
  for (const key of ["Set-Cookie", "WWW-Authenticate", "Location", "Connection", "Transfer-Encoding"]) headers.delete(key);
  headers.set("Cache-Control", "private, no-store"); headers.set("Referrer-Policy", "no-referrer"); headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Content-Security-Policy", `frame-ancestors ${env.BLENDER_FRAME_ORIGINS}`);
  // Desktop assets are bounded; consume them inside the externally supervised request budget.
  // The binary display stream uses WebSockets, never this HTTP buffer.
  let body: BodyInit | null = request.method === "HEAD" ? null : await boundedBody(response, 4 * 1024 * 1024);
  headers.delete("Content-Length"); headers.delete("Content-Encoding");
  if (request.method === "GET" && response.status === 200 && headers.get("Content-Type")?.includes("text/html")) {
    if ((body as Uint8Array).byteLength > 2 * 1024 * 1024) return unavailable(502);
    body = withDesktopDisplay(new TextDecoder().decode(body as Uint8Array), grant.session);
    if (!grant.readOnly) body = withDesktopActivity(body, grant.session);
    for (const key of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(key);
  }
  return new Response(body, { status: response.status, headers });
}

/** One desktop object per session enforces socket quotas across Worker instances. */
export class BlenderDesktop extends DurableObject<Env> {
  private readonly connections = new Map<WebSocket, { upstream: WebSocket; grant: Grant }>();
  private pending = 0;
  private httpPending = 0;
  private generation = 0;
  // WebSocket upgrade responses require the HTTP binding transport; RPC cannot clone sockets.
  async fetch(request: Request): Promise<Response> {
    return request.headers.get("Upgrade")?.toLowerCase() === "websocket" ? this.upgradeDesktop(request) : this.httpDesktop(request);
  }
  async httpDesktop(request: Request): Promise<Response> {
    if (this.httpPending >= 8) return unavailable(429);
    this.httpPending++;
    try {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return await cloudBudget(signal => desktopHTTP(request, this.env, signal), 30_000);
    } catch { return unavailable(502); }
    finally { this.httpPending--; }
  }
  async upgradeDesktop(request: Request): Promise<Response> {
    const scope = scoped(request);
    if (scope.bootstrap || scope.path !== "/websockify" || request.headers.get("Origin") !== scope.url.origin || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return unavailable(401);
    const grant = await pool(this.env).desktop({ ticket: scope.ticket });
    if (!grant || grant.session !== scope.id || this.connections.size + this.pending >= (grant.readOnly ? 2 : 1)) return unavailable(409);
    this.pending++; const generation = this.generation;
    let remote: WebSocket | null = null;
    try {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return await cloudBudget(async signal => {
      const headers = desktopHeaders(grant); headers.set("Upgrade", "websocket"); headers.set("Origin", new URL(grant.target).origin);
      const protocol = request.headers.get("Sec-WebSocket-Protocol"); if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
      // The request budget aborts on completion to clean up HTTP bodies. An
      // upgraded socket outlives its handshake, so detach that budget after fetch.
      const handshake = new AbortController(), abort = () => handshake.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      let response: Response;
      try { response = await fetch(targetURL(scope, grant), { headers, redirect: "manual", signal: handshake.signal }); }
      finally { signal.removeEventListener("abort", abort); }
      remote = response.webSocket;
      if (response.status !== 101 || !remote) { await response.body?.cancel(); throw new Error("Desktop upgrade failed"); }
      if (signal.aborted) { remote.close(1000, "Desktop lease ended"); throw new Error("Desktop upgrade timed out"); }
      remote.binaryType = "arraybuffer";
      if (!await pool(this.env).desktop(grant)) throw new Error("Desktop lease revoked");
      if (signal.aborted || generation !== this.generation) throw new Error("Desktop revoked during upgrade");
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      server.binaryType = "arraybuffer"; server.accept();
      const upstream = remote;
      this.connections.set(server, { upstream, grant });
      const close = () => { this.connections.delete(server); try { server.close(1000, "Desktop lease ended"); } catch {} try { upstream.close(1000, "Desktop lease ended"); } catch {} };
      server.addEventListener("message", event => { try { upstream.send(event.data); } catch { close(); } });
      upstream.addEventListener("message", event => { try { server.send(event.data); } catch { close(); } });
      for (const socket of [server, upstream]) { socket.addEventListener("close", close); socket.addEventListener("error", close); }
      // RFB sends its version immediately. Install forwarding before accepting,
      // otherwise the asynchronous lease check can discard that first frame.
      upstream.accept();
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      const resultHeaders = new Headers(); const selected = response.headers.get("Sec-WebSocket-Protocol"); if (selected) resultHeaders.set("Sec-WebSocket-Protocol", selected);
      return new Response(null, { status: 101, webSocket: client, headers: resultHeaders });
      }, 30_000);
    } catch { try { (remote as WebSocket | null)?.close(1000, "Desktop lease ended"); } catch {} return unavailable(502); }
    finally { this.pending--; }
  }
  async revoke(): Promise<void> {
    this.generation++;
    for (const [socket, { upstream }] of this.connections) { try { socket.close(1000, "Desktop lease ended"); } catch {} try { upstream.close(1000, "Desktop lease ended"); } catch {} }
    this.connections.clear();
  }
  async revalidate(): Promise<void> {
    // Alarm and the pool's Cron RPC supply an external clock when JS timers stop.
    tickTaskPumps();
    for (const [socket, value] of this.connections) {
      try { if (!await pool(this.env).desktop(value.grant)) throw new Error("Desktop lease revoked"); }
      catch { this.connections.delete(socket); try { socket.close(1000, "Desktop lease ended"); } catch {} try { value.upstream.close(1000, "Desktop lease ended"); } catch {} }
    }
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    await this.revalidate();
    if (!this.connections.size && !this.pending && !this.httpPending) await this.ctx.storage.deleteAlarm();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ service: "chatspace-blender", platform: "cloudflare", durable: true, configured: configured(env), pauseEnabled: String(env.BLENDER_PAUSE_ENABLED) === "1" });
      /*
        AI 中继：浏览器直连这里，再由 Cloudflare 的出口转发到火山。
        2026-10-15 / 10-17 / 10-18 三次实测都指向同一条：坏的是「Vercel 函数出口 → 火山」
        这一跳（固定 ~16.5 秒后失败），换 Cloudflare 的出口就把这一跳整个换掉（见 llmRelay.ts）。
        票据是网站签的短期票据（scope `llm`），跨域只放行网站自己的源。
      */
      if (path.startsWith("/v1/llm/")) {
        const cors = relayCors(env, request.headers.get("origin"));
        if (!cors) return unavailable(403);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        if (request.method !== "POST") return unavailable(405);
        const ticket = verifyIdentity(request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "", env.BLENDER_SERVICE_SECRET ?? "", "llm");
        if (!ticket) return Response.json({ error: { message: "AI ticket is invalid or expired" } }, { status: 401, headers: cors });
        return await relayArk(request, env, ticket);
      }
      if (path.startsWith("/desktop/")) {
        return await env.BLENDER_DESKTOPS.getByName(scoped(request).id).fetch(request);
      }
      if (!path.startsWith("/v1/")) return unavailable(404);
      const identity = verifyIdentity(request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "", env.BLENDER_SERVICE_SECRET ?? "", "api");
      if (!identity || identity.owner.startsWith("__")) return unavailable(401);
      return await pool(env).dispatch(request);
    } catch { return unavailable(); }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { if (configured(env)) await pool(env).wake(); },
} satisfies ExportedHandler<Env>;
