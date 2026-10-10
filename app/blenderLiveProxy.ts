import tls from "node:tls";
import net from "node:net";
import https from "node:https";
import http from "node:http";
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
  /** 火山统一域名：HTTP 和 WebSocket 都必须路由到同一个实例。 */
  instanceName?: string;
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
  if (upstream.username || upstream.password) throw new Error("Use proxy credential options, not URL credentials");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname);
  if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && loopback)) {
    throw new Error("Cloud desktop target must use HTTPS; HTTP is allowed only on loopback");
  }
  if (options.instanceName && /[\r\n]/.test(options.instanceName)) throw new Error("Invalid sandbox instance name");
  const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
  const host = upstream.hostname;
  const auth = `Basic ${Buffer.from(`${options.user}:${options.pass}`).toString("base64")}`;
  const routing = options.instanceName ? { "x-faas-instance-name": options.instanceName } : {};
  const isHttps = upstream.protocol === "https:";

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
        const bare = req.url?.split("?")[0];
        if (bare !== prefix && !bare?.startsWith(`${prefix}/`)) return next();
        if (bare === `${prefix}/connection`) {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ transport: options.instanceName ? "cloud" : "local", instanceName: options.instanceName ?? null }));
          return;
        }
        const proxyReq = (isHttps ? https : http).request({
          hostname: host,
          port,
          path: upstreamPath(prefix, req.url),
          method: req.method,
          // 仅本机 Kasm 允许自签；云端必须验证服务端证书。
          rejectUnauthorized: !loopback,
          headers: { ...req.headers, host: upstream.host, authorization: auth, ...routing },
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
      // 只认 KasmVNC 那一条路径；别的一律不碰，交给 Vite 自己的 HMR 监听。
      const httpServer = server.httpServer;
      if (!httpServer) return;
      httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        /*
          **WS 在 `/websockify`，而且落在根上——不在我们的前缀底下。**

          这一条此前被记错过（上一版注释断言"在根路径 `/`，`/websockify` 只是个遗留的
          noVNC 设置项"）。**那个结论是错的**，依据是三条实测：

            ① 浏览器侧（CDP 的 `Network.webSocketCreated`）打的是
               `ws://127.0.0.1:5173/websockify`，子协议 `binary`，**握手没有响应**；
            ② 容器自己日志说得很直白：
               `websocket 55: /websockify request failed websocket checks,
                missing Sec-WebSocket-Origin header` → `"GET /websockify" 404 180`
               —— 也就是说这个路由**存在**，404 是"缺 Origin 头"造成的，不是"没有这个路由"；
            ③ 直接对上游补上 `Origin` 再打 `/websockify` → **101 Switching Protocols**，
               回 `Sec-WebSocket-Protocol: binary`。

          为什么落在**根**上而不是 `/blender-live/`：noVNC 是从 `location.host` + 它自己的
          `path` 设置（值就是 `websockify`，**不是遗留项，它真的在用**）拼 URL 的，
          **不带我们代理的前缀**。所以页面可以在 `/blender-live/` 下，socket 却在根上。

          子协议那条排除留着：Vite 自己的 HMR 一定带 `vite-hmr`，用它可以明确让开。
        */
        const protocol = String(req.headers["sec-websocket-protocol"] ?? "");
        if (protocol.includes("vite-hmr")) return; // Vite 自己的热更新，不碰
        const bare = (req.url ?? "/").split("?")[0] ?? "/";
        const isOurs =
          bare === `${prefix}/websockify` || // 带上前缀的情况（后端换写法时兜底）
          bare === "/websockify" || // ← 实测就是这条
          (bare !== "/" && bare.startsWith(`${prefix}/`));
        if (!isOurs) return;

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
        if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
        if (req.headers.origin) lines.push(`Origin: ${req.headers.origin}`);
        if (options.instanceName) lines.push(`x-faas-instance-name: ${options.instanceName}`);

        /*
          ⚠️ **`servername` 只在 host 是主机名时才能给。** 实测踩到过：
          这里原本写 `servername: host`，而目标通常是 `127.0.0.1`（一个 IP），
          Node 直接抛 `ERR_INVALID_ARG_VALUE: Setting the TLS ServerName to an IP
          address is not permitted` **并拒绝建立连接** —— 于是升级永远不发生，
          浏览器侧只看到 `Expected 101 status code`，完全看不出是 TLS 参数的问题。
          SNI 对 IP 目标本来也没有意义（带外信息、KasmVNC 也不用它选证书）。
        */
        const tlsOptions: tls.ConnectionOptions = { host, port, rejectUnauthorized: !loopback };
        if (!net.isIP(host)) tlsOptions.servername = host;
        // 不记录握手头：Authorization 中含完整凭证。
        const connected = () => {
            upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head?.length) upstreamSocket.write(head);
        };
        const upstreamSocket = isHttps
          ? tls.connect(tlsOptions, connected)
          : net.connect({ host, port }, connected);

        // 双向 pipe：升级成功后这就是一条裸字节通道，两边都不再解析 HTTP。
        upstreamSocket.on("error", (err: Error) => {
          fail("WS 代理", err.message);
          socket.destroy();
        });
        socket.on("error", () => upstreamSocket.destroy());
        socket.on("close", () => upstreamSocket.destroy());
        upstreamSocket.on("close", () => socket.destroy());
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
    },
  };
}
