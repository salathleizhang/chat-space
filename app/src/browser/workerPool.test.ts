import { afterEach, describe, expect, test } from "bun:test";
import {
  IDLE_POOL_LIMIT,
  acquireWorker,
  idleWorkers,
  liveWorkers,
  releaseWorker,
  resetWorkerPool,
  setWorkerFactory,
  workerRequest,
} from "./workerPool";

/**
 * 假 Worker：捕获 postMessage 里传进来的 port，用它模拟 runtime 的回复。
 *
 * 真 Worker 起不来也没必要起——这里要钉的是**池化行为**（谁被复用、谁必须销毁），
 * 不是 runtime 内部。`node --watch` 那类"真起一个 1.37MB 模块图"的验证在真实浏览器。
 */
class FakeWorker {
  static created: FakeWorker[] = [];
  terminated = false;
  onerror: ((event: { message?: string }) => void) | null = null;
  private port?: MessagePort;
  constructor() { FakeWorker.created.push(this); }
  postMessage(message: { port: MessagePort }) { this.port = message.port; }
  terminate() { this.terminated = true; }
  respond(status = 200) {
    this.port!.postMessage({ status, headers: [] });
    this.port!.postMessage({ done: true });
  }
  fail(message: string) { this.port!.postMessage({ error: message }); }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const asWorker = (worker: FakeWorker) => worker as unknown as Worker;

afterEach(() => {
  resetWorkerPool();
  FakeWorker.created = [];
  setWorkerFactory(undefined);
});

describe("浏览器本地运行时的 Worker 池", () => {
  test("连续两个请求复用同一个 Worker（不再每次重装 1.37MB 运行时）", async () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    for (let index = 0; index < 2; index += 1) {
      const pending = workerRequest({ path: "/api/tasks" });
      FakeWorker.created.at(-1)!.respond(200);
      expect((await pending).status).toBe(200);
      await flush();
    }
    expect(FakeWorker.created.length).toBe(1);
    expect(idleWorkers.length).toBe(1);
    expect(liveWorkers.size).toBe(0);
  });

  test("并发请求各拿一个 Worker：绝不并发复用（AsyncLocalStorage 隔离靠它）", async () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    const first = workerRequest({ path: "/api/tasks" });
    const second = workerRequest({ path: "/api/chat/stream" });
    expect(FakeWorker.created.length).toBe(2);
    FakeWorker.created[0]!.respond(200);
    FakeWorker.created[1]!.respond(200);
    await Promise.all([first, second]);
    await flush();
    expect(idleWorkers.length).toBe(2);
  });

  test("被中止的 Worker 直接销毁、不放回池子（状态未知）", async () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    const controller = new AbortController();
    const pending = workerRequest({ path: "/api/tasks" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await flush();
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    expect(idleWorkers.length).toBe(0);
    // 下一个请求必须重新起一个：复用被中止的 Worker 会带着半截状态继续跑
    const next = workerRequest({ path: "/api/tasks" });
    FakeWorker.created.at(-1)!.respond(200);
    await next;
    expect(FakeWorker.created.length).toBe(2);
  });

  test("出错的 Worker 同样销毁，不放回池子", async () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    const pending = workerRequest({ path: "/api/tasks" });
    FakeWorker.created[0]!.fail("runtime blew up");
    await expect(pending).rejects.toThrow("runtime blew up");
    await flush();
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    expect(idleWorkers.length).toBe(0);
  });

  test("任务类请求不进池子：它的 Worker 里留着任务闸门", async () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    const pending = workerRequest({ job: "task-1" });
    FakeWorker.created[0]!.respond(204);
    await pending;
    await flush();
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    expect(idleWorkers.length).toBe(0);
  });

  test("空闲池有上限，多出来的直接销毁（内存不无限涨）", () => {
    setWorkerFactory(() => asWorker(new FakeWorker()));
    const workers = [acquireWorker(), acquireWorker(), acquireWorker()];
    for (const worker of workers) releaseWorker(worker, true);
    expect(idleWorkers.length).toBe(IDLE_POOL_LIMIT);
    expect(workers.filter(worker => (worker as unknown as FakeWorker).terminated).length).toBe(1);
  });
});
