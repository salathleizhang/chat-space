import { describe, expect, test } from "bun:test";
import {
  clearStaleChunkReloadFlag,
  installStaleChunkReload,
} from "./staleChunkReload";

function makeHarness() {
  const listeners = new Map<string, (event: Event) => void>();
  const values = new Map<string, string>();
  let reloads = 0;
  installStaleChunkReload({
    addEventListener: (type, listener) => listeners.set(type, listener),
    reload: () => {
      reloads += 1;
    },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
  });
  return {
    values,
    get reloads() {
      return reloads;
    },
    fire() {
      let prevented = false;
      listeners.get("vite:preloadError")?.({
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as Event);
      return prevented;
    },
  };
}

describe("构建换代后的旧标签页自愈", () => {
  test("chunk 取不到时拦下报错并重载一次", () => {
    const harness = makeHarness();
    expect(harness.fire()).toBe(true);
    expect(harness.reloads).toBe(1);
  });

  test("同一标签页只重载一次，避免旧 chunk 反复 404 时死循环", () => {
    const harness = makeHarness();
    harness.fire();
    harness.fire();
    expect(harness.reloads).toBe(1);
  });

  test("入口重新加载成功后清标记，下一次换代仍能自愈", () => {
    const harness = makeHarness();
    harness.fire();
    clearStaleChunkReloadFlag({
      removeItem: (key) => void harness.values.delete(key),
    });
    harness.fire();
    expect(harness.reloads).toBe(2);
  });
});
