import { Hono } from "hono";
import { configuredEnvLlmProviders, configuredProviders } from "../config";

export const capabilityRoutes = new Hono();

/**
 * env 只存在于 chat 进程；浏览器要筛选已激活模型，只需要知道厂商 id。
 * 这个接口刻意不返回 Key、长度、前后缀或任何可用于猜测密钥的信息。
 */
capabilityRoutes.get("/", (c) =>
  c.json({ llmProviders: configuredEnvLlmProviders, providers: configuredProviders }),
);
