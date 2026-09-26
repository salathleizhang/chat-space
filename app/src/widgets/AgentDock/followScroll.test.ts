import { describe, expect, test } from "bun:test";
import { followScrollToBottom, type ScrollTarget } from "./followScroll";

/**
 * 这里锁的是一次真实踩到的时序 bug：计划卡展开是动画长高的，跟帧只跟第一帧
 * （当时还是折叠高度）就收手，展开出来的步骤会整段留在容器外看不见。
 */

function harness(initialHeight: number, maxMs = 1200) {
  const frames: Array<() => void> = [];
  let clock = 0;
  const node: ScrollTarget = {
    scrollTop: 0,
    scrollHeight: initialHeight,
    isConnected: true,
  };
  followScrollToBottom(node, (callback) => frames.push(callback), () => clock, maxMs);
  return {
    node,
    /** 推进一帧（16ms）并执行该帧的回调 */
    runFrame(advanceMs = 16) {
      clock += advanceMs;
      frames.shift()?.();
    },
    pendingFrames: () => frames.length,
  };
}

describe("followScrollToBottom", () => {
  test("内容分帧长高时一直跟到底，不是只跟第一帧", () => {
    const test = harness(200);

    test.runFrame();
    expect(test.node.scrollTop).toBe(200);

    // 动画中段才长高：跟帧必须继续
    test.node.scrollHeight = 400;
    test.runFrame();
    expect(test.node.scrollTop).toBe(400);
  });

  test("高度稳定后收手，不再占用后续帧", () => {
    const test = harness(200);

    test.runFrame();
    test.runFrame();
    test.runFrame();
    test.runFrame();
    expect(test.pendingFrames()).toBe(0);
  });

  test("内容一直变（同时在流式输出）也不会无限跟下去", () => {
    const test = harness(100, 100);

    for (let index = 0; index < 20; index += 1) {
      test.node.scrollHeight += 10;
      test.runFrame();
    }
    expect(test.pendingFrames()).toBe(0);
    // 触到上限后内容还在长，跟帧已经收手——这正是上限存在的意义：不跟用户抢滚动
    expect(test.node.scrollTop).toBeLessThan(test.node.scrollHeight);
  });

  test("元素已经卸载就停止跟帧", () => {
    const test = harness(200);

    test.runFrame();
    test.node.isConnected = false;
    test.runFrame();
    expect(test.pendingFrames()).toBe(0);
  });
});
