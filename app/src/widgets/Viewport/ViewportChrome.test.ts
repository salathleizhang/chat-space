import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dockCornerSlotRef, dockRightSlotRef } from "../../shared/ui";
import { ViewportChrome, type ViewportChromeProps } from "./ViewportChrome";

/**
 * 两版视口（three 默认分支 / `?pcViewport=1`）的右下角 chrome 必须是**同一套 DOM**：
 * 同一批 `aria-label`、同一个顺序、同一个可空语义。这份测试就是那条契约——
 * 走查过：`?pcViewport=1` 那条路曾经自带一版"最小工具栏"（纯文字药丸），用户一眼看出两样。
 *
 * 判据全部盯**渲染出来的 DOM**（探针与可信驱动也是按 `aria-label` 找按钮的）。
 *
 * 也钉住两处落点（`shared/ui/dockRow.ts`）：
 * - 没有外壳（探针页）：控制簇**含撤销/重做**整块留在右下角，顺序不变；
 * - 有外壳（`pages/AppDashboard`）：控制簇钻进行右端那一格，**撤销/重做单独去屏幕右下角**。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];
/** 测试里造出来的停靠行槽位节点（统一在 afterEach 里摘掉，避免活在其它用例的 DOM 里） */
const slotNodes: HTMLElement[] = [];

