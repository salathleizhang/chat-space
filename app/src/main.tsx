import { lazy, StrictMode, Suspense } from "react";
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

const LocalStorageNotice = lazy(() => import("./browser/LocalStorageNotice").then(module => ({ default: module.LocalStorageNotice })));

function AppRoot() {
  return <><RouterProvider router={router} />{import.meta.env.VITE_BROWSER_LOCAL === "1" && <Suspense fallback={null}><LocalStorageNotice /></Suspense>}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
