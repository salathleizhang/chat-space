import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { config } from "./config";
import { createLocalFetch } from "./staticApp";

const app = createApp();
const fetch = createLocalFetch(
  (request) => app.fetch(request),
  fileURLToPath(new URL("../../app/dist", import.meta.url)),
);

console.log(`[chat] Chatspace listening on http://127.0.0.1:${config.port}/app`);

export default {
  hostname: "127.0.0.1",
  port: config.port,
  fetch,
  // SSE 长连接：放宽 Bun 默认 10s 空闲超时
  idleTimeout: 120,
};
