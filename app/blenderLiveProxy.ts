import tls from "node:tls";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

/**
 * 把 KasmVNC 的界面**同源**代理进 Vite dev server。
 *
 * ## 为什么自己写，而不用 `server.proxy`
 *
 * 实测 `server.proxy` 在这个场景下**不够用**，而且是两处不同的坑：
 *
 *   1. **`headers: { Authorization }` 不作用于 WebSocket**。它只加在普通 HTTP 请求上；
 *      WS 走 `upgrade` 事件、由 http-proxy 的另一条路径发出。KasmVNC 对 `/websockify`
 *      同样要 Basic 鉴权 → 升级被 401 拒掉。**症状极具误导性**：页面能加载（HTTP 200）、
 *      然后永远停在 KasmVNC 的「Connecting…」，看起来像"再等等就好"。
 *   2. 补了 `proxyReqWs` 挂头之后**仍然** `Expected 101`。剩下还有"重写规则对 WS 生不生效"、
 *      "Vite 自己的 HMR upgrade 监听会不会把请求接走"等好几个未知——继续跟 http-proxy
 *      的行为猜谜，不如自己把两条路写死。
 *
 * 自己接管之后，HTTP 与 WS 两条路的**路径、头、TLS 策略都是明写的**，没有隐式行为。
 *
 * ## 为什么必须走代理（而不是直接 iframe 嵌 16901）
 *
 * KasmVNC 是**自签证书 + HTTP Basic + 跨源**，三者任一都会让直接嵌失败：
 * 浏览器拒绝加载自签证书的 iframe、iframe URL 里的 `user:pass@` 会被剥掉、
 * 还有 `Cross-Origin-Embedder-Policy: require-corp` 的跨源约束。
 * 代理把这三条一次顺平，而且让 iframe 与页面**同源**。
 * （好消息：KasmVNC 没有 `X-Frame-Options`、也没有 `frame-ancestors`，它本身不禁止被嵌。）
 */

export interface BlenderLiveProxyOptions {
  /** 挂载前缀，默认 `/blender-live` */
  prefix?: string;
  /** KasmVNC 的地址，如 `https://127.0.0.1:16901` */
  target: string;
  user: string;
  pass: string;
}

/** 把 `/blender-live/foo` 还原成上游要的 `/foo`。 */
export function upstreamPath(prefix: string, url: string | undefined): string {
  const raw = url ?? "/";
  const withoutPrefix = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  // 空串和裸 `/` 都要落到 `/`，否则上游会拿到空请求行。
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

export function blenderLiveProxy(options: BlenderLiveProxyOptions): Plugin {
  const prefix = options.prefix ?? "/blender-live";
  const upstream = new URL(options.target);
  const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
  const host = upstream.hostname;
  const auth = `Basic ${Buffer.from(`${options.user}:${options.pass}`).toString("base64")}`;

  const fail = (what: string, message: string) =>
    console.warn(
      `[blender-live] ${what} 失败：${message}\n` +
        "  · 容器在跑吗：docker ps | grep blender\n" +
        `  · 地址对吗：${options.target}（compose 起的是 6901，手动 run 的可能是别的）`,
    );

  return {
    name: "blender-live-proxy",
    configureServer(server) {
      // ── ① 普通 HTTP ────────────────────────────────────────────────────
      // 放在 Vite 自己的中间件之前，避免被 HTML fallback 接走（那样 iframe 会拿到
      // index.html，表现为一张空白页——这个仓库在 PlayCanvas 那边踩过同样的坑）。
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const proxyReq = https.request({
          hostname: host,
          port,
          path: upstreamPath(prefix, req.url),
          method: req.method,
          // 自签证书：这是本机开发代理，上游证书不由它背书。
          rejectUnauthorized: false,
          headers: { ...req.headers, host: `${host}:${port}`, authorization: auth },
        });
        proxyReq.on("response", (proxyRes: IncomingMessage) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on("error", (err: Error) => {
          fail("HTTP 代理", err.message);
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end(`blender-live proxy error: ${err.message}`);
        });
        req.pipe(proxyReq);
      });

      // ── ② WebSocket 升级 ──────────────────────────────────────────────
      // 只认自己的前缀；别的一律不碰，交给 Vite 自己的 HMR 监听。
      const httpServer = server.httpServer;
      if (!httpServer) return;
      httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!req.url?.startsWith(prefix)) return;

        // 升级请求要手写：http-proxy 那条路我们不再走了，所以
        // `Sec-WebSocket-*` 这几个头必须原样带过去，否则上游不认这是 WS。
        const lines = [
          `GET ${upstreamPath(prefix, req.url)} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] ?? ""}`,
          `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}`,
          `Authorization: ${auth}`,
        ];
        const protocol = req.headers["sec-websocket-protocol"];
        if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
        if (req.headers.origin) lines.push(`Origin: ${req.headers.origin}`);

        /*
          ⚠️ **`servername` 只在 host 是主机名时才能给。** 实测踩到过：
          这里原本写 `servername: host`，而目标通常是 `127.0.0.1`（一个 IP），
          Node 直接抛 `ERR_INVALID_ARG_VALUE: Setting the TLS ServerName to an IP
          address is not permitted` **并拒绝建立连接** —— 于是升级永远不发生，
          浏览器侧只看到 `Expected 101 status code`，完全看不出是 TLS 参数的问题。
          SNI 对 IP 目标本来也没有意义（带外信息、KasmVNC 也不用它选证书）。
        */
        const tlsOptions: tls.ConnectionOptions = { host, port, rejectUnauthorized: false };
        if (!/^[\d.]+$/.test(host) && !host.includes(":")) tlsOptions.servername = host;
        const upstreamSocket = tls.connect(
          tlsOptions,
          () => {
            upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head?.length) upstreamSocket.write(head);
          },
        );

        // 双向 pipe：升级成功后这就是一条裸字节通道，两边都不再解析 HTTP。
        upstreamSocket.on("error", (err: Error) => {
          fail("WS 代理", err.message);
          socket.destroy();
        });
        socket.on("error", () => upstreamSocket.destroy());
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
    },
  };
}
