import { describe, expect, test } from "bun:test";
import { clearViewportDebug, VIEWPORT_DEBUG_NAMES, viewportDebugEnabled } from "./viewportDebug";

describe("视口诊断开关", () => {
  test("开发构建 + ?pcDebug=1 才开", () => {
    expect(viewportDebugEnabled("?pcDebug=1", true)).toBe(true);
    expect(viewportDebugEnabled("?a=1&pcDebug=1", true)).toBe(true);
    expect(viewportDebugEnabled("pcDebug=1", true)).toBe(true);
  });

  test("不带标志不开（真实业务页面就是这一档）", () => {
    expect(viewportDebugEnabled("", true)).toBe(false);
    expect(viewportDebugEnabled("?pcViewport=1", true)).toBe(false);
    expect(viewportDebugEnabled("?pcDebug=0", true)).toBe(false);
    expect(viewportDebugEnabled(null, true)).toBe(false);
  });

  test("**生产构建一律不装**（就算带着查询串）", () => {
    expect(viewportDebugEnabled("?pcDebug=1", false)).toBe(false);
  });

  test("卸载会按名单清干净", () => {
    const target: Record<string, unknown> = {};
    for (const name of VIEWPORT_DEBUG_NAMES) target[name] = () => null;
    clearViewportDebug(target);
    expect(Object.keys(target)).toEqual([]);
  });
});