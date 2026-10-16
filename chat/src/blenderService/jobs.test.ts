import { expect, test } from "bun:test";
import { BlenderJobs } from "./jobs";
import { BlenderStore, type Session } from "./store";
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
/** A reserved, prepared session with the sandbox control token the export path opens. */
function readySession(store: BlenderStore, secrets: SandboxSecrets, sessionId: string): Session {
  const reserved = store.reserveNext()!;
  store.transition(reserved.id, reserved.epoch, ["allocating"], "ready", "sandbox-" + reserved.id);
  const session = store.session(sessionId);
  store.saveCredentials(sessionId, session.epoch, secrets.seal(secrets.generate(), sessionId, session.epoch));
  return session;
}
/** Exactly what the scheduler does with a batch tool operation: dispatch it, then deliver its receipt. */
function receipt(store: BlenderStore, sessionId: string, state: "succeeded" | "failed" = "succeeded", result: unknown = { ok: true }) {
  const epoch = store.session(sessionId).epoch, operation = store.claimOperation(sessionId, epoch);
  if (!operation) throw new Error("No queued operation to receipt");
  store.finishOperation(operation.id, epoch, state, result);
  return operation;
}
/**
 * Stands in for `BlenderArtifacts`: `list` is the authoritative record of what was
 * really published, so a commit that never registers an artifact is a failed publication.
 */
function fakeArtifacts(committing = true) {
  const published: string[] = [];
  const artifact = (id: string, sessionId: string) => ({ id, sessionId, objectKey: "obj", manifestKey: "man", bytes: 1024, sha256: "a".repeat(64), triangles: 12 });
  return { published, exports: {
    list: (_owner: string, sessionId: string) => published.map(id => artifact(id, sessionId)),
    commit: async (session: Session, operation: { id: string }) => {
      if (committing) published.push(operation.id);
      return artifact(operation.id, session.id);
    },
  } satisfies Pick<BlenderArtifacts, "list" | "commit"> };
}
test("a verified export publication ends the job instead of buying the decision that says done", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store), secrets = new SandboxSecrets("s".repeat(40));
  const { published, exports } = fakeArtifacts(); let modelCalls = 0; const prompts: string[] = [];
  const runner = new BlenderBatchRunner(jobs, async messages => {
    modelCalls++; prompts.push(messages.map(message => message.content).join("\n"));
    return { decision: { action: "tool", tool: "export_scene", arguments: { format: "glb" } } as const, tokens: 100 };
  }, exports, { exportFile: async () => new Uint8Array() }, secrets);
  try {
    const [item] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Table", prompt: "table" }], "build");
    await runner.step(readySession(store, secrets, item!.id));
    // The planner is told the export closes the job, so the cap cannot be spent on another inspection.
    expect(prompts[0]).toContain("Export is the final action");
    expect(prompts[0]).toContain("at most 12 decisions");
    expect(jobs.get(item!.id)!.pendingOperation).not.toBeNull();
    receipt(store, item!.id);
    // The incident: the export was the 12th and last admitted paid decision, and the
    // old code asked for a 13th one to hear the model say "done" — the cap failed the
    // job even though a verified GLB had already been published.
    const atCap = jobs.get(item!.id)!; atCap.requests = 12; jobs.save(atCap);
    await runner.step(store.session(item!.id));
    expect(published).toEqual([atCap.pendingOperation!]);
    expect(jobs.get(item!.id)).toMatchObject({ state: "succeeded", error: null, pendingOperation: null, requests: 12 });
    expect(store.session(item!.id).stopReason).toBe("ended");
    expect(modelCalls).toBe(1);
    await runner.step(store.session(item!.id));
    expect(jobs.get(item!.id)!.state).toBe("succeeded"); expect(modelCalls).toBe(1);
  } finally { store.close(); }
});
test("a publication that produced no artifact is not treated as completion", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store), secrets = new SandboxSecrets("s".repeat(40));
  const { published, exports } = fakeArtifacts(false);
  const runner = new BlenderBatchRunner(jobs, async () => ({ decision: { action: "tool", tool: "export_scene", arguments: { format: "glb" } } as const, tokens: 100 }),
    exports, { exportFile: async () => new Uint8Array() }, secrets);
  try {
    const [item] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Table", prompt: "table" }], "build");
    await runner.step(readySession(store, secrets, item!.id)); receipt(store, item!.id);
    await expect(runner.step(store.session(item!.id))).rejects.toThrow("Export publication not confirmed");
    expect(published).toEqual([]);
    expect(jobs.get(item!.id)!.state).toBe("running");
    expect(store.session(item!.id).stopReason).toBeNull();
  } finally { store.close(); }
});
test("cancelling while the export is being published never completes the job", async () => {
  const store = new BlenderStore(":memory:"), jobs = new BlenderJobs(store), secrets = new SandboxSecrets("s".repeat(40));
  const { published, exports } = fakeArtifacts();
  let release!: () => void; const publishing = new Promise<void>(resolve => { release = resolve; });
  const delayed = { list: exports.list, commit: async (session: Session, operation: { id: string }) => { await publishing; return exports.commit(session, operation); } };
  const runner = new BlenderBatchRunner(jobs, async () => ({ decision: { action: "tool", tool: "export_scene", arguments: { format: "glb" } } as const, tokens: 100 }),
    delayed, { exportFile: async () => new Uint8Array() }, secrets);
  try {
    const [item] = jobs.createBatch("alice", "project", crypto.randomUUID(), [{ id: "a", label: "Table", prompt: "table" }], "build");
    await runner.step(readySession(store, secrets, item!.id));
    const operation = receipt(store, item!.id);
    const work = runner.step(store.session(item!.id));
    const job = jobs.get(item!.id)!; job.state = "cancelled"; jobs.save(job); store.stop(item!.id, "alice", "cancelled");
    release(); await work;
    // Published bytes cannot be un-uploaded, but a publication that lands after the
    // cancellation must not rewrite the cancelled job, clear its operation or "end" it.
    expect(published).toEqual([operation.id]);
    expect(jobs.get(item!.id)).toMatchObject({ state: "cancelled", pendingOperation: operation.id, step: 0 });
    expect(store.session(item!.id).stopReason).toBe("cancelled");
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
