import { env, SELF, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BlenderStore } from "../../chat/src/blenderService/storeCore";
import { BlenderJobs } from "../../chat/src/blenderService/jobs";
import { issueIdentity } from "../../chat/src/blenderService/auth";
import { signDownloadTicket } from "./llmRelay";
import { SandboxSecrets } from "../../chat/src/blenderService/secrets";
import { DurableSql } from "./sql";
import { FileInspector, StreamingFiles } from "./transfers";
import { TosClient } from "@volcengine/tos-sdk";
import { VolcanoSandboxes } from "../../chat/src/blenderService/volcano";
import type { BlenderPool, BlenderDesktop } from "./worker";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }
let testPool = "";
beforeEach(() => { testPool = "test-" + crypto.randomUUID(); });
const pool = () => env.BLENDER_POOLS.getByName(testPool);
const token = (owner = "alice") => issueIdentity({ owner, scope: "api", expires: Date.now() + 60_000 }, env.BLENDER_SERVICE_SECRET);

describe("Cloudflare controller", () => {
  test("Volcano creation signer executes inside workerd before sending a mutation", async () => {
    await runInDurableObject<BlenderPool>(pool(), async () => {
      let sent = false;
      const cloud = new VolcanoSandboxes({ accessKeyId: "fixture-ak", secretKey: "fixture-sk", region: "cn-beijing", functionId: "fixture", imageInfoId: "fixture" }, async (_input, init) => {
        sent = true; expect(new Headers(init?.headers).get("authorization")).toContain("Credential=fixture-ak/");
        return Response.json({ Result: { SandboxId: "fixture-instance" } });
      });
      expect(await cloud.create("fixture-session", 1, { control: "fixture-control", desktop: "fixture-desktop" }, 3)).toBe("fixture-instance");
      expect(sent).toBe(true);
    });
  });
  test("platform alarms allocate a queued session and make the managed executor ready without browser polling", async () => {
    const id = await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const store = new BlenderStore(new DurableSql(state.storage));
      return store.create("alarm-owner", "project", env.BLENDER_SERVICE_BUILD, 300_000).id;
    });
    let creates = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "open.volcengineapi.com") { creates++; return Response.json({ Result: { SandboxId: "alarm-fixture" } }); }
      return Response.json({ sessionId: id, epoch: 1, unknown: false, ready: true, protocolVersion: 1 });
    });
    try {
      await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => { await state.storage.setAlarm(Date.now()); });
      await runDurableObjectAlarm(pool());
      await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
        const session = new BlenderStore(new DurableSql(state.storage)).session(id);
        expect(session.state).toBe("preparing"); expect(session.instance).toBe("alarm-fixture");
      });
      expect(creates).toBe(1);
    } finally { network.mockRestore(); }
  });
  test("health, public/internal authentication, and allocation safety gate", async () => {
    expect((await SELF.fetch("https://worker.example/health")).status).toBe(200);
    expect((await SELF.fetch("https://worker.example/internal/desktop", { method: "POST" })).status).toBe(404);
    expect((await SELF.fetch("https://worker.example/v1/sessions")).status).toBe(401);
    const create = await SELF.fetch("https://worker.example/v1/sessions", { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ project: "project", requestId: crypto.randomUUID() }) });
    expect(create.status).toBe(503);
    const list = await SELF.fetch("https://worker.example/v1/sessions", { headers: { Authorization: `Bearer ${token()}` } });
    expect(list.status).toBe(200); expect(await list.json()).toMatchObject({ sessions: [] });
    await runInDurableObject<BlenderPool>(env.BLENDER_POOLS.getByName(env.BLENDER_POOL), async (_instance, state) => { expect(await state.storage.getAlarm()).not.toBeNull(); });
  });
  test("a polled listing never arms the pool alarm; only a mutation does", async () => {
    const stub = env.BLENDER_POOLS.getByName(env.BLENDER_POOL);
    // 存储不保证按用例隔离（实测上一个用例的 POST 会留下 alarm），所以先把起点钉死。
    await runInDurableObject<BlenderPool>(stub, async (_instance, state) => { await state.storage.deleteAlarm(); });
    const list = await SELF.fetch("https://worker.example/v1/sessions", { headers: { Authorization: `Bearer ${token()}` } });
    expect(list.status).toBe(200);
    // 浏览器每几秒轮询一次列表：这条通路一旦顺手 arm，池子就被永久钉在 5 秒 alarm 上，
    // 每次轮询额外付一次 getAlarm 读 + 一次 setAlarm 写（免费档 5M 读 / 10 万写每天）。
    await runInDurableObject<BlenderPool>(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
    const create = await SELF.fetch("https://worker.example/v1/sessions", { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ project: "project", requestId: crypto.randomUUID() }) });
    expect(create.status).toBe(503);
    // 变更请求仍然要在改动之前把 alarm 放好：崩在「受理」与「唤醒」之间不能把排队任务丢掉。
    await runInDurableObject<BlenderPool>(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).not.toBeNull(); });
  });
  test("actual DO SQLite supports nested admission transactions, quotas and rollback", async () => {
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const store = new BlenderStore(new DurableSql(state.storage), { global: 4, owner: 3, queued: 100 }), jobs = new BlenderJobs(store);
      const id = crypto.randomUUID(), items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), label: "model", prompt: "cube" }));
      jobs.createBatch("alice", "project", id, items, "custom", 3);
      expect(jobs.createBatch("alice", "project", id, items, "custom", 3)).toHaveLength(4);
      for (let i = 0; i < 3; i++) expect(store.reserveNext()).not.toBeNull();
      expect(store.reserveNext()).toBeNull();
      expect(store.budgets.summary("alice").runtime.usedAndReservedMs).toBe(3 * 3_600_000);
      expect(() => store.db.transaction(() => { store.create("bob", "project", "custom", 3_600_000); throw new Error("rollback"); }).immediate()).toThrow("rollback");
      expect(store.list("bob")).toHaveLength(0);
    });
  });
  test("production quotas admit ten per owner and one hundred total with configured runtime budgets", async () => {
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const store = new BlenderStore(new DurableSql(state.storage), undefined, {
        ownerRunMs: Number(env.BLENDER_DAILY_OWNER_MINUTES) * 60_000, globalRunMs: Number(env.BLENDER_DAILY_GLOBAL_MINUTES) * 60_000,
        ownerModelCalls: Number(env.BLENDER_DAILY_OWNER_MODEL_CALLS), globalModelCalls: Number(env.BLENDER_DAILY_GLOBAL_MODEL_CALLS),
      });
      for (let i = 0; i < 11; i++) store.create("first-owner", "project", "custom", 3_600_000);
      for (let i = 0; i < 10; i++) expect(store.reserveNext()).not.toBeNull();
      expect(store.reserveNext()).toBeNull();
      for (let owner = 0; owner < 10; owner++) for (let i = 0; i < 10; i++) store.create(`owner-${owner}`, "project", "custom", 3_600_000);
      for (let i = 0; i < 90; i++) expect(store.reserveNext()).not.toBeNull();
      expect(store.reserveNext()).toBeNull();
      expect(store.list().filter(s => s.state === "allocating")).toHaveLength(100);
      expect(store.budgets.summary("first-owner").runtime).toMatchObject({ usedAndReservedMs: 600 * 60_000, limitMs: 600 * 60_000 });
      // Some daily runtime has already been consumed; a released slot does not replenish it.
      const short = store.create("short-owner", "project", "custom", 180_000);
      const first = store.list("first-owner")[0]!;
      store.transition(first.id, first.epoch, ["allocating"], "pausing"); expect(store.reserveNext()).toBeNull();
      store.transition(first.id, first.epoch, ["pausing"], "paused"); expect(store.reserveNext()?.id).toBe(short.id);
      expect(store.reserveNext()).toBeNull();
    });
  });
  test("planner/command recovery preserves paid admission and unknown receipts", async () => {
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const database = new DurableSql(state.storage), first = new BlenderStore(database), jobs = new BlenderJobs(first);
      const s = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "one", label: "one", prompt: "cube" }], "custom")[0]!;
      const lease = first.reserveNext()!; first.transition(s.id, lease.epoch, ["allocating"], "ready", "instance");
      const op = first.submit("alice", s.id, lease.epoch, "one", "execute_blender_code", { code: "pass" }); first.claimOperation(s.id, lease.epoch);
      const job = jobs.get(s.id)!; job.state = "planning"; job.requests = 1; jobs.save(job);
      first.budgets.reserve(`model:${s.id}:${lease.epoch}:1`, "alice", "model-call", 1);
      const restarted = new BlenderStore(database), restartedJobs = new BlenderJobs(restarted);
      restarted.recoverDispatched(); restartedJobs.recoverPlanning();
      expect(restarted.operation(op.id).state).toBe("unknown"); expect(restarted.claimOperation(s.id, lease.epoch)).toBeNull();
      expect(restartedJobs.get(s.id)?.error).toBe("planning_result_unknown");
      expect(restarted.budgets.summary("alice").modelCalls.used).toBe(1);
    });
  });
  test("desktop is owner/epoch fenced and denied while saving; idle alarm survives", async () => {
    const id = await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const store = new BlenderStore(new DurableSql(state.storage));
      const s = store.create("alice", "project", env.BLENDER_SERVICE_BUILD, 3_600_000, crypto.randomUUID(), "interactive"), lease = store.reserveNext()!;
      store.transition(s.id, lease.epoch, ["allocating"], "ready", "instance");
      const secret = new SandboxSecrets(env.BLENDER_SERVICE_SECRET);
      store.saveCredentials(s.id, lease.epoch, secret.seal(secret.generate(), s.id, lease.epoch));
      return s.id;
    });
    const grant = await pool().desktop({ owner: "alice", session: id, epoch: 1 });
    expect(grant?.readOnly).toBe(false);
    expect(await pool().desktop({ owner: "bob", session: id, epoch: 1 })).toBeNull();
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
      const store = new BlenderStore(new DurableSql(state.storage)); store.setEffect(id, 1, "save-mode", "continue"); store.transition(id, 1, ["ready"], "saving");
    });
    expect(await pool().desktop({ owner: "alice", session: id, epoch: 1 })).toBeNull();
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => { state.storage.sql.exec("UPDATE sessions SET state='paused'"); await state.storage.setAlarm(Date.now() + 100_000); });
    expect(await runDurableObjectAlarm(pool())).toBe(true);
    await pool().wake();
    await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => { expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now()); });
  });
});

