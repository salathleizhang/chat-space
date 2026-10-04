import { describe, expect, test } from "bun:test";
import { SETTLE_HOLD_MS, settleHeld } from "./settleHold";

describe("settleHeld", () => {
  test("刚静下来的第一帧只记起点，不落盘（这一刻可能是关节吊着的假静止）", () => {
    expect(settleHeld(null, true, 1000)).toEqual({ commit: false, stillSince: 1000 });
  });

  test("静够保持时长才落盘", () => {
    expect(settleHeld(1000, true, 1000 + SETTLE_HOLD_MS - 1).commit).toBe(false);
    expect(settleHeld(1000, true, 1000 + SETTLE_HOLD_MS).commit).toBe(true);
  });

  test("中途动了一下：计时清零，要重新静够", () => {
    // 半空松手那一瞬（速度≈0）→ 重力让它掉起来（没静）→ 落地后重新静下来
    const first = settleHeld(null, true, 1000);
    const moving = settleHeld(first.stillSince, false, 1100);
    expect(moving).toEqual({ commit: false, stillSince: null });
    const again = settleHeld(moving.stillSince, true, 1200);
    expect(again).toEqual({ commit: false, stillSince: 1200 });
    expect(settleHeld(again.stillSince, true, 1200 + SETTLE_HOLD_MS).commit).toBe(true);
  });

  test("一直没静过：永远不落盘（由调用方的超时兜底）", () => {
    expect(settleHeld(500, false, 9000)).toEqual({ commit: false, stillSince: null });
  });
});
