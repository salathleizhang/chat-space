import { describe, expect, test } from "bun:test";
import { captureBytes, captureSizeLadder, MIN_CAPTURE_SIZE, ResourceBudget } from "./ResourceBudget";

const SAMPLES = 4;

describe("capture budget degradation", () => {
  test("keeps the requested size when the budget fits and releases exactly once", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES));
    let reclaims = 0;
    const reservation = budget.reserveCapture(512, SAMPLES, () => reclaims++);
    expect(reservation.size).toBe(512);
    expect(reservation.degraded).toBe(false);
    expect(reclaims).toBe(0);
    expect(budget.stats.used).toBe(captureBytes(512, SAMPLES));
    expect(budget.stats.rejected).toBe(0);
    expect(budget.downgrades).toEqual({ count: 0, last: null });
    reservation.release(); reservation.release();
    expect(budget.stats.used).toBe(0);
  });

  test("reclaims idle caches once, before degrading, and keeps the requested size", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES));
    const held = budget.reserve(captureBytes(512, SAMPLES));
    let reclaims = 0;
    const reservation = budget.reserveCapture(512, SAMPLES, () => { reclaims++; held(); });
    expect(reclaims).toBe(1);
    expect(reservation.size).toBe(512);
    expect(reservation.degraded).toBe(false);
    reservation.release();
    expect(budget.stats.used).toBe(0);
  });

  test("halves the edge when only the smaller step fits and reports the downgrade", () => {
    const budget = new ResourceBudget(captureBytes(256, SAMPLES));
    let reclaims = 0;
    const reservation = budget.reserveCapture(512, SAMPLES, () => reclaims++);
    expect(reclaims).toBe(1);
    expect(reservation.degraded).toBe(true);
    expect(reservation.size).toBe(256);
    expect(budget.stats.used).toBe(captureBytes(256, SAMPLES));
    expect(budget.stats.rejected).toBe(0);
    expect(budget.downgrades).toEqual({ count: 1, last: { requested: 512, actual: 256 } });
    reservation.release();
    expect(budget.stats.used).toBe(0);
  });

  test("walks the ladder one step at a time for a large request", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES));
    const reservation = budget.reserveCapture(1024, SAMPLES, () => {});
    expect(reservation.size).toBe(512);
    expect(budget.downgrades.last).toEqual({ requested: 1024, actual: 512 });
    reservation.release();
    expect(budget.stats.used).toBe(0);
  });

  test("rejects at the floor with an actionable error and intact accounting", () => {
    const budget = new ResourceBudget(captureBytes(256, SAMPLES));
    const hold = budget.reserve(1);
    let caught: Error | undefined;
    try {
      budget.reserveCapture(512, SAMPLES, () => {});
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/capture budget exceeded/);
    expect(caught?.message).toMatch(/limit .*in use .*need /);
    expect(caught?.message).toMatch(/at 256px \(requested 512px, floor 256px\)/);
    expect(caught?.message).toMatch(/smaller size/);
    expect(budget.stats.used).toBe(1);
    expect(budget.stats.rejected).toBe(1);
    expect(budget.downgrades.count).toBe(0);
    hold();
    expect(budget.stats.used).toBe(0);
    const recovered = budget.reserveCapture(256, SAMPLES, () => {});
    expect(recovered.size).toBe(256);
    recovered.release();
  });
});

describe("截图准入与模型账本联动", () => {
  /**
   * 这条锁的是那个"两本账各管各的"缺陷：截图账还有额度，但模型已经把内存占满时，
   * 仍然要按模型侧的余量决定放行/降级——否则分配 render target 就是直接设备丢失。
   */
  test("模型侧占满时降级；reclaim 腾出空间后恢复全分辨率", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES)); // 截图账本身很宽裕
    const modelLimit = 32 * 1024 * 1024;
    let models = modelLimit - 1; // 模型侧只剩 1 字节
    const pressure = { residentBytes: () => models, residentLimit: () => modelLimit };
    const shortfalls: number[] = [];
    const reservation = budget.reserveCapture(
      512, SAMPLES,
      (need) => { shortfalls.push(need); models = 0; },
      MIN_CAPTURE_SIZE, pressure,
    );
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]).toBeGreaterThan(0);
    // reclaim 之后同一尺寸能放下 → 不降级
    expect(reservation.size).toBe(512);
    expect(reservation.degraded).toBe(false);
    reservation.release();
    expect(budget.stats.used).toBe(0);
  });

  test("模型侧占满且腾不出来时降级，而不是放行", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES));
    const modelLimit = 8 * 1024 * 1024;
    // 模型侧只剩 4MB：放不下 512，但放得下 256
    const pressure = {
      residentBytes: () => modelLimit - 4 * 1024 * 1024,
      residentLimit: () => modelLimit,
    };
    let reclaims = 0;
    const reservation = budget.reserveCapture(512, SAMPLES, () => reclaims++, MIN_CAPTURE_SIZE, pressure);
    expect(reclaims).toBe(1);
    expect(reservation.degraded).toBe(true);
    expect(reservation.size).toBe(256);
    reservation.release();
  });

  test("两侧都放不下时报错，并写清楚卡住的是模型侧", () => {
    const budget = new ResourceBudget(captureBytes(512, SAMPLES));
    const pressure = { residentBytes: () => 1000, residentLimit: () => 1000 };
    let caught: Error | undefined;
    try {
      budget.reserveCapture(512, SAMPLES, () => {}, MIN_CAPTURE_SIZE, pressure);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/models hold /);
    expect(caught?.message).toMatch(/smaller size/);
    expect(budget.stats.rejected).toBe(1);
  });
});

describe("capture size ladder", () => {
  test("halves down to the floor and never upscales", () => {
    expect(captureSizeLadder(1024)).toEqual([1024, 512, 256]);
    expect(captureSizeLadder(512)).toEqual([512, 256]);
    expect(captureSizeLadder(300)).toEqual([300, 256]);
    expect(captureSizeLadder(MIN_CAPTURE_SIZE)).toEqual([256]);
    expect(captureSizeLadder(65)).toEqual([65]);
    expect(captureSizeLadder(1024, 512)).toEqual([1024, 512]);
  });

  test("rejects unsupported edges", () => {
    for (const size of [0, -1, 1.5, 4097, Infinity, NaN]) expect(() => captureSizeLadder(size)).toThrow("Unsupported capture dimensions.");
    expect(() => captureSizeLadder(512, 0)).toThrow("Unsupported capture dimensions.");
  });
});
