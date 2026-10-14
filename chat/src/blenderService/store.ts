import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BlenderStore as CoreStore } from "./storeCore";
import type { BudgetLimits } from "./budgets";
import { DEFAULT_BLENDER_LIMITS } from "./limits";
export * from "./storeCore";
/** Local Linux/Mac adapter; Workers inject Durable Object SQLite into storeCore. */
export class BlenderStore extends CoreStore {
  constructor(path: string, limits = DEFAULT_BLENDER_LIMITS, budgets?: BudgetLimits) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    super(db, limits, budgets);
  }
}
