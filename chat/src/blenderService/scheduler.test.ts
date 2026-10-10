import { expect, test } from "bun:test";
import { BlenderScheduler } from "./scheduler";
import { SandboxSecrets } from "./secrets";
import { BlenderStore } from "./store";
import type { ExecutorReceipt } from "./executor";

function fixture() {
  const store = new BlenderStore(":memory:");
  const receipts = new Map<string, ExecutorReceipt>(); let creates = 0, executions = 0;
  const scheduler = new BlenderScheduler(store, new SandboxSecrets("s".repeat(40)), {
    sandboxes: { create: async id => { creates++; return "sandbox-" + id; }, list: async () => [], pause: async () => {} },
    executor: { health: async s => ({ sessionId: s.id, epoch: s.epoch, unknown: false, ready: true, protocolVersion: 1 }),
      submit: async (_s, _t, op) => { executions++; const r: ExecutorReceipt = { id: op.id, state: "succeeded", result: { objects: 1 } }; receipts.set(op.id, r); return r; },
      receipt: async (_s, _t, id) => receipts.get(id)!, checkpoint: async () => new TextEncoder().encode("BLENDER-fixture") },
    checkpoints: { commit: async (s, _bytes, id = "checkpoint") => ({ id, sessionId: s.id, epoch: s.epoch, build: s.build, manifestKey: "m", sceneKey: "s", sha256: "a", bytes: 1, createdAt: Date.now() }) },
  });
  return { store, scheduler, creates: () => creates, executions: () => executions };
}
test("external ticks drive two sessions with disabled timers and without a browser", async () => {
  const f = fixture(), original = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    const first = f.store.create("alice", "project", "build", 3_600_000), second = f.store.create("alice", "project", "build", 3_600_000);
    f.scheduler.tick(Date.now()); await f.scheduler.drain();
    f.scheduler.tick(Date.now() + 5_001); await f.scheduler.drain();
    expect(f.store.session(first.id).state).toBe("ready"); expect(f.store.session(second.id).state).toBe("ready");
    f.store.submit("alice", first.id, 1, "op-first", "get_scene_info", {});
    f.store.submit("alice", second.id, 1, "op-second", "get_scene_info", {});
    f.scheduler.tick(Date.now() + 10_002); await f.scheduler.drain();
    expect(f.executions()).toBe(2); expect(f.creates()).toBe(2);
    expect(f.store.pendingOperations(first.id)).toHaveLength(0);
  } finally { globalThis.setTimeout = original; f.scheduler.close(); f.store.close(); }
});
test("unknown create result is reconciled; no second billed create and slot remains reserved", async () => {
  const store = new BlenderStore(":memory:", { global: 1, owner: 1, queued: 100 }); let calls = 0;
  const scheduler = new BlenderScheduler(store, new SandboxSecrets("s".repeat(40)), {
    sandboxes: { create: async () => { calls++; throw new Error("response lost"); }, list: async () => [], pause: async () => {} },
    executor: { health: async () => { throw new Error("unused"); }, submit: async () => { throw new Error("unused"); }, receipt: async () => { throw new Error("unused"); }, checkpoint: async () => new Uint8Array() },
    checkpoints: { commit: async () => { throw new Error("unused"); } },
  });
  try {
    const s = store.create("alice", "project", "build", 3_600_000); store.create("bob", "project", "build", 3_600_000);
    scheduler.tick(); await scheduler.drain();
    scheduler.tick(Date.now() + 20_000); await scheduler.drain();
    expect(store.session(s.id).state).toBe("quarantined"); expect(calls).toBe(1);
    expect(store.reserveNext()).toBeNull();
  } finally { scheduler.close(); store.close(); }
});
