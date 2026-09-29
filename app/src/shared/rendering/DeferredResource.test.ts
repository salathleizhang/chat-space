import { expect, test, mock } from "bun:test";
import { DeferredResource } from "./DeferredResource";

const afterCleanup = () => new Promise((resolve) => setTimeout(resolve, 5));

test("StrictMode effect replay retains the same expensive resource", async () => {
  const dispose = mock(() => {});
  const create = mock(() => ({ dispose }));
  const resource = new DeferredResource(create);
  expect(create).not.toHaveBeenCalled();
  const first = resource.acquire();
  first.release();
  const replay = resource.acquire();
  await afterCleanup();
  expect(replay.value).toBe(first.value);
  expect(create).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  replay.release();
  await afterCleanup();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("last owner releases once and stale cleanup cannot destroy a new generation", async () => {
  const create = mock(() => ({ dispose: mock(() => {}) }));
  const resource = new DeferredResource(create);
  const first = resource.acquire(), second = resource.acquire();
  first.release(); first.release();
  await afterCleanup();
  expect(first.value.dispose).not.toHaveBeenCalled();
  second.release();
  await afterCleanup();
  expect(first.value.dispose).toHaveBeenCalledTimes(1);
  const next = resource.acquire();
  expect(next.value).not.toBe(first.value);
  first.release(); second.release();
  await afterCleanup();
  expect(next.value.dispose).not.toHaveBeenCalled();
  next.release();
  await afterCleanup();
  expect(next.value.dispose).toHaveBeenCalledTimes(1);
});

test("factory failure leaves no poisoned resource", async () => {
  let failed = true;
  const resource = new DeferredResource(() => {
    if (failed) throw new Error("device lost");
    return { dispose: mock(() => {}) };
  });
  expect(() => resource.acquire()).toThrow("device lost");
  failed = false;
  const lease = resource.acquire();
  lease.release();
  await afterCleanup();
  expect(lease.value.dispose).toHaveBeenCalledTimes(1);
});
