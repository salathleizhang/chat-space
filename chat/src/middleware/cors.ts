import { cors } from "hono/cors";
import { config } from "../config";

export const corsMiddleware = cors({
  origin: (origin) => (config.cors.isAllowedOrigin(origin) ? origin : null),
  // 写操作不止 POST：会话落盘是 PUT、删除资产是 DELETE，漏一个浏览器就在预检阶段
  // 拦掉，前端只看得到 "Failed to fetch"（被翻译成"无法连接 chat 服务"），很误导
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  exposeHeaders: ["Content-Disposition"],
});
