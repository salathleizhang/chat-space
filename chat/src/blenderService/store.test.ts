import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlenderStore } from "./store";

const stores: BlenderStore[] = [], paths: string[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });
function store(limits = { global: 4, owner: 3, queued: 100 }) { const s = new BlenderStore(":memory:", limits); stores.push(s); return s; }
function ready(s: BlenderStore, owner = "alice") {
  const row = s.create(owner, "project", "custom-build", 3_600_000);
  const reserved = s.reserveNext()!;
  expect(reserved.id).toBe(row.id);
  return s.transition(row.id, reserved.epoch, ["allocating"], "ready", "sandbox-" + row.id);
}
test("one owner can run three independent sessions; fourth stays queued", () => {
  const s = store();
  for (let i = 0; i < 4; i++) s.create("alice", "project", "custom-build", 3_600_000);
  const sessions = [s.reserveNext()!, s.reserveNext()!, s.reserveNext()!];
  expect(new Set(sessions.map(r => r.id)).size).toBe(3);
  expect(s.reserveNext()).toBeNull();
  expect(s.list().filter(r => r.state === "queued")).toHaveLength(1);
});
test("default owner admission permits ten sessions and releases capacity only after confirmed pause", () => {
  const s = new BlenderStore(":memory:"); stores.push(s);
  for (let i = 0; i < 11; i++) s.create("alice", "project", "custom-build", 60_000);
  const active = Array.from({ length: 10 }, () => s.reserveNext()!);
  expect(active.every(Boolean)).toBe(true); expect(new Set(active.map(r => r.id)).size).toBe(10);
  expect(s.reserveNext()).toBeNull();
  const first = active[0]!;
  s.transition(first.id, first.epoch, ["allocating"], "pausing");
  expect(s.reserveNext()).toBeNull();
  s.transition(first.id, first.epoch, ["pausing"], "paused");
  expect(s.reserveNext()?.owner).toBe("alice");
});
test("default global admission stops at one hundred across owners and resumes after release", () => {
  const s = new BlenderStore(":memory:"); stores.push(s);
  for (let owner = 0; owner < 11; owner++) for (let i = 0; i < 10; i++) s.create(`owner-${owner}`, "project", "custom-build", 60_000);
  const active = Array.from({ length: 100 }, () => s.reserveNext()!);
  expect(active.every(Boolean)).toBe(true); expect(new Set(active.map(r => r.id)).size).toBe(100);
  expect(s.reserveNext()).toBeNull(); expect(s.list().filter(r => r.state === "queued")).toHaveLength(10);
  const counts = new Map<string, number>(); for (const r of active) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  expect([...counts.values()].every(n => n <= 10)).toBe(true);
  const first = active[0]!; s.transition(first.id, first.epoch, ["allocating"], "paused");
  expect(s.reserveNext()).not.toBeNull(); expect(s.reserveNext()).toBeNull();
});
test("fair admission rotates owners even when one submits a large batch", () => {
  const s = store();
  for (let i = 0; i < 10; i++) s.create("alice", "project", "custom-build", 3_600_000);
  s.create("bob", "project", "custom-build", 3_600_000);
  expect(s.reserveNext()!.owner).toBe("alice");
  expect(s.reserveNext()!.owner).toBe("bob");
});
test("unconfirmed pause and quarantine consume capacity until platform confirmation", () => {
  const s = store({ global: 1, owner: 1, queued: 20 }), r = ready(s);
  s.create("bob", "project", r.build, 3_600_000);
  s.transition(r.id, r.epoch, ["ready"], "quarantined");
  expect(s.reserveNext()).toBeNull();
  s.transition(r.id, r.epoch, ["quarantined"], "pausing");
  expect(s.reserveNext()).toBeNull();
  s.transition(r.id, r.epoch, ["pausing"], "paused");
  expect(s.reserveNext()!.owner).toBe("bob");
});
test("idempotency keys return same receipt, reject changed code and cross-owner access", () => {
  const s = store(), r = ready(s);
  const first = s.submit("alice", r.id, r.epoch, "step-1", "execute_blender_code", { code: "print(1)" });
  expect(s.submit("alice", r.id, r.epoch, "step-1", first.tool, { code: "print(1)" }).id).toBe(first.id);
  expect(() => s.submit("alice", r.id, r.epoch, "step-1", first.tool, { code: "print(2)" })).toThrow("key reused");
  expect(() => s.submit("bob", r.id, r.epoch, "step-2", first.tool, {})).toThrow("unavailable");
  expect(() => s.operation(first.id, "bob")).toThrow("unavailable");
});
test("restart keeps unknown operations frozen; confirmed receipt unlocks next command", () => {
  const path = mkdtempSync(join(tmpdir(), "blender-store-")); paths.push(path);
  const file = join(path, "service.sqlite"), s = new BlenderStore(file); const r = ready(s);
  const op = s.submit("alice", r.id, r.epoch, "step-1", "execute_blender_code", { code: "print(1)" });
  s.submit("alice", r.id, r.epoch, "step-2", "get_scene_info", {});
  expect(s.claimOperation(r.id, r.epoch)!.id).toBe(op.id);
  s.close();
  const next = new BlenderStore(file); stores.push(next); next.recoverDispatched();
  expect(next.operation(op.id).state).toBe("unknown");
  expect(next.claimOperation(r.id, r.epoch)).toBeNull();
  next.finishOperation(op.id, r.epoch, "succeeded", { objects: 1 });
  expect(next.claimOperation(r.id, r.epoch)!.key).toBe("step-2");
});
test("stale lease cannot change scene or commit checkpoint; cancellation never resumes", () => {
  const s = store(), r = ready(s);
  expect(() => s.submit("alice", r.id, r.epoch - 1, "step", "get_scene_info", {})).toThrow("Stale lease");
  expect(() => s.commitCheckpoint({ id: "c", sessionId: r.id, epoch: 0, build: r.build, manifestKey: "m", sceneKey: "s", sha256: "a", bytes: 1, createdAt: Date.now() })).toThrow("Stale checkpoint");
  s.stop(r.id, "alice", "cancelled");
  expect(() => s.submit("alice", r.id, r.epoch, "step", "get_scene_info", {})).toThrow("cannot accept");
  expect(s.claimOperation(r.id, r.epoch)).toBeNull();
});
test("confirmed expiry restores only a committed command boundary, fences old receipts and preserves remaining budget", () => {
  const s = store(), r = ready(s);
  s.commitCheckpoint({ id: "c", sessionId: r.id, epoch: r.epoch, build: r.build, manifestKey: "m", sceneKey: "s", sha256: "a", bytes: 1, createdAt: Date.now() });
  const queued = s.submit("alice", r.id, r.epoch, "never-sent", "get_scene_info", {}), now = Date.now() + 60_000;
  s.transition(r.id, r.epoch, ["ready"], "expired");
  expect(s.recoverExpired(r.id, r.epoch, now)).toBe(true);
  expect(s.operation(queued.id).epoch).toBe(r.epoch + 1);
  expect(s.session(r.id).budgetMs).toBe(r.deadline - now);
  const next = s.reserveNext(now)!; expect(next.epoch).toBe(2); expect(next.deadline).toBe(r.deadline);
  expect(() => s.finishOperation(queued.id, 1, "succeeded", {})).toThrow("Stale operation");
});
test("expiry never replays unknown writes or uncommitted edits", () => {
  for (const mode of ["unknown", "dirty", "cancelled"] as const) {
    const s = store(), r = ready(s);
    s.commitCheckpoint({ id: "c", sessionId: r.id, epoch: r.epoch, build: r.build, manifestKey: "m", sceneKey: "s", sha256: "a", bytes: 1, createdAt: Date.now() });
    if (mode === "unknown") { const op = s.submit("alice", r.id, r.epoch, "step", "execute_blender_code", { code: "write" }); s.claimOperation(r.id, 1); s.finishOperation(op.id, 1, "unknown", {}); }
    if (mode === "dirty") s.setEffect(r.id, 1, "checkpoint-due", "1");
    if (mode === "cancelled") s.stop(r.id, "alice", "cancelled");
    s.transition(r.id, 1, ["ready"], "expired"); expect(s.recoverExpired(r.id, 1, Date.now())).toBe(false);
  }
});
test("unknown internal checkpoint executor is not resumed from its private snapshot", () => {
  const s = store(), r = ready(s);
  s.commitCheckpoint({ id: "c", sessionId: r.id, epoch: r.epoch, build: r.build, manifestKey: "m", sceneKey: "s", sha256: "a", bytes: 1, createdAt: Date.now() });
  s.setEffect(r.id, r.epoch, "executor-unknown", "1");
  s.transition(r.id, r.epoch, ["ready"], "paused");
  s.resume(r.id, "alice");
  const next = s.reserveNext()!;
  expect(next.epoch).toBe(2); expect(next.checkpoint).toBe("c");
  expect(s.effect(r.id, next.epoch, "resume-source")).toBeNull();
});
