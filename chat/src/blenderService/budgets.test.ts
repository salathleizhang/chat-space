import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BlenderBudgets } from "./budgets";
import { BlenderStore } from "./store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const limits = { ownerRunMs: 3_600_000, globalRunMs: 7_200_000, ownerModelCalls: 2, globalModelCalls: 3 };
const now = Date.UTC(2026, 9, 11, 8);

test("runtime reservation enforces owner/global caps atomically and only confirmed stop releases unused runtime", () => {
  const db = new Database(":memory:"), b = new BlenderBudgets(db, limits);
  try {
    expect(b.reserve("a", "alice", "runtime", 3_600_000, now)).toBe(true);
    expect(b.reserve("a2", "alice", "runtime", 1, now)).toBe(false);
    expect(b.reserve("b", "bob", "runtime", 3_600_000, now)).toBe(true);
    expect(b.reserve("c", "carol", "runtime", 1, now)).toBe(false);
    b.settleRuntime("a", now + 600_000); b.settleRuntime("a", now + 1_200_000);
    expect(b.usage("alice", "runtime", "2026-10-11")).toEqual({ owner: 600_000, global: 4_200_000 });
    expect(b.reserve("a2", "alice", "runtime", 3_000_000, now + 600_000)).toBe(true);
    expect(b.reserve("a3", "alice", "runtime", 1, now)).toBe(false);
  } finally { db.close(); }
});
test("lost model responses consume cumulative call allowance and old ids cannot be repurposed", () => {
  const db = new Database(":memory:"), b = new BlenderBudgets(db, limits);
  try {
    expect(b.reserve("p1", "alice", "model-call", 1, now)).toBe(true);
    expect(b.reserve("p1", "alice", "model-call", 1, now)).toBe(true);
    expect(() => b.reserve("p1", "bob", "model-call", 1, now)).toThrow();
    expect(() => b.reserve("p1", "alice", "model-call", 2, now)).toThrow();
    b.settleRuntime("p1", now); // No refund of unknown paid calls.
    expect(b.reserve("p2", "alice", "model-call", 1, now)).toBe(true);
    expect(b.reserve("p3", "alice", "model-call", 1, now)).toBe(false);
    expect(b.reserve("pb", "bob", "model-call", 1, now)).toBe(true);
    expect(b.reserve("pc", "carol", "model-call", 1, now)).toBe(false);
    expect(b.reserve("tomorrow", "alice", "model-call", 1, now + 86_400_000)).toBe(true);
  } finally { db.close(); }
});
test("restart retains quota reservations and settled usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "blender-budget-")), path = join(directory, "budget.sqlite");
  try {
    let db = new Database(path), b = new BlenderBudgets(db, limits);
    b.reserve("a", "alice", "runtime", 3_600_000, now); b.reserve("p", "alice", "model-call", 1, now); db.close();
    db = new Database(path); b = new BlenderBudgets(db, limits);
    expect(b.reserve("a2", "alice", "runtime", 1, now)).toBe(false);
    expect(b.usage("alice", "model-call", "2026-10-11").owner).toBe(1);
    b.settleRuntime("a", now + 600_000); db.close();
    db = new Database(path); b = new BlenderBudgets(db, limits);
    expect(b.usage("alice", "runtime", "2026-10-11").owner).toBe(600_000); db.close();
  } finally { rmSync(directory, { recursive: true }); }
});
test("quota-limited owner stays queued while a different owner can be admitted", () => {
  const store = new BlenderStore(":memory:", { global: 4, owner: 3, queued: 100 }, limits);
  try {
    const a = store.create("alice", "project", "build", 3_600_000), waiting = store.create("alice", "project", "build", 3_600_000);
    const b = store.create("bob", "project", "build", 3_600_000);
    expect(store.reserveNext(now)?.id).toBe(a.id);
    expect(store.reserveNext(now)?.id).toBe(b.id);
    expect(store.reserveNext(now)).toBeNull();
    expect(store.session(waiting.id).state).toBe("queued");
    expect(store.effect(waiting.id, 0, "budget-wait")).toBe("daily_runtime_limit");
    store.transition(a.id, 1, ["allocating"], "quarantined");
    expect(store.reserveNext(now)).toBeNull();
    // A confirmation of expiry can settle unused reservation; quarantining alone cannot.
    store.transition(a.id, 1, ["quarantined"], "expired");
    expect(store.budgets.usage("alice", "runtime", "2026-10-11").owner).toBeLessThanOrEqual(3_600_000);
  } finally { store.close(); }
});
test("upgrading a database accounts for active quarantined resources before admitting new work", () => {
  const directory = mkdtempSync(join(tmpdir(), "blender-budget-upgrade-")), path = join(directory, "store.sqlite");
  try {
    let store = new BlenderStore(path, { global: 4, owner: 3, queued: 100 }, limits);
    const active = store.create("alice", "project", "build", 3_600_000); store.reserveNext();
    store.transition(active.id, 1, ["allocating"], "quarantined");
    store.db.exec("DROP TABLE blender_budget_entries"); store.close();
    store = new BlenderStore(path, { global: 4, owner: 3, queued: 100 }, limits);
    store.create("alice", "project", "build", 3_600_000);
    expect(store.reserveNext()).toBeNull();
    expect(store.budgets.summary("alice").runtime.usedAndReservedMs).toBe(3_600_000);
    store.close();
  } finally { rmSync(directory, { recursive: true }); }
});