test("streamed checkpoint commits only after signed TOS upload, readback and manifest verification", async () => {
  await runInDurableObject<BlenderPool>(pool(), async (_instance, state) => {
    const store = new BlenderStore(new DurableSql(state.storage));
    const created = store.create("alice", "project", "custom", 3_600_000), lease = store.reserveNext()!;
    store.transition(created.id, lease.epoch, ["allocating"], "ready", "instance");
    const session = store.session(created.id), source = new TextEncoder().encode("BLENDER-fixture"), objects = new Map<string, Uint8Array>();
    const tos = new TosClient({ accessKeyId: "fixture-ak", accessKeySecret: "fixture-sk", region: "cn-beijing", endpoint: "tos-cn-beijing.volces.com" });
    const files = new StreamingFiles(store, tos, "fixture-bucket", "https://sandbox.example/");
    let corrupt = false;
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      if (url.hostname === "sandbox.example") return new Response(source);
      expect(url.hostname).toBe("fixture-bucket.tos-cn-beijing.volces.com");
      if (init?.method === "PUT") {
        const headers = new Headers(init.headers);
        expect(headers.get("x-tos-forbid-overwrite")).toBe("true");
        expect(headers.get("authorization")).toMatch(/SignedHeaders=[^,]*x-tos-forbid-overwrite/);
        expect(headers.get("x-tos-content-sha256")).toBe("UNSIGNED-PAYLOAD");
        expect(headers.get("content-md5")).toBeTruthy();
        if (objects.has(path)) return new Response(null, { status: 409 });
        objects.set(path, new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response(null);
      }
      expect(url.searchParams.has("X-Tos-Signature")).toBe(true);
      const bytes = objects.get(path)!;
      return new Response(corrupt && url.pathname.endsWith("scene.blend") ? new TextEncoder().encode("BLENDER-corrupt") : bytes);
    });
    try {
      const first = crypto.randomUUID(); await files.save(session, "fixture-control", first);
      expect(store.session(session.id).checkpoint).toBe(first);
      // Repeated immutable publication accepts the stored object only after matching readback.
      await files.save(session, "fixture-control", first);
      corrupt = true; await expect(files.save(store.session(session.id), "fixture-control", crypto.randomUUID())).rejects.toThrow("checksum");
      expect(store.session(session.id).checkpoint).toBe(first);
    } finally { mock.mockRestore(); }
  });
});

