# chat

ChatSpace 的本机 Hono/Mastra 服务，也是资产与会话的唯一读写者。

```bash
bun run dev
bun run start
bun test
```

默认仅在 `127.0.0.1:3901` 监听，资产写入 `~/ChatSpace`。可用 `CHAT_PORT`、`CHATSPACE_LIBRARY_DIR` 覆盖。Cloudflare Pages 的完整站点 origin 通过 `CHATSPACE_WEB_ORIGINS` 配置，多个用逗号分隔。供应商 key 见 `.env.example`。

云端运行可设置 `CHAT_HOST=0.0.0.0`，未设置 `CHAT_PORT` 时会使用平台的 `PORT`。需要挂载持久化工程目录并配置实际网页的 `CHATSPACE_WEB_ORIGINS`。Vercel 浏览器本地版与独立后端的配置见 [../deploy/README.md](../deploy/README.md)。
