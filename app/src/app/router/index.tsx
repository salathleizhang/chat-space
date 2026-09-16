import { createBrowserRouter, Navigate } from "react-router-dom";

const hydrateFallbackElement = (
  <div className="flex h-full w-full items-center justify-center bg-canvas text-sm text-ink-subtle">
    正在加载…
  </div>
);

/** AppDashboard chunk 带 Three.js/R3F/drei，是全站最重的一块；
    ProjectHubPage 在项目卡片 hover/focus 时调用它提前起 fetch，
    真正点击导航时命中 import() 的模块缓存，无需二次请求。 */
export const preloadAppDashboard = () => import("../../pages/AppDashboard");

/** 路由级代码分割：Three.js/Spark 只随单项目工作台加载，入口页保持轻量 */
export const router = createBrowserRouter([
  {
    path: "/app",
    hydrateFallbackElement,
    lazy: async () => ({
      Component: (await import("../../pages/ProjectHubPage")).ProjectHubPage,
    }),
  },
  {
    path: "/app/:projectSlug",
    hydrateFallbackElement,
    lazy: async () => ({
      Component: (await preloadAppDashboard()).AppDashboard,
    }),
  },
  /** 根路径与未匹配路径一律落回项目入口 */
  {
    path: "*",
    element: <Navigate to="/app" replace />,
  },
]);
