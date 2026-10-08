import { LogicalPathSchema } from "../../../chat/src/dto/library";
export const BROWSER_DATABASE = "chatspace-local-v1";
export interface LocalEntry { path: string; value: Blob | string; updatedAt: number }
let database: Promise<IDBDatabase> | undefined;
export function openLocalDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "path" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error("请关闭旧的 ChatSpace 标签页后重试"));
  });
  return database;
}
export async function localEntries(prefix = ""): Promise<LocalEntry[]> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readonly");
    const request = tx.objectStore("files").getAll(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    request.onsuccess = () => resolve(request.result as LocalEntry[]);
    request.onerror = () => reject(request.error);
  });
}
export async function localEntry(path: string): Promise<LocalEntry | undefined> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("files", "readonly").objectStore("files").get(path);
    request.onsuccess = () => resolve(request.result as LocalEntry | undefined);
    request.onerror = () => reject(request.error);
  });
}
/** Multi-file commits (including large Blobs) never encode files as JSON/base64. */
export async function commitLocal(entries: LocalEntry[], remove: string[] = []): Promise<void> {
  // Validate the entire batch before opening a transaction: a synchronous
  // validation error must not leave earlier puts free to commit.
  for (const entry of entries) LogicalPathSchema.parse(entry.path);
  for (const path of remove) LogicalPathSchema.parse(path);
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    for (const path of remove) store.delete(path);
    for (const entry of entries) store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new Error(tx.error?.name === "QuotaExceededError" ? "本地存储空间不足，请先导出项目备份或清理空间" : tx.error?.message ?? "本地保存失败"));
    tx.onerror = () => {}; // onabort is authoritative; never report saved before commit.
  });
}
export class BrowserAssetStorage {
  onSidecar?: (path: string) => Promise<void>;
  async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`chatspace:file:${path}`, operation);
  }
  async readText(path: string) {
    const entry = await localEntry(LogicalPathSchema.parse(path));
    if (!entry) throw new Error(`本地文件不存在：${path}`);
    return typeof entry.value === "string" ? entry.value : entry.value.text();
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const entry = await localEntry(LogicalPathSchema.parse(path));
    if (!entry) throw new Error(`本地文件不存在：${path}`);
    return typeof entry.value === "string" ? new TextEncoder().encode(entry.value) : new Uint8Array(await entry.value.arrayBuffer());
  }
  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const entry = await localEntry(LogicalPathSchema.parse(path));
    if (!entry) throw new Error(`本地文件不存在：${path}`);
    return (typeof entry.value === "string" ? new Blob([entry.value]) : entry.value).stream();
  }
  writeText(path: string, value: string) { return commitLocal([{ path, value, updatedAt: Date.now() }]); }
  async writeTextAtomic(path: string, value: string) {
    if (/\/\.\d+-.+-request\.json$/.test(path)) await this.onSidecar?.(path);
    await this.writeText(path, value);
  }
  writeBytes(path: string, bytes: Uint8Array) { return commitLocal([{ path, value: new Blob([new Uint8Array(bytes)]), updatedAt: Date.now() }]); }
  async list(dir: string) { return [...new Set((await localEntries(dir + "/")).map(entry => entry.path.slice(dir.length + 1).split("/")[0]!))]; }
  async exists(path: string) { return Boolean(await localEntry(path)) || (await localEntries(path + "/")).length > 0; }
  createExclusive(path: string, content: string) {
    return this.withLock(path, async () => { if (await this.exists(path)) return false; await this.writeText(path, content); return true; });
  }
  async remove(path: string) { await commitLocal([], [path, ...(await localEntries(path + "/")).map(entry => entry.path)]); }
  async move(source: string, target: string) {
    const files = [...await localEntries(source + "/")];
    const own = await localEntry(source); if (own) files.push(own);
    if (!files.length) throw new Error(`本地文件不存在：${source}`);
    await commitLocal(files.map(entry => ({ ...entry, path: target + entry.path.slice(source.length) })), files.map(entry => entry.path));
  }
}
