/**
 * 请求 → Worker 的租借池。
 *
 * 为什么要复用：`/local-runtime.js` 是 1.37MB 的模块图（整个 chat 服务 + 全部工具 +
 * gltf-transform 等）。实测**热启一次 240ms、冷启 3.5s**，而工作台每秒一次的任务心跳、
 * 以及生成期间每个到期任务各发一次请求——生成时每秒新建并销毁 1~3 个 Worker。
 * 本机模式直连 Bun、完全没有这笔开销，这就是"网页版比本地卡"的一部分。
 *
 * 为什么池里每个 Worker 仍然**同时只服务一个请求**：上下文隔离靠 `node:async_hooks` 的
 * AsyncLocalStorage（cloud/context.ts、services/assetStorage.ts、common/taskPump.ts），
 * 而浏览器构建把它换成 nodeCompat 里"一个实例只存一个 value"的实现——同一个 Worker
 * 并发跑两个请求会让两边的项目/存储上下文**静默互相覆盖**。所以这里只做空闲复用，
 * 绝不并发复用；被中止、出错、或被消费方取消的 Worker 一律销毁，不放回池子。
 *
 * 任务类请求（`job`）同样不进池子：任务闸门（taskPump 的 byTask 注册表）活在 Worker 里，
 * 让一个跑过任务的 Worker 回到池中继续接普通请求，会留下没有主人的闸门。
 */
export const IDLE_POOL_LIMIT = 2;
/** 空闲的、可以立刻接下一个请求的 Worker。 */
export const idleWorkers: Worker[] = [];
/** 手上正有在飞请求/任务的 Worker：1Hz 心跳要广播给它们。 */
export const liveWorkers = new Set<Worker>();

let spawnWorker = (): Worker => new Worker("/local-runtime.js", { type: "module" });

/** 测试注入点：真起一个 1.37MB 的模块 Worker 没法在单测里复现池化行为。 */
export function setWorkerFactory(factory: (() => Worker) | undefined): void {
  spawnWorker = factory ?? (() => new Worker("/local-runtime.js", { type: "module" }));
}

/** 测试/卸载用：清空池并销毁，避免跨用例互相污染。 */
export function resetWorkerPool(): void {
  for (const worker of [...idleWorkers, ...liveWorkers]) worker.terminate();
  idleWorkers.length = 0;
  liveWorkers.clear();
}

export function acquireWorker(): Worker {
  const worker = idleWorkers.pop() ?? spawnWorker();
  liveWorkers.add(worker);
  return worker;
}

function retireWorker(worker: Worker): void {
  liveWorkers.delete(worker);
  const index = idleWorkers.indexOf(worker);
  if (index >= 0) idleWorkers.splice(index, 1);
  worker.terminate();
}

function recycleWorker(worker: Worker): void {
  liveWorkers.delete(worker);
  if (idleWorkers.length >= IDLE_POOL_LIMIT) {
    worker.terminate();
    return;
  }
  idleWorkers.push(worker);
}

/** reusable=false（中止/出错/被取消）时销毁：状态未知的 Worker 不复用。 */
export function releaseWorker(worker: Worker, reusable: boolean): void {
  if (reusable) recycleWorker(worker);
  else retireWorker(worker);
}

export interface WorkerRequestInput {
  path?: string;
  method?: string;
  body?: string;
  job?: string;
}

export function workerRequest(input: WorkerRequestInput, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const worker = acquireWorker();
    const channel = new MessageChannel();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let released = false;
    const release = (reusable: boolean) => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      channel.port1.onmessage = null;
      channel.port1.close();
      releaseWorker(worker, reusable && !input.job);
    };
    const abort = () => {
      const error = signal?.reason ?? new DOMException("Aborted", "AbortError");
      controller?.error(error);
      reject(error);
      release(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.onerror = event => {
      const error = new Error(event.message || "Failed to load the local runtime");
      controller?.error(error);
      reject(error);
      release(false);
    };
    channel.port1.onmessage = event => {
      const message = event.data as { status?: number; headers?: [string, string][]; chunk?: Uint8Array; done?: boolean; error?: string };
      if (message.error) { const error = new Error(message.error); controller?.error(error); reject(error); release(false); }
      else if (message.status !== undefined) {
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { release(false); } });
        resolve(new Response(stream, { status: message.status, headers: message.headers }));
      } else if (message.chunk) controller?.enqueue(message.chunk);
      else if (message.done) { controller?.close(); if (input.job) resolve(new Response(null, { status: 204 })); release(true); }
    };
    worker.postMessage({ path: "/api/health", method: "GET", ...input, port: channel.port2 }, [channel.port2]);
  });
}
