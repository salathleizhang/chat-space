import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from ".";

/**
 * 两个构建共用这一个对话框，内容不同（见 `SettingsDialog` 头顶那段注释）。
 *
 * `bun test` 里 `import.meta.env.VITE_BROWSER_LOCAL` 没有值，走的正是**本地服务版**分支：
 * 所以这条测试钉住的是"本地版仍然看得到 `.env` 自检表、且**不**出现浏览器本地版的备份入口"。
 * 浏览器本地版那一支由真机驱动验（`.tmp/settings-backup/verify-settings.mjs`）——
 * 那个分支的开关是构建期常量，单测里翻不了。
 */
test("本地服务版：保留供应商状态表，不出现浏览器本地版的备份入口", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SettingsDialog)));
    expect(container.textContent).toContain("Settings · Local service");
    expect(container.textContent).toContain("Volcano Engine Ark");
    expect(container.textContent).toContain("Tencent Hunyuan");
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("Export backup");
    expect(container.textContent).not.toContain("Data is stored in this browser");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
