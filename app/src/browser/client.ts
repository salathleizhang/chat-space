import { commitLocal, localEntries, localEntry } from "./storage";
export const browserLocalEnabled = import.meta.env.VITE_BROWSER_LOCAL === "1";
let ready: Promise<void> | undefined;
export function ensureBrowserLocal() {
  ready ??= (async () => {
    if (!navigator.serviceWorker || !navigator.locks || !globalThis.indexedDB) throw new Error("The local build requires a modern browser that supports Service Worker, IndexedDB, and Web Locks");
    await navigator.serviceWorker.register("/local-files-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
    await navigator.storage?.persist?.().catch(() => false);
    // 历史版本可能把人物任务记为成功却漏写 asset.json。启动时只补本地元数据，
    // 在项目首次读取前完成，不重新提交任何供应商请求。
    const repairs = (await localEntries(".jobs/")).filter(entry => {
      try {
        const job = JSON.parse(entry.value as string) as { done?: boolean; publicationChecked?: boolean; descriptor?: { operation?: string } };
        return job.done && job.descriptor?.operation === "character" && !job.publicationChecked;
      } catch { return false; }
    });
    const repaired = await Promise.allSettled(repairs.map(entry => workerRequest({ job: entry.path.split("/").pop()!.replace(/\.json$/, "") })));
    for (const result of repaired) if (result.status === "rejected") console.error("Failed to publish a previously completed character", result.reason);
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}
const activeWorkers = new Set<Worker>();
function workerRequest(input: { path?: string; method?: string; body?: string; job?: string }, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/local-runtime.js", { type: "module" });
    activeWorkers.add(worker);
    const channel = new MessageChannel();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = () => { activeWorkers.delete(worker); worker.terminate(); channel.port1.close(); signal?.removeEventListener("abort", abort); };
    const abort = () => { const error = signal?.reason ?? new DOMException("Aborted", "AbortError"); controller?.error(error); reject(error); finish(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.onerror = event => { const error = new Error(event.message || "Failed to load the local runtime"); controller?.error(error); reject(error); finish(); };
    channel.port1.onmessage = event => {
      const message = event.data as { status?: number; headers?: [string, string][]; chunk?: Uint8Array; done?: boolean; error?: string };
      if (message.error) { const error = new Error(message.error); controller?.error(error); reject(error); finish(); }
      else if (message.status !== undefined) {
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { finish(); } });
        resolve(new Response(stream, { status: message.status, headers: message.headers }));
      } else if (message.chunk) controller?.enqueue(message.chunk);
      else if (message.done) { controller?.close(); if (input.job) resolve(new Response(null, { status: 204 })); finish(); }
    };
    worker.postMessage({ path: "/api/health", method: "GET", ...input, port: channel.port2 }, [channel.port2]);
  });
}
let driving = false;
/** No timer is trusted for progress: every existing GET /tasks heartbeat checks dueAt. */
async function driveJobs() {
  for (const worker of activeWorkers) worker.postMessage({ tick: true });
  if (driving) return;
  driving = true;
  try {
    const jobs = await localEntries(".jobs/");
    const due = jobs.filter(entry => { const job = JSON.parse(entry.value as string) as { nextAt: number; done?: boolean }; return !job.done && job.nextAt <= Date.now(); });
    // Independent attempts own independent workers/contexts; provider backoff is persisted.
    for (let offset = 0; offset < due.length; offset += 3) {
      await Promise.allSettled(due.slice(offset, offset + 3).map(entry => workerRequest({ job: entry.path.split("/").pop()!.replace(/\.json$/, "") })));
    }
  } finally { driving = false; }
}
export async function browserFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureBrowserLocal();
  if (path.startsWith("/api/capabilities") || path.startsWith("/api/blender/")) return fetch(path, { ...init, credentials: "same-origin" });
  if (path.startsWith("/api/tasks")) void driveJobs().catch(console.error);
  const response = await workerRequest({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined }, init?.signal ?? undefined);
  return response;
}
export async function stageLocalFile(file: Blob): Promise<{ localPath: string }> {
  await ensureBrowserLocal();
  const localPath = `.uploads/${crypto.randomUUID()}`;
  await commitLocal([{ path: localPath, value: file, updatedAt: Date.now() }]);
  return { localPath };
}
export async function localFileBlob(path: string): Promise<Blob> {
  const entry = await localEntry(path); if (!entry) throw new Error(`Local file not found: ${path}`);
  return typeof entry.value === "string" ? new Blob([entry.value]) : entry.value;
}
