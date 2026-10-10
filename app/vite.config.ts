import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { blenderLiveProxy } from "./blenderLiveProxy";

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
 * 代理一次解决三个：仅本机目标允许自签证书、Basic 凭据由代理注入
 * （浏览器永远看不到）、而代理与页面**同源**（都在 5173）→ iframe 是同源，
 * COEP / 跨源问题整个消失。
 *
 * ## 好消息
 *
 * KasmVNC **没有** `X-Frame-Options`、也没有 `frame-ancestors` —— 它本身不禁止被嵌，
 * 所以只要把上面三条顺平，iframe 就能用。
 *
 * 环境变量：`BLENDER_LIVE_TARGET` / `BLENDER_LIVE_USER` / `BLENDER_LIVE_PASS`
 * / `BLENDER_LIVE_INSTANCE_NAME`（火山统一域名下的测试实例名）。
 * 注意这台机器上容器是用 16901 起的（手动 `docker run`）；`docker compose up` 起的
 * 话是 6901。换端口只改这一个变量。
 */
const BLENDER_LIVE_TARGET = process.env.BLENDER_LIVE_TARGET ?? "https://127.0.0.1:16901";
const BLENDER_LIVE_USER = process.env.BLENDER_LIVE_USER ?? "kasm_user";
const BLENDER_LIVE_PASS = process.env.BLENDER_LIVE_PASS ?? "chatspace";

export default defineConfig({
  // 本地迁入的库位于 app 之外，统一从宿主解析固定版本的 peer，避免重复 Three 实例。
  resolve: {
    dedupe: ["three", "@mediapipe/tasks-vision"],
  },
  plugins: [
    react(),
    tailwindcss(),
    blenderLiveProxy({
      target: BLENDER_LIVE_TARGET,
      user: BLENDER_LIVE_USER,
      pass: BLENDER_LIVE_PASS,
      instanceName: process.env.BLENDER_LIVE_INSTANCE_NAME,
    }),
  ],
  server: {
    host: "127.0.0.1",
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
