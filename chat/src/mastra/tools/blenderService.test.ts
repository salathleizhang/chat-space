import { z } from "zod";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage, withAssetStorage } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { blenderSessionActionTool, blenderSessionsTool, startBlenderBatchTool, setBlenderExportImporter, BlenderSessionActionInput, BlenderBatchInput } from "./blenderService";
import { BlenderStore } from "../../blenderService/store";
import { BlenderJobs } from "../../blenderService/jobs";
import { createBlenderApi } from "../../blenderService/api";
import { issueIdentity } from "../../blenderService/auth";

const root = await mkdtemp(join(tmpdir(), "chatspace-blender-actions-"));
const storage = new LocalFileStorage(root), originalFetch = globalThis.fetch;
const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const id = "c40f4c3a-9864-49ef-9135-8ce1137f96bc";
const session = { id, project: "fixture", state: "paused", epoch: 1, checkpoint: "saved", stopReason: "ended", batchId: null };
const context = { requestContext: { projectSlug: "fixture" }, toolCallId: "call-a" } as never;
const call = (input: unknown, ctx = context) => withAssetStorage(storage, () => blenderSessionActionTool.execute!(input as never, ctx));
beforeAll(async () => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://fixture.test" } });
  await createProject(storage, { name: "fixture", slug: "fixture" });
});
afterEach(() => { globalThis.fetch = originalFetch; setBlenderExportImporter(undefined); });
afterAll(async () => {
  if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation); else Reflect.deleteProperty(globalThis, "location");
  await rm(root, { recursive: true, force: true });
});

test("project mismatch rejects mutations and import before any action", async () => {
  const methods: string[] = [], importer = mock(async () => 1);
  setBlenderExportImporter(importer);
  globalThis.fetch = mock(async (_input, init) => { methods.push(init?.method ?? "GET"); return Response.json({ session: { ...session, project: "other" } }); }) as unknown as typeof fetch;
  for (const action of ["resume", "pause", "retry", "export", "import"]) await expect(call({ action, sessionId: id })).rejects.toThrow("another project");
  expect(methods.every(method => method === "GET")).toBe(true); expect(importer).not.toHaveBeenCalled();
});

test("retry keeps the original request identity after a lost response, without automatic replay", async () => {
  const bodies: string[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (!init?.method) return Response.json({ session: { ...session, batchId: "batch" } });
    bodies.push(String(init.body)); if (bodies.length === 1) throw new Error("lost response");
    return Response.json({ session: { ...session, id: "new-session" } });
  }) as unknown as typeof fetch;
  await expect(call({ action: "retry", sessionId: id })).rejects.toThrow("lost response"); expect(bodies.length).toBe(1);
  await call({ action: "retry", sessionId: id }); expect(bodies[1]).toBe(bodies[0]);
  await expect(call({ action: "retry", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).rejects.toThrow("another project");
});

test("AI import uses the verified browser importer with the authoritative project", async () => {
  globalThis.fetch = mock(async () => Response.json({ session })) as unknown as typeof fetch;
  const importer = mock(async () => 0); setBlenderExportImporter(importer);
  const result = await call({ action: "import", sessionId: id });
  expect(importer).toHaveBeenCalledWith("fixture", id); expect(result).toEqual({ sessionId: id, imported: 0 });
});

test("resume is no-op when already running and rejects bypassing batch supervision", async () => {
  const posts: string[] = []; let value = { ...session, state: "ready", stopReason: null as string | null, batchId: null as string | null };
  globalThis.fetch = mock(async (_input, init) => { if (init?.method) posts.push(String(init.body)); return Response.json({ session: value }); }) as unknown as typeof fetch;
  await call({ action: "resume", sessionId: id }); expect(posts).toEqual([]);
  value = { ...value, state: "paused", batchId: "batch" };
  await expect(call({ action: "resume", sessionId: id })).rejects.toThrow("answer or retry");
  await expect(call({ action: "export", sessionId: id })).rejects.toThrow("exported automatically"); expect(posts).toEqual([]);
});

test("session discovery filters other projects and operation lookup binds the session", async () => {
  globalThis.fetch = mock(async input => String(input).endsWith("/sessions")
    ? Response.json({ sessions: [session, { ...session, id: "other", project: "other" }], jobs: {} })
    : String(input).includes("/operations/") ? Response.json({ operation: { sessionId: "other" } }) : Response.json({ session })) as unknown as typeof fetch;
  const result = await withAssetStorage(storage, () => blenderSessionsTool.execute!({} as never, context));
  expect((result as { sessions: { sessionId: string }[] }).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([id]);
  await expect(call({ action: "operation-status", sessionId: id, operationId: id })).rejects.toThrow("another Blender session");
});


test("manual export replay preserves its key and epoch and changed intent is rejected", async () => {
  const bodies: string[] = []; const ctx = { requestContext: { projectSlug: "fixture" }, toolCallId: "export-call" } as never;
  globalThis.fetch = mock(async (_input, init) => { if (!init?.method) return Response.json({ session: { ...session, state: "ready", stopReason: null } });
    bodies.push(String(init.body)); return Response.json({ operation: { id, sessionId: id } }); }) as unknown as typeof fetch;
  await call({ action: "export", sessionId: id }, ctx); await call({ action: "export", sessionId: id }, ctx);
  expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]!).epoch).toBe(1);
  await expect(call({ action: "retry", sessionId: id }, ctx)).rejects.toThrow("cannot change"); expect(bodies.length).toBe(2);
});

