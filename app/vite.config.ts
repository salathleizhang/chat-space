import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
  },
  // Three.js 与 Spark 已按路由/功能懒加载；默认 500 kB 阈值对 3D 编辑器没有信号价值。
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
