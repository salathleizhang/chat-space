import { describe, expect, test } from "bun:test";
import { CloudTaskPending, withCloudContext } from "./context";
import { pollProviderTask } from "../common/polling";
import { ChatServiceError } from "../common/errors";
import { getAssetStorage, LocalFileStorage, withAssetStorage } from "../services/assetStorage";
import { startCustomTask, listTasks } from "../services/tasks";
import { GenerationTaskSchema } from "../dto/tasks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadedBytes } from "../services/uploads";

const cloud = { workspace: "00000000-0000-4000-8000-000000000001", pending: [] as Promise<unknown>[], enqueue: async () => {}, polling: true };
describe("bounded browser task boundaries", () => {
  test("overlapping async requests keep separate storage contexts", async () => {
    const left = new LocalFileStorage("/tmp/workspace-left");
    const right = new LocalFileStorage("/tmp/workspace-right");
    const results = await Promise.all([left, right].map((storage) => withAssetStorage(storage, async () => {
      await Promise.resolve();
      return getAssetStorage();
    })));
    expect(results).toEqual([left, right]);
  });
  test("standalone server cannot read a browser-local file reference", async () => {
    await expect(uploadedBytes({ localPath: ".uploads/fixture" })).rejects.toThrow("Browser-local files cannot be read by the local service");
  });
  test("pending provider yields to the browser clock after one query without timer waiting", async () => {
    let attempts = 0;
    const result = await withCloudContext(cloud, () => pollProviderTask({
      label: "paid task", timeoutMs: 1000, requestTimeoutMs: 100, pollIntervalMs: 10_000,
      attempt: async () => { attempts++; return "running"; }, statusOf: (value) => value,
      isDone: (value) => value === "done", failureOf: () => undefined,
      timeoutError: () => new ChatServiceError("timeout", 504),
      wait: async () => { throw new Error("must not sleep"); },
    })).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CloudTaskPending);
    expect((result as CloudTaskPending).delaySeconds).toBe(10);
    expect(attempts).toBe(1);
  });
  test("task registration never executes paid provider code in the request", async () => {
    let submissions = 0;
    let queued = 0;
    const scope = { ...cloud, pending: [] as Promise<unknown>[], enqueue: async () => { queued++; } };
    const task = withCloudContext(scope, () => startCustomTask("3d", "demo", "fixture", async () => { submissions++; }, {
      cloudOperation: { operation: "3d", input: {} },
    }));
    await Promise.all(scope.pending);
    expect(task.id).toMatch(/^task-[a-f0-9-]{36}$/);
    expect(queued).toBe(1);
    expect(submissions).toBe(0);
  });
  test("another browser worker's running task is read without interruption or resubmit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-task-read-"));
    try {
      const storage = new LocalFileStorage(root);
      const task = GenerationTaskSchema.parse({ id: "task-fixture", projectSlug: "demo", workflowId: "3d", subject: "fixture",
        status: "running", phase: "generating", bootId: "another-instance", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await storage.writeText("projects/demo/tasks/task-fixture.json", JSON.stringify(task));
      const listed = await withAssetStorage(storage, () => withCloudContext(cloud, () => listTasks("demo")));
      expect(listed).toEqual([task]);
      expect(JSON.parse(await storage.readText("projects/demo/tasks/task-fixture.json"))).toEqual(task);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
