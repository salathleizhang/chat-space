import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import { AccessGatePage } from "./pages/AccessGatePage";
import {
  clearStaleChunkReloadFlag,
  installStaleChunkReload,
} from "./shared/lib/staleChunkReload";
import { hasPassedAccessGate } from "./shared/storage/accessGate";
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

/** 访问门禁挡在整个路由树之前：未答对时连页面 chunk 都不加载，
    也就不会触发任何会消耗供应商 token 的请求。 */
function AppRoot() {
  const [unlocked, setUnlocked] = useState(hasPassedAccessGate);
  if (!unlocked) return <AccessGatePage onUnlock={() => setUnlocked(true)} />;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
