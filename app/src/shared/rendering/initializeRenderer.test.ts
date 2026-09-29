import { expect, test, mock } from "bun:test";
import { initializeRenderer } from "./initializeRenderer";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("successful initialization keeps ownership with the caller", async () => {
  const renderer = { init: mock(async () => {}), dispose: mock(async () => {}) };
  expect(await initializeRenderer(renderer)).toBe(renderer);
  expect(renderer.init).toHaveBeenCalledTimes(1);
  expect(renderer.dispose).not.toHaveBeenCalled();
});

test("failed initialization cleans up once and preserves the error", async () => {
  const renderer = { init: mock(async () => { throw new Error("no adapter"); }), dispose: mock(async () => {}) };
  await expect(initializeRenderer(renderer)).rejects.toThrow("no adapter");
  await flush();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

test("timeout fails promptly but disposes only after late initialization completes", async () => {
  let complete!: () => void;
  const renderer = { init: () => new Promise<void>((resolve) => { complete = resolve; }), dispose: mock(async () => {}) };
  await expect(initializeRenderer(renderer, 1)).rejects.toThrow("timed out");
  expect(renderer.dispose).not.toHaveBeenCalled();
  complete(); await flush();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

test("late rejection and cleanup failure are handled after timeout", async () => {
  let fail!: (error: Error) => void;
  const renderer = { init: () => new Promise<void>((_, reject) => { fail = reject; }),
    dispose: mock(async () => { throw new Error("GPU service gone"); }) };
  await expect(initializeRenderer(renderer, 1)).rejects.toThrow("timed out");
  fail(new Error("adapter failed late")); await flush();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});
