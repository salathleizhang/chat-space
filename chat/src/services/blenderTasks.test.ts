import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackBlenderTask, refreshBlenderTasks } from "./blenderTasks";
import { LocalFileStorage, withAssetStorage } from "./assetStorage";
import { withCloudContext } from "../cloud/context";
import { listTasks } from "./tasks";

const root = await mkdtemp(join(tmpdir(), "blender-watch-")), storage = new LocalFileStorage(root);
const oldFetch = globalThis.fetch, location = Object.getOwnPropertyDescriptor(globalThis, "location");
const session = { id: "c40f4c3a-9864-49ef-9135-8ce1137f96bc", project: "fixture", epoch: 0, state: "queued" };
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://fixture.test" } });
afterEach(() => { globalThis.fetch = oldFetch; });
afterAll(async () => { await rm(root, { recursive: true, force: true });
  if (location) Object.defineProperty(globalThis, "location", location); else Reflect.deleteProperty(globalThis, "location"); });

test("real task heartbeat waits through cloud publication and survives reloading the local task record", async () => {
  const task = await trackBlenderTask(storage, session, "Cube");
  let state = "ready", job = "planning";
  const methods: string[] = [];
  globalThis.fetch = mock(async (_url, init) => { methods.push(init?.method ?? "GET"); return Response.json({
    sessions: [{ ...session, epoch: 1, state }], jobs: { [session.id]: { state: job } },
  }); }) as unknown as typeof fetch;
  const read = () => withAssetStorage(storage, () => withCloudContext({ workspace: "browser", pending: [], enqueue: async () => {} }, () => listTasks("fixture")));
  expect((await read())[0]).toMatchObject({ id: task.id, status: "running", phase: "generating" });
  job = "succeeded"; state = "saving";
  expect((await read())[0]).toMatchObject({ status: "running", phase: "publishing" });
  state = "paused";
  expect((await read())[0]).toMatchObject({ status: "succeeded", result: { blenderSessionId: session.id } });
  const queries = methods.length;
  expect((await trackBlenderTask(storage, session, "Cube")).status).toBe("succeeded");
  await read(); expect(methods).toHaveLength(queries); expect(methods.every(method => method === "GET")).toBe(true);
});

test("a pending question settles once with the real cause; an authorized continuation gets a separate subscription", async () => {
  const s = { ...session, id: crypto.randomUUID() }, task = await trackBlenderTask(storage, s, "Question");
  globalThis.fetch = mock(async () => Response.json({ sessions: [{ ...s, epoch: 1, state: "paused" }],
    jobs: { [s.id]: { state: "waiting-user", error: "planning_http_429" } } })) as unknown as typeof fetch;
  const result = await refreshBlenderTasks(storage, [task]);
  expect(result[0]).toMatchObject({ status: "failed", error: "waiting-user: planning_http_429" });
  const next = await trackBlenderTask(storage, { ...s, epoch: 2 }, "Continued");
  expect(next.id).not.toBe(task.id); expect(next.status).toBe("running");
  globalThis.fetch = mock(async () => Response.json({ sessions: [{ ...s, project: "other" }], jobs: {} })) as unknown as typeof fetch;
  await expect(refreshBlenderTasks(storage, [next])).rejects.toThrow("Cannot read");
});
