import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Blender 实时画面的反向代理目标。
 *
 * ## 为什么必须走代理，而不是直接 iframe 嵌 KasmVNC
 *
 * 实测 KasmVNC（`https://127.0.0.1:16901`）的三个特性，任何一个都会让直接嵌失败：
 *
 *   1. **自签证书** → 浏览器拒绝把它作为 iframe 加载（除非先手动访问一次点「继续」）
 *   2. **HTTP Basic 鉴权**（`WWW-Authenticate: Basic realm="Websockify"`）→
 *      iframe 的 URL **不能**带 `user:pass@`（浏览器会剥掉），于是会弹一个原生登录框
 *   3. **跨源 + `Cross-Origin-Embedder-Policy: require-corp`** → 跨源嵌入的额外约束
 *
 * 代理一次解决三个：证书校验在 Node 侧关掉（`secure: false`）、Basic 凭据由代理注入
 * （浏览器永远看不到）、而代理与页面**同源**（都在 5173）→ iframe 是同源，
 * COEP / 跨源问题整个消失。
 *
 * ## 好消息
 *
 * KasmVNC **没有** `X-Frame-Options`、也没有 `frame-ancestors` —— 它本身不禁止被嵌，
 * 所以只要把上面三条顺平，iframe 就能用。
 *
 * 环境变量：`BLENDER_LIVE_TARGET` / `BLENDER_LIVE_USER` / `BLENDER_LIVE_PASS`。
 * 注意这台机器上容器是用 16901 起的（手动 `docker run`）；`docker compose up` 起的
 * 话是 6901。换端口只改这一个变量。
 */
const BLENDER_LIVE_TARGET = process.env.BLENDER_LIVE_TARGET ?? "https://127.0.0.1:16901";
const BLENDER_LIVE_USER = process.env.BLENDER_LIVE_USER ?? "kasm_user";
const BLENDER_LIVE_PASS = process.env.BLENDER_LIVE_PASS ?? "chatspace";
const BLENDER_LIVE_AUTH = `Basic ${Buffer.from(
  `${BLENDER_LIVE_USER}:${BLENDER_LIVE_PASS}`,
).toString("base64")}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      // 前端请求 `/blender-live/*`，代理剥掉前缀转给 KasmVNC 的 `/*`。
      "/blender-live": {
        target: BLENDER_LIVE_TARGET,
        // 自签证书：不在这一层校验。这是本机开发代理，不是生产边界。
        secure: false,
        // KasmVNC 的画面走 WebSocket，不转发它就只有一张空壳页面。
        ws: true,
        changeOrigin: true,
        headers: { Authorization: BLENDER_LIVE_AUTH },
        rewrite: (path) => path.replace(/^\/blender-live/, ""),
        // 连不上时打一条**能照着做**的日志，而不是留一个空白 iframe 让人猜。
        configure: (proxy) => {
          proxy.on("error", (err) => {
            console.warn(
              `[blender-live] 代理到 ${BLENDER_LIVE_TARGET} 失败：${err.message}\n` +
                "  · 容器在跑吗：docker ps | grep blender\n" +
                "  · 端口对吗：BLENDER_LIVE_TARGET（compose 起的是 6901，手动 run 的可能是别的）",
            );
          });
        },
      },
    },
  },
  // Three.js 与 Splat 已按路由/功能懒加载；默认 500 kB 阈值对 3D 编辑器没有信号价值。
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        // three（含 three/addons/* 子路径）被视口与 SplatModel 两个懒加载 chunk 各自
        // 引用，rollup 默认会各打一份：运行时加载两份 three（触发 window.__THREE__ 的
        // “Multiple instances” 告警）并多出约 600KB。这里把 three 及其 addons 强制
        // 收敛成一个共享 chunk，两个消费方都只引用这一份。
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
});