test.each(["HTTP", "WebSocket"])("desktop external RPC cancels stalled %s when JS timeout callbacks never fire", async transport => {
  const id = await runInDurableObject<BlenderPool>(env.BLENDER_POOLS.getByName(env.BLENDER_POOL), async (_instance, state) => {
    const store = new BlenderStore(new DurableSql(state.storage));
    const s = store.create("timer-owner", "project", env.BLENDER_SERVICE_BUILD, 3_600_000, crypto.randomUUID(), "interactive"), lease = store.reserveNext()!;
    store.transition(s.id, lease.epoch, ["allocating"], "ready", `timer-instance-${s.id}`);
    const secret = new SandboxSecrets(env.BLENDER_SERVICE_SECRET);
    store.saveCredentials(s.id, lease.epoch, secret.seal(secret.generate(), s.id, lease.epoch)); return s.id;
  });
  const desktop = env.BLENDER_DESKTOPS.getByName(id);
  const ticket = issueIdentity({ owner: "timer-owner", session: id, epoch: 1, scope: "desktop", expires: Date.now() + 300_000 }, env.BLENDER_SERVICE_SECRET);
  await runInDurableObject<BlenderDesktop>(desktop, async (instance, state) => {
    let now = Date.now(), signal: AbortSignal | undefined, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const date = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init!.signal!; started();
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    try {
      const headers = new Headers({ Cookie: `__Host-cs-blender-${id}=${ticket}` });
      if (transport === "WebSocket") { headers.set("Upgrade", "websocket"); headers.set("Origin", "https://blender.example"); }
      const request = instance.fetch(new Request(`https://blender.example/desktop/${id}/${transport === "WebSocket" ? "websockify" : "index.html"}`, { headers }));
      await entered; now += 31_000; await instance.revalidate();
      expect((await request).status).toBe(502); expect(signal?.aborted).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally { network.mockRestore(); timer.mockRestore(); date.mockRestore(); }
  });
});

test("read-only batch sockets survive intermediate saves and are revoked at final save", async () => {
  const stub = env.BLENDER_POOLS.getByName(env.BLENDER_POOL);
  const id = await runInDurableObject<BlenderPool>(stub, async (_instance, state) => {
    const store = new BlenderStore(new DurableSql(state.storage)), jobs = new BlenderJobs(store);
    const [s] = jobs.createBatch("batch-viewer", "project", crypto.randomUUID(), [{ id: "cube", label: "Cube", prompt: "cube" }], env.BLENDER_SERVICE_BUILD);
    const lease = store.reserveNext()!; store.transition(s!.id, lease.epoch, ["allocating"], "ready", "batch-view-instance");
    const vault = new SandboxSecrets(env.BLENDER_SERVICE_SECRET);
    store.saveCredentials(s!.id, lease.epoch, vault.seal(vault.generate(), s!.id, lease.epoch)); return s!.id;
  });
  const ticket = issueIdentity({ owner: "batch-viewer", session: id, epoch: 1, scope: "desktop", expires: Date.now() + 300_000 }, env.BLENDER_SERVICE_SECRET);
  await runInDurableObject<BlenderDesktop>(env.BLENDER_DESKTOPS.getByName(id), async instance => {
    let upstream: WebSocket | undefined;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      const pair = new WebSocketPair(); upstream = pair[1]; upstream.binaryType = "arraybuffer"; upstream.accept();
      upstream.addEventListener("message", event => upstream!.send(event.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    let socket: WebSocket | null = null;
    try {
      const response = await SELF.fetch(`https://blender.example/desktop/${id}/websockify`, { headers: { Upgrade: "websocket", Origin: "https://blender.example", Cookie: `__Host-cs-blender-${id}=${ticket}` } });
      expect(response.status).toBe(101); socket = response.webSocket!; socket.binaryType = "arraybuffer"; socket.accept();
      await runInDurableObject<BlenderPool>(env.BLENDER_POOLS.getByName(env.BLENDER_POOL), async (_pool, state) => {
        const store = new BlenderStore(new DurableSql(state.storage));
        store.setEffect(id, 1, "save-mode", "continue"); store.transition(id, 1, ["ready"], "saving");
      });
      await instance.revalidate();
      const frame = new Promise<ArrayBuffer>(resolve => socket!.addEventListener("message", event => resolve(event.data as ArrayBuffer), { once: true }));
      socket.send(new Uint8Array([1, 2, 3]).buffer); expect(new Uint8Array(await frame)).toEqual(new Uint8Array([1, 2, 3]));
      await runInDurableObject<BlenderPool>(env.BLENDER_POOLS.getByName(env.BLENDER_POOL), async (_pool, state) => { new BlenderStore(new DurableSql(state.storage)).setEffect(id, 1, "save-mode", "end"); });
      const closed = new Promise<void>(resolve => socket!.addEventListener("close", () => resolve(), { once: true }));
      await instance.revalidate(); await closed;
    } finally { try { socket?.close(); } catch {} try { upstream?.close(); } catch {} network.mockRestore(); }
  });
});

test("Worker/DO HTTP transport carries a real binary socket and revokes it before saving", async () => {
  const id = await runInDurableObject<BlenderPool>(env.BLENDER_POOLS.getByName(env.BLENDER_POOL), async (_instance, state) => {
    const store = new BlenderStore(new DurableSql(state.storage));
    const s = store.create("socket-owner", "project", env.BLENDER_SERVICE_BUILD, 3_600_000, crypto.randomUUID(), "interactive"), lease = store.reserveNext()!;
    store.transition(s.id, lease.epoch, ["allocating"], "ready", "socket-instance");
    const secrets = new SandboxSecrets(env.BLENDER_SERVICE_SECRET);
    store.saveCredentials(s.id, lease.epoch, secrets.seal(secrets.generate(), s.id, lease.epoch)); return s.id;
  });
  const ticket = issueIdentity({ owner: "socket-owner", session: id, epoch: 1, scope: "desktop", expires: Date.now() + 300_000 }, env.BLENDER_SERVICE_SECRET);
  await runInDurableObject<BlenderDesktop>(env.BLENDER_DESKTOPS.getByName(id), async instance => {
    const upstreams: WebSocket[] = [];
    const handshakeSignals: AbortSignal[] = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init!.headers).get("x-faas-instance-name")).toBe("socket-instance");
      handshakeSignals.push(init!.signal!);
      const pair = new WebSocketPair(), upstream = pair[1]; upstream.binaryType = "arraybuffer"; upstream.accept();
      upstream.addEventListener("message", event => upstream.send(event.data)); upstreams.push(upstream);
      upstream.send(new TextEncoder().encode("RFB 003.008\n").buffer);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    const request = () => new Request(`https://blender.example/desktop/${id}/websockify`, { headers: { Upgrade: "websocket", Origin: "https://blender.example", Cookie: `__Host-cs-blender-${id}=${ticket}` } });
    let socket: WebSocket | null = null;
    try {
      const response = await SELF.fetch(request()); expect(response.status).toBe(101);
      expect(handshakeSignals[0]!.aborted).toBe(false);
      socket = response.webSocket; expect(socket).not.toBeNull(); socket!.binaryType = "arraybuffer";
      const banner = new Promise<ArrayBuffer>(resolve => socket!.addEventListener("message", event => resolve(event.data as ArrayBuffer), { once: true }));
      socket!.accept(); expect(new TextDecoder().decode(await banner)).toBe("RFB 003.008\n");
      const received = new Promise<ArrayBuffer>(resolve => socket!.addEventListener("message", event => resolve(event.data as ArrayBuffer), { once: true }));
      socket!.send(new Uint8Array([0, 255, 128, 13]).buffer);
      expect(new Uint8Array(await received)).toEqual(new Uint8Array([0, 255, 128, 13]));
      expect((await SELF.fetch(request())).status).toBe(409);
      const closed = new Promise<void>(resolve => socket!.addEventListener("close", () => resolve(), { once: true }));
      await instance.revoke(); await closed;
    } finally { try { socket?.close(); } catch {} for (const upstream of upstreams) try { upstream.close(); } catch {} network.mockRestore(); }
  });
});

function glb(nan = false): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }));
  const padded = Math.ceil(json.length / 4) * 4, bytes = new Uint8Array(28 + padded + 36), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true); view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + padded); bytes.set(json, 20); view.setUint32(20 + padded, 36, true); view.setUint32(24 + padded, 0x004e4942, true);
  if (nan) view.setFloat32(28 + padded + 4, NaN, true);
  return bytes;
}
test("streaming GLB verification handles every-byte splits and rejects NaN/truncation", () => {
  const bytes = glb(), inspector = new FileInspector("glb");
  for (const byte of bytes) inspector.feed(new Uint8Array([byte]));
  expect(inspector.finish()).toMatchObject({ bytes: bytes.length, triangles: 1 });
  const invalid = new FileInspector("glb"); expect(() => invalid.feed(glb(true))).toThrow("position");
  const truncated = new FileInspector("glb"); truncated.feed(bytes.subarray(0, bytes.length - 1)); expect(() => truncated.finish()).toThrow();
});
test("256 MiB blend is hashed incrementally and preserves size limit", () => {
  const inspector = new FileInspector("blend"), chunk = new Uint8Array(1024 * 1024); chunk.set(new TextEncoder().encode("BLENDER"));
  inspector.feed(chunk); chunk.fill(0); for (let i = 1; i < 256; i++) inspector.feed(chunk);
  expect(inspector.finish().bytes).toBe(256 * 1024 * 1024);
  expect(() => inspector.feed(new Uint8Array([1]))).toThrow("size");
});

test("产物下载只认票据、不要 Authorization，且带网站自己的跨域头", async () => {
  const artifact = "https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-4-5/chair_0.jpeg";
  const ticket = await signDownloadTicket(artifact, env.BLENDER_SERVICE_SECRET);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/jpeg" } }));
  try {
    const response = await SELF.fetch(`https://worker.example/v1/download?ticket=${encodeURIComponent(ticket!)}`, { headers: { Origin: "https://www.junwei.cool" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://www.junwei.cool");
    expect((await response.arrayBuffer()).byteLength).toBe(2);
    expect((await SELF.fetch("https://worker.example/v1/download?ticket=forged", { headers: { Origin: "https://www.junwei.cool" } })).status).toBe(403);
    expect((await SELF.fetch(`https://worker.example/v1/download?ticket=${encodeURIComponent(ticket!)}`, { headers: { Origin: "https://evil.test" } })).status).toBe(403);
  } finally { network.mockRestore(); }
});
