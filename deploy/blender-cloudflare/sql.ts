import type { SqlDatabase, SqlValue } from "../../chat/src/blenderService/sql";

export class DurableSql implements SqlDatabase {
  constructor(private readonly storage: DurableObjectStorage) {}
  exec(sql: string) { this.storage.sql.exec(sql); }
  query<Row = Record<string, unknown>, Params extends SqlValue[] = SqlValue[]>(sql: string) {
    const execute = (params: Params) => this.storage.sql.exec(sql, ...params.map(value => {
      if (typeof value === "boolean") return Number(value);
      if (typeof value === "bigint") { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("SQL integer overflow"); return n; }
      return value;
    }));
    return {
      get: (...params: Params): Row | null => execute(params).toArray()[0] as Row ?? null,
      all: (...params: Params): Row[] => execute(params).toArray() as Row[],
      run: (...params: Params) => { execute(params).toArray(); },
    };
  }
  transaction<T>(work: () => T) { return { immediate: () => this.storage.transactionSync(work) }; }
  close() { /* Cloudflare owns storage lifetime. */ }
}