test("answer keeps checkpoint discard disabled unless explicitly supplied", async () => {
  const bodies: string[] = [];
  globalThis.fetch = mock(async (_input, init) => { if (init?.method) bodies.push(String(init.body)); return Response.json({ session }); }) as unknown as typeof fetch;
  expect(z.toJSONSchema(BlenderSessionActionInput, { io: "input", target: "draft-7" }).type).toBe("object");
  const input = BlenderSessionActionInput.parse({ action: "answer", sessionId: id, message: "使用蓝色" });
  await call(input); expect(JSON.parse(bodies[0]!)).toEqual({ message: "使用蓝色", discardUnknown: false });
});

test("AI ten-way submission passes the real API; over-limit requests leave no batch", async () => {
  const store = new BlenderStore(":memory:", undefined, { ownerRunMs: 600 * 60_000, globalRunMs: 6000 * 60_000, ownerModelCalls: 36, globalModelCalls: 144 });
  const secret = "fixture-concurrency-secret".repeat(2), jobs = new BlenderJobs(store);
  const api = createBlenderApi(store, { tick() {} }, { secret, build: "custom", desktopOrigin: "https://fixture.test", pauseEnabled: true }, jobs);
  const auth = { Authorization: "Bearer " + issueIdentity({ owner: "fixture", scope: "api", expires: Date.now() + 60_000 }, secret), "Content-Type": "application/json" };
  globalThis.fetch = mock(async (input, init) => api.request(new URL(String(input)).pathname.replace("/api/blender/", "/v1/"), { ...init, headers: auth })) as unknown as typeof fetch;
  try {
    const items = Array.from({ length: 11 }, (_, i) => ({ label: `Cube ${i}`, prompt: "Make a cube" }));
    const input = BlenderBatchInput.parse({ items, concurrency: 10 });
    const result = await withAssetStorage(storage, () => startBlenderBatchTool.execute!(input as never, { requestContext: { projectSlug: "fixture" }, toolCallId: "ten-way-call" } as never));
    expect((result as { items: unknown[] }).items).toHaveLength(11);
    for (let i = 0; i < 10; i++) expect(store.reserveNext()).not.toBeNull();
    expect(store.reserveNext()).toBeNull();
    expect(() => BlenderBatchInput.parse({ items, concurrency: 11 })).toThrow();
    const rejected = await api.request("/v1/batches", { method: "POST", headers: auth, body: JSON.stringify({ id: crypto.randomUUID(), project: "fixture", concurrency: 11, items: [{ id: "one", ...items[0] }] }) });
    expect(rejected.status).toBe(409); expect(store.list()).toHaveLength(11);
    const listed = await (await api.request("/v1/sessions", { headers: auth })).json() as { limits: unknown };
    expect(listed.limits).toEqual({ global: 100, owner: 10, queued: 100 });
    const defaultInput = BlenderBatchInput.parse({ items: items.slice(0, 2) });
    await withAssetStorage(storage, () => startBlenderBatchTool.execute!(defaultInput as never, { requestContext: { projectSlug: "fixture" }, toolCallId: "default-way-call" } as never));
    expect(store.db.query<{ concurrency: number }, []>("SELECT concurrency FROM batches ORDER BY rowid DESC LIMIT 1").get()?.concurrency).toBe(1);
    const otherAuth = { ...auth, Authorization: "Bearer " + issueIdentity({ owner: "api-default", scope: "api", expires: Date.now() + 60_000 }, secret) };
    const defaultResponse = await api.request("/v1/batches", { method: "POST", headers: otherAuth, body: JSON.stringify({ id: crypto.randomUUID(), project: "fixture", items: ["a", "b"].map(id => ({ id, label: id, prompt: "cube" })) }) });
    expect(defaultResponse.status).toBe(202); expect(store.reserveNext()?.owner).toBe("api-default"); expect(store.reserveNext()).toBeNull();
  } finally { store.close(); }
});
