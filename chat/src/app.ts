import { Hono } from "hono";
import { config } from "./config";
import { corsMiddleware } from "./middleware/cors";
import { errorHandler } from "./middleware/error";
import { capabilityRoutes } from "./routes/capabilities";
import { chatRoutes } from "./routes/chat";
import { libraryRoutes } from "./routes/library";
import { projectRoutes } from "./routes/projects";
import { sessionRoutes } from "./routes/sessions";
import { taskRoutes } from "./routes/tasks";

/** Hono app 装配（与启动分离，便于测试直接调用 app.request） */
export function createApp(): Hono {
  const app = new Hono().basePath("/api");

  // CORS 只控制浏览器读取响应；服务端也要拒绝不受信任页面发出的写请求。
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !config.cors.isAllowedOrigin(origin)) {
      return c.json({ error: { message: "不允许此网页访问本机 Gabo 服务" } }, 403);
    }
    await next();
  });
  app.use("*", corsMiddleware);
  app.onError(errorHandler);

  app.get("/health", (c) => c.json({ ok: true, service: "gabo-chat" }));
  app.route("/capabilities", capabilityRoutes);
  app.route("/chat", chatRoutes);
  app.route("/projects", projectRoutes);
  app.route("/tasks", taskRoutes);
  app.route("/library", libraryRoutes);
  app.route("/sessions", sessionRoutes);

  return app;
}
