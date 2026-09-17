# chat

Gabo 的本机 Hono/Mastra 服务，也是资产与会话的唯一读写者。

```bash
bun run dev
bun run start
bun test
```

默认仅在 `127.0.0.1:3901` 监听，资产写入 `~/Gabo`；可用 `CHAT_PORT`、`GABO_LIBRARY_DIR` 覆盖。Cloudflare Pages 的完整站点 origin 通过 `GABO_WEB_ORIGINS` 配置，多个用逗号分隔。供应商 key 见 `.env.example`。
