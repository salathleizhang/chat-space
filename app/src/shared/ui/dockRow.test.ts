import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dockCornerSlotRef, dockRightSlotRef, useDockSlot } from "./dockRow";

/**
 * 停靠区槽位的**订阅语义**（`pages/AppDashboard` ↔ `ViewportChrome` 之间那一根线）。
 *
 * 判据对应三种真实故障：
 * - **登记得晚**（外壳在视口之后提交）：订阅者必须收到通知——不然工具栏/撤销一直留在右下角；
 * - **重复登记同一节点**：不重复通知（`ref` 回调会被 React 反复调用）；
 * - **两个槽位互不串台**：`right` 变了不能带着 `corner` 一起重建（撤销/重做与工具栏是两块
 *   各自有入场动画的 DOM，互相重建会看见它们闪一下）。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];
const nodes: HTMLElement[] = [];

function makeNode(name: string): HTMLElement {
  const node = document.createElement("div");
  node.dataset.name = name;
  nodes.push(node);
  return node;
}

afterEach(async () => {
  // 先卸组件再清槽位：反过来的话那次通知会落到已经没人订阅的 store 上（React 会告警"裸更新"）
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  dockRightSlotRef(null);
  dockCornerSlotRef(null);
  for (const node of nodes.splice(0)) node.remove();
});

function Probe(): string {
  const right = useDockSlot("right");
  const corner = useDockSlot("corner");
  return `${right ? `right:${right.dataset.name}` : "no-right"}|${corner ? `corner:${corner.dataset.name}` : "no-corner"}`;
}

async function mountProbe() {
  const renders: string[] = [];
  function Counting(): string {
    const label = Probe();
    renders.push(label);
    return label;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(Counting));
  });
  return { container, renders };
}

describe("dockRow 槽位", () => {
  test("两个槽位初始都为空，各自独立地登记/清空", async () => {
    const { container, renders } = await mountProbe();
    expect(container.textContent).toBe("no-right|no-corner");

    const right = makeNode("toolbar");
    await act(async () => dockRightSlotRef(right));
    expect(container.textContent).toBe("right:toolbar|no-corner");

    const corner = makeNode("undo");
    await act(async () => dockCornerSlotRef(corner));
    expect(container.textContent).toBe("right:toolbar|corner:undo");

    // 清掉一个，另一个不受影响
    await act(async () => dockRightSlotRef(null));
    expect(container.textContent).toBe("no-right|corner:undo");

    // 每次变化各通知一次，中间没有多余的渲染
    expect(renders).toHaveLength(4);
  });

  test("登记同一个节点不触发重新渲染（React 的 ref 回调会被反复调用）", async () => {
    const { renders } = await mountProbe();
    const before = renders.length;

    const right = makeNode("toolbar");
    await act(async () => dockRightSlotRef(right));
    await act(async () => dockRightSlotRef(right));
    await act(async () => dockCornerSlotRef(null));
    expect(renders.length).toBe(before + 1);
  });
});
