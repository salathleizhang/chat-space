import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Sidebar, type SectionId } from "./index";

/**
 * 停靠区左侧那颗"分区菜单"的形状契约。
 *
 * 2026-10-14 用户报了一条重复：它曾经的第一颗是 `CubeFocusIcon` / `Back to projects`
 * （`navigate("/app")`），而外壳顶部居中那颗 `Leave current scene` 就是同一个动作——
 * "离开场景"被画了两遍。删掉的是**下面那颗**，顶部那颗必须留着（本文件只钉 Sidebar 这一侧，
 * 顶部那颗由 `AppDashboard` 持有）。
 *
 * 判据盯渲染出来的 `aria-label`（探针/可信驱动也按它找按钮），不碰 DOM 节点本身
 * （把节点塞进 `expect` 会让 bun 的失败格式化顺着 happy-dom 的环一路打印）。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

async function render(active: SectionId = "assets", onChange: (section: SectionId) => void = () => {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(Sidebar, { active, onChange }));
  });
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"));

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("Sidebar（停靠区左端的分区菜单）", () => {
  test("分区按钮与设置按钮按固定顺序出现，一颗不少", async () => {
    const container = await render();
    expect(labels(container)).toEqual([
      "Asset library",
      "Images",
      "Scenes",
      "Generation tasks",
      "Settings",
    ]);
  });

  test("不再有第二颗「离开场景」：Back to projects 已删（顶栏那颗才是唯一入口）", async () => {
    const container = await render();
    expect(labels(container)).not.toContain("Back to projects");
    // 顶栏那颗的文案也不该在这里冒出来（防的是有人换个名字把它加回来）
    expect(labels(container)).not.toContain("Leave current scene");
  });

  test("只剩一枚点状分隔线（首枚随那颗按钮一起删了，末枚隔开设置）", async () => {
    const container = await render();
    expect(container.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  test("点分区按钮把 id 交给调用方，点击不会带来导航副作用", async () => {
    const seen: SectionId[] = [];
    const container = await render("assets", (section) => seen.push(section));
    const button = [...container.querySelectorAll("button[aria-label]")]
      .find((b) => b.getAttribute("aria-label") === "Scenes") as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(seen).toEqual(["scenes"]);
  });
});
