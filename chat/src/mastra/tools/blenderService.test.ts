import { z } from "zod";
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage, withAssetStorage } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { blenderSessionActionTool, blenderSessionsTool, setBlenderExportImporter, BlenderSessionActionInput } from "./blenderService";

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
  for (const action of ["resume", "pause", "retry", "export", "import"]) await expect(call({ action, sessionId: id })).rejects.toThrow("其他项目");
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
  await expect(call({ action: "retry", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).rejects.toThrow("其他项目");
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
  await expect(call({ action: "resume", sessionId: id })).rejects.toThrow("answer 或 retry");
  await expect(call({ action: "export", sessionId: id })).rejects.toThrow("自动导出"); expect(posts).toEqual([]);
});

test("session discovery filters other projects and operation lookup binds the session", async () => {
  globalThis.fetch = mock(async input => String(input).endsWith("/sessions")
    ? Response.json({ sessions: [session, { ...session, id: "other", project: "other" }], jobs: {} })
    : String(input).includes("/operations/") ? Response.json({ operation: { sessionId: "other" } }) : Response.json({ session })) as unknown as typeof fetch;
  const result = await withAssetStorage(storage, () => blenderSessionsTool.execute!({} as never, context));
  expect((result as { sessions: { sessionId: string }[] }).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([id]);
  await expect(call({ action: "operation-status", sessionId: id, operationId: id })).rejects.toThrow("其他 Blender 会话");
});


test("manual export replay preserves its key and epoch and changed intent is rejected", async () => {
  const bodies: string[] = []; const ctx = { requestContext: { projectSlug: "fixture" }, toolCallId: "export-call" } as never;
  globalThis.fetch = mock(async (_input, init) => { if (!init?.method) return Response.json({ session: { ...session, state: "ready", stopReason: null } });
    bodies.push(String(init.body)); return Response.json({ operation: { id, sessionId: id } }); }) as unknown as typeof fetch;
  await call({ action: "export", sessionId: id }, ctx); await call({ action: "export", sessionId: id }, ctx);
  expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]!).epoch).toBe(1);
  await expect(call({ action: "retry", sessionId: id }, ctx)).rejects.toThrow("不能改变"); expect(bodies.length).toBe(2);
});

test("answer keeps checkpoint discard disabled unless explicitly supplied", async () => {
  const bodies: string[] = [];
  globalThis.fetch = mock(async (_input, init) => { if (init?.method) bodies.push(String(init.body)); return Response.json({ session }); }) as unknown as typeof fetch;
  expect(z.toJSONSchema(BlenderSessionActionInput, { io: "input", target: "draft-7" }).type).toBe("object");
  const input = BlenderSessionActionInput.parse({ action: "answer", sessionId: id, message: "使用蓝色" });
  await call(input); expect(JSON.parse(bodies[0]!)).toEqual({ message: "使用蓝色", discardUnknown: false });
});
