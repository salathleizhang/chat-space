import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMarkdown } from "./AgentMarkdown";

const mounted: { root: Root; container: HTMLElement }[] = [];

async function render(markdown: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(AgentMarkdown, null, markdown));
  });
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("AgentMarkdown", () => {
  test("把正文语法渲染为克制的语义结构，而不是显示标记字符", async () => {
    const container = await render(
      "**模型已生成。**\n\n- 已保存参考图\n- 已生成 `chair.glb`",
    );

    expect(container.querySelector("strong")?.textContent).toBe("模型已生成。");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("chair.glb");
    expect(container.textContent).not.toContain("**");
  });

  test("正文不执行原始 HTML，也不允许 Markdown 加载远程图片", async () => {
    const container = await render(
      '<script data-agent-injected>window.hacked = true</script>\n\n![追踪图](https://example.com/pixel.png)',
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[data-agent-injected]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("追踪图");
  });

  test("GFM 表格进入横向可滚动的受控容器", async () => {
    const container = await render("| 资产 | 状态 |\n| --- | --- |\n| 椅子 | 完成 |");

    const table = container.querySelector("table")!;
    expect(table).not.toBeNull();
    expect(table.parentElement?.classList.contains("overflow-x-auto")).toBe(true);
    expect(table.querySelectorAll("th")).toHaveLength(2);
  });
});
