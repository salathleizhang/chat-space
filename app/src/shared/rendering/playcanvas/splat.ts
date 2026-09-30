/**
 * Gaussian splat 的加载接线。
 *
 * ### 两件必须自己带的东西（都在 npm 包**之外**，本机核实）
 *  1. **ZSTD 解码器**：`spz-parser.mjs:528-530` 硬性要求先
 *     `WasmModule.setConfig('ZstdDecoderModule', { glueUrl, wasmUrl })`，
 *     而这两个文件在 `examples/assets/wasm/zstd/` 下、**不在 npm 包的 `files` 白名单里**
 *     （白名单只有 `build/playcanvas*` / `scripts` / `README*.md`）。所以必须 vendor
 *     到本仓库 —— 见 `vendor/`。
 *  2. **SPZ 解析器本体**：`gsplat` handler 内置只有 `.ply` / `.sog` / `lod-meta.json`，
 *     SPZ 要 `app.loader.getHandler('gsplat').addParser(new SpzParser(app))`。
 *
 * ### 资产必须是 SPZ **v4**
 * 解析器只认 version 4（`spz-parser.mjs:431-443`：读出 offset 4 的版本号，v1–3 直接抛
 * "legacy gzip based version, only version 4 is supported"）。本项目现有的四份 `.spz`
 * 全是 legacy（头部魔数 `1f8b` = gzip）。转换用 `@playcanvas/splat-transform`，
 * 见 `PLAYCANVAS_MIGRATION.md` §二.3。
 *
 * ### glTF 里的 splat
 * GLB 的 `KHR_gaussian_splatting` 扩展由引擎在 `GSplatComponentSystem` 初始化时注册，
 * 不需要额外接线（`components/gsplat/system.js:167-171`）。
 */

// Vite 的 `?url` 让这两个文件走资源管线：dev 下拿源码路径，build 下产出带哈希的资源，
// 而不是被当成模块打进来（胶水是 IIFE，不是 ESM）。
import zstdGlueUrl from "./vendor/zstd.wasm.js?url";
import zstdWasmUrl from "./vendor/zstd.wasm.wasm?url";

export const ZSTD_DECODER = { glueUrl: zstdGlueUrl, wasmUrl: zstdWasmUrl } as const;

/** glTF / GLB 与容器不需要额外 parser；这里只装 SPZ。 */
export async function registerSplatParsers(app: unknown): Promise<void> {
  const { WasmModule } = await import("playcanvas");
  WasmModule.setConfig("ZstdDecoderModule", { ...ZSTD_DECODER });
  const { SpzParser } = await import("playcanvas/scripts/esm/parsers/spz-parser.mjs");
  const loader = (app as { loader: { getHandler(name: string): { addParser(parser: unknown): void } } }).loader;
  loader.getHandler("gsplat").addParser(new SpzParser(app as never));
}
