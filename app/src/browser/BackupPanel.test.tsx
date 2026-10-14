import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BackupPanel } from "./BackupPanel";

/**
 * 备份面板搬进设置对话框（原来悬在工作台底部/主页左下角）之后，钉住两件事：
 *
 * 1. 说明与两个按钮都在**同一个面板**里——"数据只存在这个浏览器"和它的出口不能再分家；
 * 2. 点导出**真的接到了逻辑上**：`ensureBrowserLocal()` 在 happy-dom 里必然抛
 *    （没有 Service Worker / IndexedDB），失败必须显示在 `role="status"` 上。
 *    只断言"按钮存在"的话，把 onClick 摘掉测试照样绿——这正是要防的静默失效。
 */
test("备份面板渲染说明与两个按钮，点击导出把失败原因显示出来", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BackupPanel)));
    expect(container.textContent).toContain("Data is stored in this browser");
    expect(container.textContent).toContain("Export backup");
    expect(container.textContent).toContain("Import backup");
    // 导入走隐藏的 file input，必须收 .zip
    const input = container.querySelector("input[type=file]");
    expect(input?.getAttribute("accept")).toBe(".zip");

    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Export backup");
    expect(exportButton?.disabled).toBe(false);
    await act(async () => { exportButton?.click(); await Promise.resolve(); });
    expect(container.querySelector("[role=status]")?.textContent ?? "").toContain("modern browser");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
