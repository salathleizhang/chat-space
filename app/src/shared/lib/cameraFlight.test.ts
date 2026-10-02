import { describe, expect, test } from "bun:test";
import {
  dampToward,
  FLIGHT_ARRIVE_EPS_SQ,
  FLIGHT_DAMP_LAMBDA,
  hasArrived,
} from "./cameraFlight";

describe("camera flight", () => {
  test("到达阈值就是文档里那个 0.02 世界单位", () => {
    // 这条不是废话：阈值改成别的数会让"飞行结束得多早"整个变样，
    // 而它同时决定贴近检查什么时候按快门。
    expect(Math.sqrt(FLIGHT_ARRIVE_EPS_SQ)).toBeCloseTo(0.02, 12);
  });

  test("阻尼单调逼近目标，且 Lambert 常数下的步进与解析解一致", () => {
    let value = 4.69;
    const delta = 1 / 60;
    for (let i = 0; i < 240; i += 1) {
      const next = dampToward(value, 0, FLIGHT_DAMP_LAMBDA, delta);
      expect(Math.abs(next)).toBeLessThan(Math.abs(value));
      expect(next).toBeGreaterThan(0);
      value = next;
    }
    // 4 s ≈ 240 帧后必然落在阈值内（这正是"超时前一定能到位"的依据）
    expect(hasArrived(0, value, 0)).toBe(true);
    // 解析解：y + (x − y)·e^(−λt)
    expect(dampToward(1, 0, FLIGHT_DAMP_LAMBDA, 0.5)).toBeCloseTo(Math.exp(-2), 12);
  });

  test("delta 为 0 时不跳变（后台切回来时 delta 很大也不该瞬移）", () => {
    expect(dampToward(3, 0, FLIGHT_DAMP_LAMBDA, 0)).toBe(3);
  });

  test("到达判定是严格小于：边界值不算到", () => {
    expect(hasArrived(0.019, 0, 0)).toBe(true);
    expect(hasArrived(0.02, 0, 0)).toBe(false);
    expect(hasArrived(0.021, 0, 0)).toBe(false);
    // 三维距离，不是逐轴比较：单轴 0.01 看着很小，三轴合起来必须仍算到
    const each = 0.01; // 3 × 0.0001 = 0.0003 < 0.0004
    expect(hasArrived(each, each, each)).toBe(true);
    const tooFarEach = 0.012; // 3 × 0.000144 > 0.0004，逐轴比会误判成"到了"
    expect(hasArrived(tooFarEach, tooFarEach, tooFarEach)).toBe(false);
  });
});