async function render(props: Partial<ViewportChromeProps>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const full: ViewportChromeProps = {
    history: { undo: () => {}, redo: () => {}, canUndo: true, canRedo: false },
    transform: { mode: "translate", onMode: () => {}, space: "world", onSpace: () => {} },
    layout: { value: 1, onChange: () => {} },
    projection: { value: "perspective", onToggle: () => {} },
    grid: { visible: true, onToggle: () => {} },
    wireframe: { on: false, onToggle: () => {} },
    worldCollider: { visible: true, onToggle: () => {} },
    firstPerson: { active: false, onToggle: () => {} },
    handTracking: { active: false, onToggle: () => {} },
    hasContent: true,
    objectCount: 10,
    selectedCount: 0,
    splatBackground: true,
    ...props,
  } as ViewportChromeProps;
  await act(async () => {
    root.render(createElement(ViewportChrome, full));
  });
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"));

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined;

const texts = (container: HTMLElement) => [...container.querySelectorAll("span")].map((s) => s.textContent ?? "");

/** 默认道具全给全时，按钮的顺序与文案（与 three 侧那版逐字一致）。 */
const FULL_ORDER = [
  "Undo",
  "Redo",
  "Move (G)",
  "Rotate (R)",
  "Scale (S)",
  "Toggle world/local coordinates",
  "Single view",
  "Two views",
  "Four views (Blender layout)",
  "Toggle perspective/orthographic view",
  "Hide grid",
  "Wireframe shading (Shift+Z)",
  "Hide world terrain (collider mesh)",
  "Enter first-person view",
  "Enable hand tracking",
];

afterEach(async () => {
  // 先卸组件再清槽位：反过来的话那次通知会落到已经没人订阅的 store 上（React 会告警"裸更新"）
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  dockRightSlotRef(null);
  dockCornerSlotRef(null);
  for (const node of slotNodes.splice(0)) node.remove();
});

describe("ViewportChrome", () => {
  test("道具给全时的按钮顺序与 aria-label：撤销/重做 → 变换 → 视图控制", async () => {
    const container = await render({});
    expect(labels(container)).toEqual(FULL_ORDER);
  });

  test("传 null 的控件整只不出现（不留点了没反应的按钮）", async () => {
    const container = await render({
      transform: null,
      layout: null,
      projection: null,
      grid: null,
      worldCollider: null,
      firstPerson: null,
      handTracking: null,
      history: undefined,
    });
    expect(labels(container)).toEqual(["Wireframe shading (Shift+Z)"]);
  });

  test("撤销/重做不传时不出按钮，禁用态跟着 canUndo/canRedo", async () => {
    const noHistory = await render({ history: undefined });
    expect(labels(noHistory)).not.toContain("Undo");

    const disabled = await render({});
    expect(button(disabled, "Undo")?.disabled).toBe(false);
    expect(button(disabled, "Redo")?.disabled).toBe(true);
  });

  test("撤销/重做的 tooltip 带动作名（上层给的 label 进 title 文案）", async () => {
    // Tooltip 的文案只在悬浮时 portal 出来，这里退一步断"按钮在、且没把它当标签用"
    const container = await render({
      history: { undo: () => {}, redo: () => {}, canUndo: true, canRedo: true, undoLabel: "移动 黑猫" },
    });
    expect(button(container, "Undo")).toBeTruthy();
  });

  test("选中态写进 aria-pressed（探针按它读当前状态）", async () => {
    const container = await render({ layout: { value: 4, onChange: () => {} }, grid: { visible: false, onToggle: () => {} } });
    expect(button(container, "Four views (Blender layout)")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Single view")?.getAttribute("aria-pressed")).toBe("false");
    expect(button(container, "Show grid")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("按钮文案跟着状态走：网格显隐、线框着色、地形参照、第一人称、手势模式", async () => {
    const on = await render({
      grid: { visible: false, onToggle: () => {} },
      wireframe: { on: true, onToggle: () => {} },
      firstPerson: { active: true, onToggle: () => {} },
      handTracking: { active: true, onToggle: () => {} },
    });
    expect(labels(on)).toContain("Solid shading (Shift+Z)");
    expect(labels(on)).toContain("Show grid");
    expect(labels(on)).toContain("Return to orbit view");
    expect(labels(on)).toContain("Disable hand tracking");
    expect(button(on, "Disable hand tracking")?.getAttribute("aria-pressed")).toBe("true");

    const off = await render({ worldCollider: { visible: false, onToggle: () => {} } });
    expect(labels(off)).toContain("Show world terrain (collider mesh)");
    expect(labels(off)).toContain("Hide grid");
    expect(labels(off)).toContain("Wireframe shading (Shift+Z)");
    expect(labels(off)).toContain("Enter first-person view");
  });

  test("缩放模式下参考系按钮禁用（引擎在缩放时强制 local）", async () => {
    const container = await render({ transform: { mode: "scale", onMode: () => {}, space: "world", onSpace: () => {} } });
    expect(button(container, "Toggle world/local coordinates")?.disabled).toBe(true);
    expect(button(container, "Scale (S)")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("点击回调带着参数走：变换模式、参考系、布局、网格、线框、第一人称", async () => {
    const calls: string[] = [];
    const container = await render({
      transform: { mode: "translate", onMode: (m) => calls.push(`mode:${m}`), space: "world", onSpace: (s) => calls.push(`space:${s}`) },
      layout: { value: 1, onChange: (n) => calls.push(`layout:${n}`) },
      grid: { visible: true, onToggle: () => calls.push("grid") },
      wireframe: { on: false, onToggle: () => calls.push("wireframe") },
      projection: { value: "perspective", onToggle: () => calls.push("projection") },
      worldCollider: { visible: true, onToggle: () => calls.push("terrain") },
      firstPerson: { active: false, onToggle: () => calls.push("firstPerson") },
      handTracking: { active: false, onToggle: () => calls.push("handTracking") },
    });
    const click = async (label: string) => {
      await act(async () => { button(container, label)!.click(); });
    };
    await click("Rotate (R)");
    await click("Toggle world/local coordinates");
    await click("Four views (Blender layout)");
    await click("Hide grid");
    await click("Wireframe shading (Shift+Z)");
    await click("Toggle perspective/orthographic view");
    await click("Hide world terrain (collider mesh)");
    await click("Enter first-person view");
    await click("Enable hand tracking");
    expect(calls).toEqual([
      "mode:rotate", "space:local", "layout:4", "grid", "wireframe", "projection", "terrain", "firstPerson",
      "handTracking",
    ]);
  });

  test("徽章：物件数常驻，其余按状态出现", async () => {
    const bare = await render({ objectCount: 3, selectedCount: 0, splatBackground: false, wireframe: { on: false, onToggle: () => {} } });
    expect(texts(bare)).toContain("3 objects");
    expect(texts(bare).some((t) => t.startsWith("Selected:"))).toBe(false);
    expect(texts(bare)).not.toContain("Wireframe");
    expect(texts(bare)).not.toContain("Gaussian splat background");

    const rich = await render({ objectCount: 10, selectedCount: 2, splatBackground: true, wireframe: { on: true, onToggle: () => {} } });
    expect(texts(rich)).toContain("10 objects");
    expect(texts(rich)).toContain("Selected: 2");
    expect(texts(rich)).toContain("Wireframe");
    expect(texts(rich)).toContain("Gaussian splat background");
  });

  test("没有内容时整块徽章与第一人称提示都不出", async () => {
    const container = await render({ hasContent: false });
    expect(texts(container).some((t) => t.endsWith(" objects"))).toBe(false);
  });

  test("第一人称提示只在漫游时出现", async () => {
    const inWalk = await render({ firstPerson: { active: true, onToggle: () => {} } });
    expect(inWalk.textContent).toContain("Click the viewport to lock view");
    const orbit = await render({});
    expect(orbit.textContent).not.toContain("Click the viewport to lock view");
  });

  test("手势模式的提示：单独开时说捏合，与第一人称同时开时两件事都写在一句话里", async () => {
    const hands = await render({ handTracking: { active: true, onToggle: () => {} } });
    expect(hands.textContent).toContain("Pinch to grab");
    expect(hands.textContent).not.toContain("Click the viewport to lock view");

    const both = await render({
      firstPerson: { active: true, onToggle: () => {} },
      handTracking: { active: true, onToggle: () => {} },
    });
    expect(both.textContent).toContain("Click the viewport to lock view");
    expect(both.textContent).toContain("Pinch to grab");
    // 两块提示不能同时挂上去（会叠在同一个位置）
    const hints = [...both.querySelectorAll("div")].filter((node) =>
      node.className.includes("top-16") && node.className.includes("pointer-events-none"),
    );
    expect(hints).toHaveLength(1);
  });

  test("手势模式开着时出一个 Hand tracking 徽章", async () => {
    const off = await render({});
    expect(texts(off)).not.toContain("Hand tracking");
    const on = await render({ handTracking: { active: true, onToggle: () => {} } });
    expect(texts(on)).toContain("Hand tracking");
  });

  test("探针挂载点 data-pc-toolbar 只在显式传时出现（产品 DOM 里没有）", async () => {
    const without = await render({});
    expect(without.querySelector('[data-pc-toolbar="1"]')).toBeNull();

    const withHook = await render({ "data-pc-toolbar": "1" });
    const hook = withHook.querySelector('[data-pc-toolbar="1"]');
    expect(hook).toBeTruthy();
    // 钩子挂在右下角控制簇那一个容器上（驱动按它找工具栏）
    expect(hook!.querySelectorAll("button").length).toBe(FULL_ORDER.length);
  });

  test("控制簇与徽章都是绝对定位（叠在画布上，不吃指针事件）", async () => {
    const container = await render({});
    const cluster = container.querySelector("div.absolute") as HTMLElement;
    expect(cluster.className).toContain("bottom-4");
    expect(cluster.className).toContain("right-4");
    const badges = [...container.querySelectorAll("div")].find((d) => d.className.includes("bottom-24"))!;
    expect(badges.className).toContain("pointer-events-none");
  });

  test("外壳给了两个槽位时：控制簇进行右端那一格、撤销/重做单独去角落那一格", async () => {
    /*
      停靠区（`pages/AppDashboard` 底部）把两格交给这里：控制簇在输入框**正下方**、右对齐；
      撤销/重做在**屏幕右下角**、与停靠行同底对齐。判据有四条，缺一条都会静默走样：
      ① 按钮真的挂到各自的槽位下（不然工具栏/撤销还在右下角悬浮）；
      ② 进槽位后不再带 `absolute`（它已经是那一行的 flex item，再绝对定位就会脱出那一行）；
      ③ **撤销/重做只出现一份**（既在角落又留在簇里 = 用户看到两组撤销按钮）；
      ④ 徽章**不跟着走**——它属于视口，不属于外壳那一行。
    */
    const right = document.createElement("div");
    const corner = document.createElement("div");
    document.body.append(right, corner);
    slotNodes.push(right, corner);
    dockRightSlotRef(right);
    dockCornerSlotRef(corner);

    const container = await render({ "data-pc-toolbar": "1" });
    expect(container.querySelector('[data-pc-toolbar="1"]')).toBeNull();

    const cluster = right.querySelector('[data-pc-toolbar="1"]') as HTMLElement;
    expect(cluster).toBeTruthy();
    expect(cluster.className).not.toContain("absolute");
    // 角落那一格只有撤销/重做；簇里是其余控件（顺序与原 FULL_ORDER 去掉前两个一致）
    expect(labels(corner)).toEqual(["Undo", "Redo"]);
    expect(labels(cluster)).toEqual(FULL_ORDER.slice(2));
    expect([...cluster.querySelectorAll("button")].length).toBe(FULL_ORDER.length - 2);
    expect(texts(container)).toContain("10 objects");
  });

  test("只给行右端那一格（没有角落）时，撤销/重做仍留在簇里、顺序不变", async () => {
    /*
      窄窗口下外壳会把角落那一格退回行内（`max-[1000px]:static`），但**两个槽位节点都还在**；
      这条守的是另一半：宿主只登记了一个槽位时，撤销/重做不能凭空消失，也不能跑到簇尾。
    */
    const right = document.createElement("div");
    document.body.appendChild(right);
    slotNodes.push(right);
    dockRightSlotRef(right);

    const container = await render({ "data-pc-toolbar": "1" });
    expect(container.querySelector('[data-pc-toolbar="1"]')).toBeNull();
    const cluster = right.querySelector('[data-pc-toolbar="1"]') as HTMLElement;
    expect(labels(cluster)).toEqual(FULL_ORDER);
  });

  test("槽位登记得晚也会跟上：先渲染（右下角）→ 再登记 → 整块挪进停靠区", async () => {
    /*
      真实装载顺序是"先渲染视口、外壳的 ref 回调随后跑"，所以这个方向才是产品里第一次
      生效的那条路。用 `useSyncExternalStore` 订阅槽位就是为了这一步。
    */
    const container = await render({ "data-pc-toolbar": "1" });
    expect(container.querySelector('[data-pc-toolbar="1"]')).toBeTruthy();
    expect(button(container, "Undo")).toBeTruthy();

    const right = document.createElement("div");
    const corner = document.createElement("div");
    document.body.append(right, corner);
    slotNodes.push(right, corner);
    await act(async () => {
      dockRightSlotRef(right);
      dockCornerSlotRef(corner);
    });
    expect(container.querySelector('[data-pc-toolbar="1"]')).toBeNull();
    expect(right.querySelector('[data-pc-toolbar="1"]')).toBeTruthy();
    expect(labels(corner)).toEqual(["Undo", "Redo"]);
    expect(button(container, "Undo")).toBeUndefined();

    await act(async () => {
      dockRightSlotRef(null);
      dockCornerSlotRef(null);
    });
    expect(container.querySelector('[data-pc-toolbar="1"]')).toBeTruthy();
    expect(button(container, "Undo")).toBeTruthy();
  });

  test("控制簇的层级要**高于外壳的 z-10**，否则窄窗口里左半截点不动", async () => {
    /*
      实测（2026-10-02，真实页面 1500×950）：外壳输入框那排的容器是
      `pointer-events-none absolute inset-x-0 bottom-5 z-10`，而它在 DOM 里排在视口之后——
      平级 z-index 下后来者赢：`document.elementFromPoint()` 在 `Undo/Redo/Move/Rotate`
      的按钮中心返回的是外壳的 DIV，那几个按钮**点不动**。抬到 z-20 才修好，这条钉住它。
      （产品里控制簇现在钻在输入框**下面**那一行，这种重叠结构上不会再有；这条守的是
      **没有外壳槽位**的宿主——探针页、按 `bottom-4 right-4` 落位的那些。）
    */
    const container = await render({});
    const cluster = container.querySelector("div.absolute") as HTMLElement;
    const z = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(cluster.className);
    expect(z).toBeTruthy();
    expect(Number(z![1])).toBeGreaterThan(10); // 压过外壳那排输入框
    expect(Number(z![1])).toBeLessThan(40); // 但不能压过浮层（下拉/气泡是 z-40 / z-50）
  });
});
