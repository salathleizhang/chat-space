import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tooltip } from "./Tooltip";

/**
 * `delay` 存在的理由不是手感，是成本：ModelList 的资产悬浮卡会在气泡里加载整个
 * 模型来抽贴图，鼠标扫过列表若逐行弹出，就是逐行拉起模型下载。所以这里断言的
 * 重点是"延迟内绝不挂载气泡内容"。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

async function render(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        Tooltip,
        { content: createElement("i", null, "气泡内容"), ...props } as never,
        createElement("button", null, "锚点"),
      ),
    );
  });
  return container;
}

/** React 19 的 onMouseEnter 由根节点上的 mouseover 委托合成，不能直接派发 mouseenter */
async function hover(container: HTMLElement) {
  const anchor = container.querySelector("span")!;
  await act(async () => {
    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

async function unhover(container: HTMLElement) {
  const anchor = container.querySelector("span")!;
  await act(async () => {
    anchor.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const bubble = () => document.querySelector('[role="tooltip"]');

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("Tooltip", () => {
  test("默认（delay=0）立刻弹出，不影响现有 tooltip 的手感", async () => {
    const container = await render({});
    await hover(container);
    expect(bubble()).not.toBeNull();
  });

  test("delay 期间不挂载气泡内容", async () => {
    const container = await render({ delay: 200 });
    await hover(container);
    expect(bubble()).toBeNull();

    await wait(60);
    expect(bubble()).toBeNull();

    await wait(220);
    expect(bubble()).not.toBeNull();
  });

  test("延迟未到就移开：气泡永远不出现（扫过列表的情形）", async () => {
    const container = await render({ delay: 200 });
    await hover(container);
    await wait(60);
    await unhover(container);

    await wait(300);
    expect(bubble()).toBeNull();
  });

  test("卸载时撤掉待弹出的定时器，不会事后冒出来", async () => {
    const container = await render({ delay: 200 });
    await hover(container);

    const entry = mounted.pop()!;
    await act(async () => entry.root.unmount());
    entry.container.remove();

    await wait(300);
    expect(bubble()).toBeNull();
    void container;
  });
});
