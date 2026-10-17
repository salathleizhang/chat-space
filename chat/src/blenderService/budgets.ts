import type { SqlDatabase } from "./sql";

export interface BudgetLimits { ownerRunMs: number; globalRunMs: number; ownerModelCalls: number; globalModelCalls: number }
export const TRIAL_BUDGETS: BudgetLimits = { ownerRunMs: 3 * 3_600_000, globalRunMs: 12 * 3_600_000, ownerModelCalls: 36, globalModelCalls: 144 };
export type BudgetKind = "runtime" | "model-call";
/**
 * Personal-usage query, deliberately a named constant: `budgets.test.ts` runs `EXPLAIN QUERY PLAN`
 * over **this exact string** to pin the read amplification. Drop the `owner` predicate and the plan
 * loses the full index key, the test fails, and a polled list endpoint goes back to reading every
 * owner's rows for the day.
 */
export const OWNER_USAGE_SQL = "SELECT COALESCE(SUM(quantity),0) total FROM blender_budget_entries WHERE day=? AND owner=? AND kind=?";
type Entry = { id: string; owner: string; kind: BudgetKind; day: string; quantity: number; startedAt: number; settled: number };
/** UTC-day admission caps, persisted before a potentially billed external request. Not an invoice. */
export class BlenderBudgets {
  constructor(readonly db: SqlDatabase, readonly limits: BudgetLimits = TRIAL_BUDGETS) {
    if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid cumulative Blender budgets");
    db.exec(`CREATE TABLE IF NOT EXISTS blender_budget_entries (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
      day TEXT NOT NULL, quantity INTEGER NOT NULL, startedAt INTEGER NOT NULL, settled INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS blender_budget_day ON blender_budget_entries(day,owner,kind);`);
  }
  reserve(id: string, owner: string, kind: BudgetKind, quantity: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Invalid budget quantity");
    return this.db.transaction(() => {
      const prior = this.db.query<Entry, [string]>("SELECT * FROM blender_budget_entries WHERE id=?").get(id);
      if (prior) {
        if (prior.owner !== owner || prior.kind !== kind || prior.quantity !== quantity) throw new Error("Budget reservation identity changed");
        return true;
      }
      const day = new Date(now).toISOString().slice(0, 10), usage = this.usage(owner, kind, day);
      const ownerLimit = kind === "runtime" ? this.limits.ownerRunMs : this.limits.ownerModelCalls;
      const globalLimit = kind === "runtime" ? this.limits.globalRunMs : this.limits.globalModelCalls;
      if (usage.owner + quantity > ownerLimit || usage.global + quantity > globalLimit) return false;
      this.db.query("INSERT INTO blender_budget_entries VALUES (?,?,?,?,?,?,?)").run(id, owner, kind, day, quantity, now, kind === "model-call" ? 1 : 0);
      return true;
    }).immediate();
  }
  /** Release unused runtime only after cloud pause/expiry is confirmed. Unknown calls stay charged. */
  settleRuntime(id: string, now = Date.now()): void {
    this.db.transaction(() => {
      const entry = this.db.query<Entry, [string]>("SELECT * FROM blender_budget_entries WHERE id=?").get(id);
      if (!entry || entry.kind !== "runtime" || entry.settled) return;
      const used = Math.max(0, Math.min(entry.quantity, now - entry.startedAt));
      this.db.query("UPDATE blender_budget_entries SET quantity=?,settled=1 WHERE id=?").run(used, id);
    }).immediate();
  }
  usage(owner: string, kind: BudgetKind, day = new Date().toISOString().slice(0, 10)): { owner: number; global: number } {
    const row = this.db.query<{ personal: number; total: number }, [string, string, string]>(
      "SELECT COALESCE(SUM(CASE WHEN owner=? THEN quantity ELSE 0 END),0) personal,COALESCE(SUM(quantity),0) total FROM blender_budget_entries WHERE day=? AND kind=?")
      .get(owner, day, kind)!;
    return { owner: row.personal, global: row.total };
  }
  summary(owner: string) {
    return { day: new Date().toISOString().slice(0, 10), timezone: "UTC", runtime: { usedAndReservedMs: this.ownerUsage(owner, "runtime"), limitMs: this.limits.ownerRunMs },
      modelCalls: { used: this.ownerUsage(owner, "model-call"), limit: this.limits.ownerModelCalls } };
  }
  /**
   * Personal usage only. `usage()` above deliberately also computes the **global** total, so it has no
   * owner predicate and reads every owner's rows for that day — correct for admission, ruinous for a
   * list endpoint that a browser polls. Durable Objects bill rows read (free tier 5M/day), so a
   * 5-second poll against the global aggregate costs the whole day's ledger per call. Keeping the
   * owner predicate walks only this owner's slice of the index instead.
   */
  ownerUsage(owner: string, kind: BudgetKind, day = new Date().toISOString().slice(0, 10)): number {
    return this.db.query<{ total: number }, [string, string, string]>(OWNER_USAGE_SQL).get(day, owner, kind)!.total;
  }
}
