import { describe, expect, test } from "bun:test";
import {
  isTripoPSeriesModel,
  TRIPO_CONCURRENCY_LIMITS,
  TripoCategoryGate,
  tripoCategoryFor,
} from "./tripoConcurrency";

describe("tripoCategoryFor", () => {
  test("生成端点按模型分 P / H 两个池（官方 P=5、H=10）", () => {
    expect(tripoCategoryFor("/generation/image-to-model", { model: "P1-20260311" })).toBe("generation-p");
    expect(tripoCategoryFor("/generation/image-to-model", { model: "P2-20260801" })).toBe("generation-p");
    expect(tripoCategoryFor("/generation/text-to-model", { model: "tripo-p1" })).toBe("generation-p");
    expect(tripoCategoryFor("/generation/multiview-to-model", { model: "P2-20260801" })).toBe("generation-p");
    expect(tripoCategoryFor("/generation/image-to-model", { model: "v3.1-20260211" })).toBe("generation-h");
    expect(tripoCategoryFor("/generation/image-to-model", { model: "v2.5-20250123" })).toBe("generation-h");
    // 缺省模型（提交端会补默认 v3.1）走 H 系列
    expect(tripoCategoryFor("/generation/image-to-model", {})).toBe("generation-h");
    expect(tripoCategoryFor("/generation/image-to-model")).toBe("generation-h");
  });

  test("其余类目按官方表分组，未知端点落到 other", () => {
    expect(tripoCategoryFor("/generation/image-to-multiview")).toBe("image-generation");
    expect(tripoCategoryFor("/generation/text-to-image")).toBe("image-generation");
    expect(tripoCategoryFor("/models/texture")).toBe("model-processing");
    expect(tripoCategoryFor("/models/convert")).toBe("model-processing");
    expect(tripoCategoryFor("/mesh/segment")).toBe("mesh-operations");
    expect(tripoCategoryFor("/mesh/decimate")).toBe("mesh-operations");
    expect(tripoCategoryFor("/animations/rig")).toBe("animation");
    expect(tripoCategoryFor("/animations/retarget")).toBe("animation");
    // 官方并发表里没列 /models/import，用表内最大值兜底
    expect(tripoCategoryFor("/models/import")).toBe("other");
    expect(TRIPO_CONCURRENCY_LIMITS.other).toBe(10);
  });

  test("P 系列别名识别：tripo-p1 / P2-日期 都算，v3.1 不算", () => {
    expect(isTripoPSeriesModel("P1-20260311")).toBe(true);
    expect(isTripoPSeriesModel("tripo-p1")).toBe(true);
    expect(isTripoPSeriesModel(" p2 ")).toBe(true);
    expect(isTripoPSeriesModel("tripo-v3.1")).toBe(false);
    expect(isTripoPSeriesModel("v3.1-20260211")).toBe(false);
    expect(isTripoPSeriesModel(undefined)).toBe(false);
  });
});

describe("TripoCategoryGate", () => {
  test("上限之内立即拿到槽，超出后排队", async () => {
    const gate = new TripoCategoryGate({ "generation-p": 2 });
    const first = await gate.acquire("generation-p");
    const second = await gate.acquire("generation-p");
    expect(gate.activeCount("generation-p")).toBe(2);
    expect(gate.queuedCount("generation-p")).toBe(0);

    let thirdReady = false;
    const third = gate.acquire("generation-p").then((release) => {
      thirdReady = true;
      return release;
    });
    await Bun.sleep(5);
    expect(thirdReady).toBe(false);
    expect(gate.queuedCount("generation-p")).toBe(1);

    first();
    const thirdRelease = await third;
    expect(thirdReady).toBe(true);
    expect(gate.activeCount("generation-p")).toBe(2);
    second();
    thirdRelease();
    expect(gate.activeCount("generation-p")).toBe(0);
  });

  test("先进先出：释放一个槽给最早等待的那个，不饿死", async () => {
    const gate = new TripoCategoryGate({ "mesh-operations": 1 });
    const held = await gate.acquire("mesh-operations");
    const order: number[] = [];
    const queued = [1, 2, 3].map((n) =>
      gate.acquire("mesh-operations").then((release) => {
        order.push(n);
        return release;
      }),
    );
    await Bun.sleep(5);
    held();
    (await queued[0]!)();
    (await queued[1]!)();
    (await queued[2]!)();
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  test("release 重复调用只生效一次，计数不会变成负数", async () => {
    const gate = new TripoCategoryGate({ animation: 1 });
    const release = await gate.acquire("animation");
    release();
    release();
    expect(gate.activeCount("animation")).toBe(0);
    // 还能正常再取
    const again = await gate.acquire("animation");
    expect(gate.activeCount("animation")).toBe(1);
    again();
  });

  test("类目之间互不影响（P 满不挡 H，官方语义）", async () => {
    const gate = new TripoCategoryGate({ "generation-p": 1, "generation-h": 1 });
    const p = await gate.acquire("generation-p");
    const h = await gate.acquire("generation-h");
    let pQueued = false;
    void gate.acquire("generation-p").then(() => {
      pQueued = true;
    });
    await Bun.sleep(5);
    expect(pQueued).toBe(false);
    // H 池这时是空的，可以正常再取
    expect(gate.activeCount("generation-h")).toBe(1);
    p();
    h();
  });
});
