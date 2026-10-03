import { describe, expect, test } from "bun:test";
import { taskStallLabel, taskSubjectLabel } from "./taskText";

describe("taskSubjectLabel", () => {
  test("把本地服务写的中文任务名翻成界面语言", () => {
    expect(taskSubjectLabel("3D 生成（Tripo 直连）：木餐桌")).toBe("3D generation (Tripo): 木餐桌");
    expect(taskSubjectLabel("续跑：.0-chair-request.json")).toBe("Resume: .0-chair-request.json");
  });
});

/**
 * 停顿文案的口径来自 chat 侧 `services/tasks.ts` 的 `STALLED_TASK_WARN_MS`（90 秒）与
 * `common/taskPump.ts` 的闸门：`pumpActive=false` 是另一层意思（本机没有推进闸门照看它），
 * 不能和"慢"混成一句话——前者要续跑/重试，后者只要继续等。
 */
describe("taskStallLabel", () => {
  test("90 秒出头按秒显示", () => {
    expect(taskStallLabel({ silentForMs: 91_000, pumpActive: true })).toBe("no progress for 91s");
  });

  test("两分钟以内仍按秒（刚过 90 秒阈值要看到 90s，不是四舍五入成 2 min）", () => {
    expect(taskStallLabel({ silentForMs: 95_000, pumpActive: true })).toBe("no progress for 95s");
  });

  test("超过两分钟按分钟显示（1 Hz 的看板不该刷一串数字）", () => {
    expect(taskStallLabel({ silentForMs: 119_000, pumpActive: true })).toBe("no progress for 119s");
    expect(taskStallLabel({ silentForMs: 9 * 60_000, pumpActive: true })).toBe("no progress for 9 min");
  });

  test("没有本机推进闸门时是另一句话：需要续跑/重试，而不是继续等", () => {
    expect(taskStallLabel({ silentForMs: 5 * 60_000, pumpActive: false })).toBe(
      "no local driver for 5 min",
    );
  });

  test("极小值不显示成 0s（服务端派生与前端渲染之间可能差几毫秒）", () => {
    expect(taskStallLabel({ silentForMs: 1, pumpActive: true })).toBe("no progress for 1s");
  });
});
