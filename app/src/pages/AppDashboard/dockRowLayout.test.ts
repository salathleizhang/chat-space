import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 底部停靠区的**布局契约**（源码级，`bun test` 里没有布局引擎，量不出真实盒子）。
 *
 * 需求（用户 2026-10-14 提的，随后又调过一版）：
 * 1. 左下 Sidebar 与右下视口工具栏挪到**输入框底下**，分别左对齐、右对齐；
 * 2. 输入框与停靠行**往下一点**、彼此**近一点**；
 * 3. 菜单**稍微大一点**（共享的 `ToolbarButton` 不为这里改尺寸，所以用 `scale-110` + 贴边 origin）；
 * 4. **撤销/重做**搬到**屏幕右下角**那一格，与停靠行同底对齐。
 *
 * 落地后有五个**静默失效**点，任何一个坏了都不报错、只是看起来不对：
 * - **宽度漂移**：停靠行的宽度必须与 `AgentDock` 内部那一列**同一条字面量**
 *   （`min(48rem, calc(100% - 2rem))`），分叉了"左对齐/右对齐"就不再与输入框对齐；
 * - **吃不到指针事件**：停靠区在外层 `pointer-events-none` 的容器里，漏了 `pointer-events-auto`
 *   就是"画得出来、一个按钮都点不动"；
 * - **行右端丢了 `ml-auto`**：没有选中时那一格是空的，`ViewportChrome` 一钻进来就会贴到
 *   Sidebar 旁边（左对齐），而不是贴列右边缘；
 * - **缩放 origin 写错**：`scale-110` 不带贴边 origin 时放大是**居中**的，
 *   于是 Sidebar 不再贴列左边、工具栏不再贴列右边；
 * - **角落那一格丢了窄窗口退路**：`absolute right-4` 在窄窗口（停靠行两侧没余量时）
 *   会盖住工具栏右端那几个按钮。
 *
 * 判据刻意只钉"结构上必须有"的几件事，不钉具体类名顺序（Tailwind 的类名顺序会被随手重排）。
 */

const SRC = resolve(import.meta.dir, "../..");
const dashboard = readFileSync(resolve(SRC, "pages/AppDashboard/index.tsx"), "utf8");
const agentDock = readFileSync(resolve(SRC, "widgets/AgentDock/index.tsx"), "utf8");

/** 停靠行那一格的宽度字面量（与 AgentDock 内部那一列必须一字不差）。 */
const COLUMN_WIDTH = "w-[min(48rem,calc(100%-2rem))]";

/** 取第一个满足整条 `className="…"` 属性的值（不从注释里抓：注释里的类名没有 `className=` 前缀）。 */
const classMatching = (pattern: RegExp): string =>
  new RegExp(`className="(${pattern.source})"`).exec(dashboard)?.[1] ?? "";

/** 按元素的 `ref={name}` 找它的 className（属性顺序无关；注释里不会有 `ref={`）。 */
const elementClasses = (refName: string): string => {
  const at = dashboard.indexOf(`ref={${refName}}`);
  if (at < 0) return "";
  const tag = dashboard.slice(dashboard.lastIndexOf("<div", at), dashboard.indexOf(">", at) + 1);
  return /className="([^"]*)"/.exec(tag)?.[1] ?? "";
};

test("停靠行的宽度与 AgentDock 内部那一列是同一条字面量（分叉 = 输入框与两个菜单不再对齐）", () => {
  expect(agentDock).toContain(COLUMN_WIDTH);
  expect(dashboard).toContain(COLUMN_WIDTH);
});

test("停靠区在外层 pointer-events-none 里，自己必须 pointer-events-auto 才点得动", () => {
  const row = classMatching(/[^"]*pointer-events-auto[^"]*/);
  const outer = classMatching(/[^"]*pointer-events-none[^"]*/);
  expect(outer).toContain("pointer-events-none");
  // 停靠行必须是"自动吃指针 + 能换行"的那一个（不是随便哪个子元素带上这个类）
  expect(row).toContain("flex-wrap");
  expect(row).toContain(COLUMN_WIDTH);
});

test("输入框与停靠行往下挪了、彼此更近：外层 bottom-4 + 输入框那层向下偏移", () => {
  const outer = classMatching(/[^"]*pointer-events-none absolute inset-x-0[^"]*/);
  expect(outer).toContain("bottom-4");
  // 输入框那层是零高的定位祖先：`-bottom-*` 把它往停靠行方向推，间距就从 20px 收到 10px
  const wrapper = classMatching(/relative -bottom[^"]*/);
  expect(wrapper).toContain("-bottom-2.5");
  expect(wrapper).toContain("w-full");
});

test("两个菜单用 scale-110 放大，且 origin 各自贴边（不然放大会把对齐顶掉）", () => {
  const right = elementClasses("dockRightSlotRef");
  expect(right).toContain("scale-110");
  expect(right).toContain("origin-bottom-right");
  // 左格（Sidebar 那层）贴左下角
  const left = classMatching(/[^"]*origin-bottom-left[^"]*/);
  expect(left).toContain("scale-110");
  expect(left).toContain("animate-chrome-enter");
});

test("撤销/重做那一格在屏幕右下角，且带窄窗口退路", () => {
  const corner = elementClasses("dockCornerSlotRef");
  expect(corner).toContain("absolute");
  expect(corner).toContain("right-4");
  // bottom-0 = 贴停靠行的底边（于是两边一样高），不是写死的屏幕底距
  expect(corner).toContain("bottom-0");
  expect(corner).toContain("scale-110");
  expect(corner).toContain("origin-bottom-right");
  // 停靠行两侧放不下这一格时退回行内（静态流），并且换行后仍贴右
  expect(corner).toContain("max-[1000px]:static");
  expect(corner).toContain("max-[1000px]:ml-auto");
});

test("行右端那一格 ml-auto：工具栏钻进来要贴右边缘（不是紧挨 Sidebar）", () => {
  expect(elementClasses("dockRightSlotRef")).toContain("ml-auto");
});

test("Sidebar 在停靠行里：不再有它自己的左下角绝对定位", () => {
  expect(dashboard).not.toContain("absolute bottom-4 left-4");
  const row = dashboard.slice(
    dashboard.indexOf(COLUMN_WIDTH),
    dashboard.indexOf("ref={dockRightSlotRef}"),
  );
  expect(row).toContain("<Sidebar");
});

test("输入框在停靠行之上：AgentDock 被包进零高的定位祖先，且停靠行在它后面", () => {
  const wrapper = dashboard.indexOf("<div className=\"relative -bottom");
  const dock = dashboard.indexOf("<AgentDock");
  const row = dashboard.indexOf(COLUMN_WIDTH);
  expect(wrapper).toBeGreaterThan(0);
  // 顺序：定位祖先 → AgentDock → 停靠行（流里的下一个兄弟 = 画在输入框下面）
  expect(dock).toBeGreaterThan(wrapper);
  expect(row).toBeGreaterThan(dock);
});
