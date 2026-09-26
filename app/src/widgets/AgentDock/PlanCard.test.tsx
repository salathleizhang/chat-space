import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanStep, ProjectPlan } from "../../shared/lib/libraryApi";
import { PlanCard } from "./PlanCard";

/**
 * 卡片自己只负责"收放"和"报状态"。历史容器是定高的，展开后卡片下面那截会落到
 * 滚动区外——父级靠 onToggle(true) 决定把滚动位置跟到底，所以这里锁住这个回调：
 * 报的是**切换后**的状态，而且每次点击都要报。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

const planWith = (steps: PlanStep[]): ProjectPlan => ({
  schemaVersion: 1,
  revision: 1,
  title: "三只动物换绿色服装",
  steps,
  updatedAt: "2026-08-01T06:00:00.000Z",
});

const RUNNING = planWith([
  { id: "step-1", content: "生成参考图", status: "in_progress" },
  { id: "step-2", content: "生成模型", status: "pending" },
]);
const NOT_STARTED = planWith([
  { id: "step-1", content: "生成参考图", status: "pending" },
  { id: "step-2", content: "生成模型", status: "pending" },
]);

async function render(plan: ProjectPlan) {
  const onToggle = mock((_open: boolean) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(PlanCard, { plan, onToggle } as never));
  });
  return { container, onToggle };
}

const headerOf = (container: HTMLElement) =>
  container.querySelector("[data-plan-card-header]") as HTMLButtonElement;

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("PlanCard 展开/收起回调", () => {
  test("执行中的计划默认折叠，点击报「展开」，再点报「收起」", async () => {
    const { container, onToggle } = await render(RUNNING);
    expect(onToggle).not.toHaveBeenCalled();

    await act(async () => headerOf(container).click());
    expect(onToggle).toHaveBeenLastCalledWith(true);

    await act(async () => headerOf(container).click());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  test("还没开始执行的计划默认展开，点一下先报「收起」", async () => {
    const { container, onToggle } = await render(NOT_STARTED);

    await act(async () => headerOf(container).click());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});
