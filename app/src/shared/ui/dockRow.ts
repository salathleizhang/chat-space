import { useSyncExternalStore } from "react";

/**
 * 底部停靠区的**槽位表**：外壳登记 DOM 节点，视口 chrome portal 进去。
 *
 * ### 为什么需要这个模块
 * 视口 chrome 的**状态**住在 `Viewport` 里（撤销栈、布局、网格、线框、第一人称…），
 * 但它的**位置**归应用外壳管（`pages/AppDashboard` 的底部停靠区）。这两者在 React 树上
 * 不是父子（`<Viewport>` 与 `<AgentDock>` 是兄弟），所以只能把"往哪儿画"单独交出去。
 *
 * 不这么做的两条老路都不好：
 * - **各自写一遍列宽/底距的字面量**（靠注释保证不漂移）：漂移了也不报错，只是表和输入框
 *   不再对齐；而且窄窗口下两侧各自换行、互相压住。
 * - **把状态提到 AppDashboard**：等于把视口的编辑状态搬到外壳，`Viewport` 与
 *   `PlayCanvasViewport` 两版都要跟着动。
 *
 * ### 两个槽位
 * - `right`：停靠行的右端那一格（视口控制簇：布局/透视/网格/线框/第一人称/手势）。
 * - `corner`：屏幕右下角那一格（撤销/重做），与停靠行**同底对齐**，所以两边一样高。
 *
 * 槽位为空时 `ViewportChrome` 走**旧位置**（控制簇含撤销/重做整块贴在右下角悬浮）——
 * 探针页（`app/pc-panes.html`）没有外壳，工具栏就照旧待在右下角，可信驱动的判据不受影响。
 *
 * ### 用它的纪律
 * - 外壳必须保证槽位节点**吃得到指针事件**（停靠区在外层 `pointer-events-none` 的容器里，
 *   漏了 `pointer-events-auto` 就是"工具栏画出来了但一个按钮都点不动"）。
 * - `ref` 必须是**稳定**的（用下面导出的两个 ref 回调，别写内联箭头函数）：内联箭头每次
 *   渲染换身份，React 会先以 `null` 再以节点各调一次，于是外壳每渲染一轮就通知两轮、
 *   portal 子树跟着重建。
 * - 同名槽位只登记**一个**节点：后登记的覆盖先登记的。
 */
export type DockSlotName = "right" | "corner" | "storage";

const slots: Record<DockSlotName, HTMLElement | null> = { right: null, corner: null, storage: null };
const listeners = new Set<() => void>();

function setDockSlot(name: DockSlotName, node: HTMLElement | null): void {
  if (slots[name] === node) return;
  slots[name] = node;
  for (const listener of listeners) listener();
}

/** 停靠行右端的 `ref`（直接写 `ref={dockRightSlotRef}`） */
export const dockRightSlotRef = (node: HTMLElement | null): void => setDockSlot("right", node);
/** 屏幕右下角的 `ref`（撤销/重做的家） */
export const dockCornerSlotRef = (node: HTMLElement | null): void => setDockSlot("corner", node);
/** 浏览器备份提示有自己的流内行，不能悬浮遮住 Sidebar。 */
export const dockStorageSlotRef = (node: HTMLElement | null): void => setDockSlot("storage", node);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前槽位节点；没有外壳（探针页）时为 `null`。 */
export function useDockSlot(name: DockSlotName): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slots[name], () => null);
}
