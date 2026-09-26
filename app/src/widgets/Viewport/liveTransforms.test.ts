import { describe, expect, test } from "bun:test";
import { createLiveTransforms } from "./liveTransforms";
import type { AssetPlacement } from "./scenePlacement";

/**
 * 这张表同时服务两条路径：场景每帧命令式读（不重渲染），右侧栏订阅读（只重渲染输入格）。
 * 所以既要钉住"值本身对"，也要钉住订阅语义——尤其 `getSnapshot` 依赖的那条性质：
 * **没写入时 `get` 必须返回同一个引用**，否则 `useSyncExternalStore` 会判定成一直在变而无限重渲染。
 */

const PLACEMENT: AssetPlacement = {
  position: [1, 2, 3],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("createLiveTransforms", () => {
  test("空表：size 为 0，get 返回 undefined", () => {
    const live = createLiveTransforms();
    expect(live.size).toBe(0);
    expect(live.get("p/chair")).toBeUndefined();
  });

  test("写入后能取回，且两次读之间引用稳定（useSyncExternalStore 的前提）", () => {
    const live = createLiveTransforms();
    live.set("p/chair", PLACEMENT);
    expect(live.size).toBe(1);
    expect(live.get("p/chair")).toBe(PLACEMENT);
    expect(live.get("p/chair")).toBe(live.get("p/chair"));
  });

  test("每次写入通知订阅方一次；退订后不再收到", () => {
    const live = createLiveTransforms();
    let notified = 0;
    const unsubscribe = live.subscribe(() => {
      notified += 1;
    });

    live.set("p/chair", PLACEMENT);
    live.set("p/chair", { ...PLACEMENT, position: [4, 5, 6] });
    expect(notified).toBe(2);

    unsubscribe();
    live.set("p/chair", PLACEMENT);
    expect(notified).toBe(2);
  });

  test("多选整体拖拽：每个成员各写一次，订阅方各收一次通知", () => {
    const live = createLiveTransforms();
    let notified = 0;
    live.subscribe(() => {
      notified += 1;
    });
    live.set("p/chair", PLACEMENT);
    live.set("p/table", PLACEMENT);
    expect(live.size).toBe(2);
    expect(notified).toBe(2);
  });

  test("clear 清空并通知；空表再 clear 不产生无谓通知", () => {
    const live = createLiveTransforms();
    let notified = 0;
    live.subscribe(() => {
      notified += 1;
    });

    live.clear();
    expect(notified).toBe(0);

    live.set("p/chair", PLACEMENT);
    live.clear();
    expect(notified).toBe(2);
    expect(live.size).toBe(0);
    expect(live.get("p/chair")).toBeUndefined();
  });

  test("订阅方在回调里退订不影响同一轮其余订阅者", () => {
    const live = createLiveTransforms();
    const seen: string[] = [];
    const unsubscribeFirst = live.subscribe(() => {
      seen.push("first");
      unsubscribeFirst();
    });
    live.subscribe(() => seen.push("second"));

    live.set("p/chair", PLACEMENT);
    expect(seen).toEqual(["first", "second"]);
  });
});
