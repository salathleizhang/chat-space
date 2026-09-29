import { expect, test } from "bun:test";
import { CaptureQueue } from "./CaptureQueue";
import { captureBytes, ResourceBudget } from "./ResourceBudget";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("inspection precedes thumbnails; one active batch; FIFO within priority", async () => {
  const queue = new CaptureQueue();
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const run = (name: string) => async () => { calls.push(name); expect(queue.stats.running).toBe(1); await tick(); return name; };
  const results = await Promise.all([
    queue.enqueue("thumbnail", signal, run("thumb1")),
    queue.enqueue("inspection", signal, run("inspection")),
    queue.enqueue("thumbnail", signal, run("thumb2")),
  ]);
  expect(calls).toEqual(["inspection", "thumb1", "thumb2"]);
  expect(results).toEqual(["thumb1", "inspection", "thumb2"]);
});

test("queued and running cancellation settle once, retain active slot until cleanup", async () => {
  const queue = new CaptureQueue();
  const active = new AbortController(), queued = new AbortController();
  let finish!: () => void;
  const first = queue.enqueue("inspection", active.signal, () => new Promise<void>((resolve) => { finish = resolve; }));
  const firstError = first.catch((error) => error.name);
  await tick();
  const second = queue.enqueue("thumbnail", queued.signal, async () => { throw new Error("Must never start"); });
  const secondError = second.catch((error) => error.name);
  queued.abort(); active.abort();
  expect(await firstError).toBe("AbortError"); expect(await secondError).toBe("AbortError");
  expect(queue.stats).toEqual({ pending: 0, running: 1 });
  finish(); await tick();
  expect(queue.stats).toEqual({ pending: 0, running: 0 });
});

test("aging prevents starvation and the pending queue is bounded", async () => {
  let now = 0;
  const queue = new CaptureQueue(2, () => now);
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const thumbnail = queue.enqueue("thumbnail", signal, async () => { calls.push("thumb"); });
  now = 1600;
  queue.interaction();
  const inspection = queue.enqueue("inspection", signal, async () => { calls.push("inspect"); });
  await expect(queue.enqueue("thumbnail", signal, async () => {})).rejects.toThrow("full");
  await thumbnail;
  now = 1800;
  await inspection;
  expect(calls).toEqual(["thumb", "inspect"]);
});

test("task failure releases the slot and pre-cancelled work never runs", async () => {
  const queue = new CaptureQueue(); const controller = new AbortController();
  controller.abort();
  await expect(queue.enqueue("inspection", controller.signal, async () => 1)).rejects.toHaveProperty("name", "AbortError");
  const signal = new AbortController().signal;
  const failed = queue.enqueue("inspection", signal, async () => { throw new Error("GPU lost"); });
  const next = queue.enqueue("thumbnail", signal, async () => 42);
  await expect(failed).rejects.toThrow("GPU lost");
  expect(await next).toBe(42);
});

test("capture budgets reject before allocation and release idempotently", () => {
  const budget = new ResourceBudget(100);
  const release = budget.reserve(80);
  expect(() => budget.reserve(21)).toThrow("budget");
  expect(budget.stats).toEqual({ used: 80, peak: 80, rejected: 1, limit: 100 });
  release(); release();
  expect(budget.stats.used).toBe(0);
  expect(captureBytes(65, 4)).toBeGreaterThan(65 * 65 * 4);
  for (const size of [0, -1, 1.5, 4097, Infinity, NaN]) expect(() => captureBytes(size, 4)).toThrow();
});
