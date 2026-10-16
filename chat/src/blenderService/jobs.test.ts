import { expect, test } from "bun:test";
import { BlenderJobs } from "./jobs";
import { BlenderStore } from "./store";
import { BlenderBatchRunner, BlenderPlannerError, plannerReceipt } from "./batchRunner";
import { BlenderArtifacts } from "./artifacts";
import { SandboxSecrets } from "./secrets";
import type { ObjectStore } from "./objects";
const noObjects: ObjectStore = { put: async () => { throw new Error("unused"); }, get: async () => { throw new Error("unused"); }, downloadUrl: () => "unused" };
test("planner receives bounded geometry facts without screenshot base64", () => {
  const base64 = "private-image-payload".repeat(100_000);
  const receipt = plannerReceipt(JSON.stringify({ content: [{ type: "text", text: '{"objects":3}' }, { type: "image", data: base64, mimeType: "image/png" }] }));
  expect(receipt).toContain("objects"); expect(receipt).not.toContain("private-image-payload"); expect(receipt.length).toBeLessThan(1000);
});
test("batch acceptance is atomic, idempotent and observes its concurrency separately from item count", () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store), id = crypto.randomUUID();
  try {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: "item-" + i, label: "Model " + i, prompt: "Make a cube" }));
    const accepted = jobs.createBatch("alice", "project", id, items, "custom-build", 2);
    expect(jobs.createBatch("alice", "project", id, items, "custom-build", 2).map(s => s.id)).toEqual(accepted.map(s => s.id));
    expect(() => jobs.createBatch("alice", "project", id, [{ ...items[0]!, prompt: "Different model" }], "custom-build", 2)).toThrow("key reused");
    expect(store.reserveNext()).not.toBeNull(); expect(store.reserveNext()).not.toBeNull(); expect(store.reserveNext()).toBeNull();
    expect(() => jobs.list("bob", id)).toThrow("unavailable");
  } finally { store.close(); }
});
test("queue limit rolls back all batch items", () => {
  const store = new BlenderStore(":memory:", { global: 4, owner: 3, queued: 2 }), jobs = new BlenderJobs(store);
  try {
    expect(() => jobs.createBatch("alice", "project", crypto.randomUUID(), [0, 1, 2].map(i => ({ id: String(i), label: "Cube", prompt: "Make cube" })), "build")).toThrow("quota");
    expect(store.list()).toHaveLength(0);
    expect(store.db.query<{ n: number }, []>("SELECT count(*) n FROM batches").get()!.n).toBe(0);
  } finally { store.close(); }
});
test("unspecified batch concurrency runs one item until its pause is confirmed", () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store);
  try {
    jobs.createBatch("alice", "project", crypto.randomUUID(), ["a", "b"].map(id => ({ id, label: id, prompt: "cube" })), "build");
    const first = store.reserveNext()!; expect(first).not.toBeNull(); expect(store.reserveNext()).toBeNull();
    store.transition(first.id, first.epoch, ["allocating"], "pausing"); expect(store.reserveNext()).toBeNull();
    store.transition(first.id, first.epoch, ["pausing"], "paused"); expect(store.reserveNext()).not.toBeNull();
  } finally { store.close(); }
});
test("one lost paid planning response stops that job; an independent item still progresses", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store), secrets = new SandboxSecrets("s".repeat(40)); let modelCalls = 0;
  const runner = new BlenderBatchRunner(jobs, async messages => {
    modelCalls++;
    if (messages.some(m => m.content === "lost")) throw new Error("Response lost after billing");
    return { decision: { action: "tool", tool: "get_scene_info", arguments: {} }, tokens: 100 };
  }, new BlenderArtifacts(store, noObjects), { exportFile: async () => new Uint8Array() }, secrets);
  try {
    const items = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "lost", label: "Lost", prompt: "lost" }, { id: "works", label: "Works", prompt: "works" }], "build", 2);
    for (const item of items) {
      const reserved = store.reserveNext()!;
      store.transition(reserved.id, reserved.epoch, ["allocating"], "ready", "sandbox-" + reserved.id);
      await runner.step(store.session(item.id));
    }
    expect(jobs.get(items[0]!.id)!.state).toBe("waiting-user");
    expect(jobs.get(items[1]!.id)!.pendingOperation).not.toBeNull();
    await runner.step(store.session(items[0]!.id));
    expect(modelCalls).toBe(2);
    expect(store.session(items[0]!.id).stopReason).toBe("waiting-user");
  } finally { store.close(); }
});
test("restart with a planning marker never automatically buys the same model call again", () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store);
  try {
    const [s] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Cube", prompt: "cube" }], "build");
    const job = jobs.get(s!.id)!; job.state = "planning"; job.requests = 1; jobs.save(job);
    jobs.recoverPlanning();
    expect(jobs.get(s!.id)!.state).toBe("waiting-user"); expect(jobs.get(s!.id)!.requests).toBe(1);
  } finally { store.close(); }
});
test("failed planner decisions persist their cause and usage without paying for an automatic retry", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store); let calls = 0;
  const runner = new BlenderBatchRunner(jobs, async () => {
    calls++; throw new BlenderPlannerError("planning_output_truncated", 4096);
  }, new BlenderArtifacts(store, noObjects), { exportFile: async () => new Uint8Array() }, new SandboxSecrets("s".repeat(40)));
  try {
    const [item] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Figurine", prompt: "figurine" }], "build");
    const s = store.reserveNext()!; store.transition(s.id, s.epoch, ["allocating"], "ready", "sandbox");
    await runner.step(store.session(item!.id)); await runner.step(store.session(item!.id));
    expect(jobs.get(item!.id)).toMatchObject({ state: "waiting-user", error: "planning_output_truncated", tokens: 4096, requests: 1, step: 0 });
    expect(calls).toBe(1); expect(store.hasQueuedOperations(item!.id)).toBe(false);
  } finally { store.close(); }
});
test("retry is a separately authorized idempotent attempt and leaves successful sibling untouched", () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store);
  try {
    const [failed, sibling] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Cube", prompt: "cube" }, { id: "b", label: "Sphere", prompt: "sphere" }], "build");
    const job = jobs.get(failed!.id)!; job.state = "failed"; jobs.save(job);
    store.stop(failed!.id, "alice", "ended");
    const id = crypto.randomUUID(), next = jobs.retry("alice", failed!.id, id);
    expect(next.id).not.toBe(failed!.id); expect(jobs.retry("alice", failed!.id, id).id).toBe(next.id);
    expect(jobs.get(sibling!.id)!.state).toBe("queued"); expect(jobs.get(failed!.id)!.state).toBe("failed");
    expect(() => jobs.retry("bob", failed!.id, crypto.randomUUID())).toThrow("unavailable");
  } finally { store.close(); }
});
test("cancelling an in-flight paid planner preserves cancellation and never submits its returned tool", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store);
  let finish!: (value: import("./batchRunner").ModelDecision) => void;
  const runner = new BlenderBatchRunner(jobs, () => new Promise(resolve => { finish = resolve; }), new BlenderArtifacts(store, noObjects),
    { exportFile: async () => new Uint8Array() }, new SandboxSecrets("s".repeat(40)));
  try {
    const [item] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Cube", prompt: "cube" }], "build");
    const reserved = store.reserveNext()!; store.transition(reserved.id, reserved.epoch, ["allocating"], "ready", "sandbox");
    const work = runner.step(store.session(item!.id));
    const job = jobs.get(item!.id)!; job.state = "cancelled"; jobs.save(job); store.stop(item!.id, "alice", "cancelled");
    finish({ decision: { action: "tool", tool: "execute_blender_code", arguments: { code: "modify" } }, tokens: 123 }); await work;
    expect(jobs.get(item!.id)!.state).toBe("cancelled"); expect(jobs.get(item!.id)!.tokens).toBe(123);
    expect(store.hasQueuedOperations(item!.id)).toBe(false); expect(store.session(item!.id).stopReason).toBe("cancelled");
  } finally { store.close(); }
});
test("daily model cap prevents a paid request and waits without replaying or affecting siblings", async () => {
  const store = new BlenderStore(":memory:", { global: 4, owner: 3, queued: 100 },
    { ownerRunMs: 10_800_000, globalRunMs: 43_200_000, ownerModelCalls: 1, globalModelCalls: 4 });
  const jobs = new BlenderJobs(store); let paidCalls = 0;
  const runner = new BlenderBatchRunner(jobs, async () => {
    paidCalls++; throw new Error("paid response unknown");
  }, new BlenderArtifacts(store, noObjects), { exportFile: async () => new Uint8Array() }, new SandboxSecrets("s".repeat(40)));
  try {
    const items = jobs.createBatch("alice", "project", crypto.randomUUID(), ["a", "b"].map(id => ({ id, label: id, prompt: "cube" })), "build", 2);
    for (const item of items) {
      const s = store.reserveNext()!; store.transition(s.id, s.epoch, ["allocating"], "ready", "sandbox-" + s.id);
      await runner.step(store.session(item.id));
    }
    expect(paidCalls).toBe(1);
    expect(jobs.get(items[0]!.id)!.error).toBe("planning_result_unknown");
    expect(jobs.get(items[1]!.id)!.error).toBe("daily_model_call_limit");
    expect(jobs.get(items[1]!.id)!.requests).toBe(0);
    expect(store.hasQueuedOperations(items[1]!.id)).toBe(false);
    await runner.step(store.session(items[1]!.id)); expect(paidCalls).toBe(1);
  } finally { store.close(); }
});
test("upgrading an older job database counts missing paid calls once", () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store);
  try {
    const [session] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Cube", prompt: "cube" }], "build");
    const job = jobs.get(session!.id)!; job.requests = 3; job.state = "waiting-user"; jobs.save(job);
    // Before cumulative budgets existed, only the per-job request cursor was stored.
    store.db.exec("DELETE FROM service_meta WHERE key='model-budget-v1'");
    new BlenderJobs(store);
    expect(store.budgets.summary("alice").modelCalls.used).toBe(3);
    new BlenderJobs(store);
    expect(store.budgets.summary("alice").modelCalls.used).toBe(3);
  } finally { store.close(); }
});
