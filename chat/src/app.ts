import { Hono } from "hono";
import { config } from "./config";
import { corsMiddleware } from "./middleware/cors";
import { errorHandler } from "./middleware/error";
import { capabilityRoutes } from "./routes/capabilities";
import { blenderRoutes } from "./routes/blender";
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
    const sameOriginCloud = process.env.VERCEL === "1" && origin === new URL(c.req.url).origin;
    if (origin && !sameOriginCloud && !config.cors.isAllowedOrigin(origin)) {
      return c.json({ error: { message: "This web page is not allowed to access the local ChatSpace service" } }, 403);
    }
    await next();
  });
  app.use("*", corsMiddleware);
  app.onError(errorHandler);

  app.get("/health", (c) => c.json({ ok: true, service: "chatspace-chat" }));
  app.route("/capabilities", capabilityRoutes);
  app.route("/blender", blenderRoutes);
  app.route("/chat", chatRoutes);
  app.route("/projects", projectRoutes);
  app.route("/tasks", taskRoutes);
  app.route("/library", libraryRoutes);
  app.route("/sessions", sessionRoutes);

  return app;
}
