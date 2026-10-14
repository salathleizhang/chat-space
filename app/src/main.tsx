import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import {
  clearStaleChunkReloadFlag,
  installStaleChunkReload,
} from "./shared/lib/staleChunkReload";
import { clearLegacyApiKeys } from "./shared/storage/apiKeys";
import "./index.css";

// 先装自愈钩子再渲染：重新构建后旧标签页的懒加载 chunk 会 404，
// 那时整个工作台会落进 errorElement；这里自动重载一次拿新入口。
installStaleChunkReload({
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  reload: () => window.location.reload(),
  storage: sessionStorage,
});
clearStaleChunkReloadFlag();

clearLegacyApiKeys();

function AppRoot() {
  // 备份入口（导出/导入）不在这里：它跟着"数据只存在这个浏览器里"的说明一起搬进了
  // 设置对话框（`widgets/SettingsDialog` 的浏览器本地版分支）。
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
