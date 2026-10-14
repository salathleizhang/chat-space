/** Small synchronous SQL contract shared by Bun and Cloudflare SQLite. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export interface SqlDatabase {
  exec(sql: string): unknown;
  query<Row = Record<string, unknown>, Params extends SqlValue[] = SqlValue[]>(sql: string): {
    // Match Bun's conditional tuple signature exactly; no untyped query values escape.
    get(...params: Params extends any[] ? Params : [Params]): Row | null;
    all(...params: Params extends any[] ? Params : [Params]): Row[];
    run(...params: Params extends any[] ? Params : [Params]): unknown;
  };
  transaction<T>(work: () => T): { immediate(): T };
  close(): void;
}
