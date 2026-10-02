/**
 * `.spz` 产物格式：**入库时统一转成 v4**。
 *
 * ### 为什么必须转
 * World Labs 下发的 `.spz` 是 **legacy**（v2/v3：整段 gzip，文件头就是 `1f 8b`），而 PlayCanvas
 * 引擎的 SPZ 解析器**只认 v4**（`playcanvas/scripts/esm/parsers/spz-parser.mjs:431-443`：读出
 * offset 4 的版本号，v1–3 直接抛 "legacy gzip based version, only version 4 is supported"）。
 * three 侧（`gaussian-splat-lite`）两种都能读（它的 CHANGELOG 明写"Validated legacy SPZ gzip
 * header… Validated SPZ v4 Zstandard checksums"），所以**换成 v4 对两边都是合法的**，
 * 不需要为两套渲染层各存一份产物。
 *
 * 不转的后果是实测过的：真实项目里 PC 分支的控制台稳定报
 * `No parser found for resource: …/0-world-full-res.spz`，房间/背景整块不渲染。
 *
 * ### 工具是**可选**依赖
 * 转换用官方的 `@playcanvas/splat-transform`（库形态：`readFile` → `writeSource`，
 * `options.spzVersion` 默认 4）。它没装时**保留原文件并如实告警**——资产不能因为少一个工具就丢；
 * 同时 `scripts/spz-to-v4.ts` 可以把历史项目补转（离线时用 `SPLAT_TRANSFORM_PATH` 指向本地副本）。
 *
 * ### 纯逻辑与引擎无关
 * `isSpzV4` / `ensureSpzV4` 不 import 任何东西（转换器按需动态载入、可注入），所以能在没有 GPU、
 * 也没装工具的测试环境里覆盖。
 */

/** v4 的文件头魔数（小端读作 0x5053474e，字节是 "NGSP"）。 */
export const SPZ_V4_MAGIC = 0x5053474e;
/** 引擎唯一接受的版本号。 */
export const SPZ_V4_VERSION = 4;
/** legacy v2/v3 是整段 gzip，所以文件头就是 gzip 魔数。 */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** 是不是引擎认的 SPZ v4（只看 32 字节头里的魔数与版本号）。 */
export function isSpzV4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === SPZ_V4_MAGIC && view.getUint32(4, true) === SPZ_V4_VERSION;
}

/** 是不是 legacy（v2/v3）SPZ——它们的文件头是 gzip 魔数 `1f 8b`。 */
export function isLegacyGzipSpz(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

/** 转换器：把 legacy SPZ 变成 v4 SPZ。真实实现包着 `@playcanvas/splat-transform`。 */
export interface SpzConverter {
  toV4(bytes: Uint8Array): Promise<Uint8Array>;
}

/** 一次"确保 v4"的结果。`bytes` 永远是**可以落盘的**字节（转不了就是原来那份）。 */
export interface SpzConversion {
  bytes: Uint8Array;
  converted: boolean;
  /** `null` = 无需转换或转换成功；否则是"为什么保留原样"的机器可读原因。 */
  reason: string | null;
}

/**
 * 载入转换器。`modulePath` 默认是包名（从调用方所在位置解析）；离线/本地验证时可以传一份
 * 已装副本的路径（`scripts/spz-to-v4.ts` 的 `--tool` 与 `SPLAT_TRANSFORM_PATH` 就是这条）。
 * **任何失败都返回 `null`**，不抛——调用方要能在没有工具的情况下继续跑。
 */
export async function loadSpzConverter(modulePath = "@playcanvas/splat-transform"): Promise<SpzConverter | null> {
  let mod: unknown;
  try {
    // 变量式 import：这样包没装时是**运行时**失败（可降级），而不是类型检查期就红。
    mod = await import(/* @vite-ignore */ modulePath);
  } catch (error) {
    warnOnce(`没装 splat 转换器（${modulePath}）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const api = mod as Partial<Record<string, unknown>>;
  const required = [
    "readFile", "getInputFormat", "writeSource",
    "createChunkDataPool", "MemoryReadFileSystem", "MemoryFileSystem",
  ];
  const missing = required.filter((name) => typeof api[name] !== "function");
  if (missing.length > 0) {
    warnOnce(`splat 转换器接口不完整（缺 ${missing.join(", ")}）`);
    return null;
  }

  type Lib = {
    readFile(o: unknown): Promise<{ close?(): void }[]>;
    getInputFormat(name: string): string;
    writeSource(o: unknown, fs: unknown): Promise<void>;
    createChunkDataPool(o?: unknown): { destroy?(): void };
    MemoryReadFileSystem: new () => { set(name: string, data: Uint8Array): void };
    MemoryFileSystem: new () => { results: Map<string, Uint8Array> };
  };
  const lib = api as unknown as Lib;

  return {
    async toV4(bytes) {
      const input = "in.spz";
      const output = "out.spz";
      const pool = lib.createChunkDataPool({ chunkSize: 1 << 20 });
      let sources: { close?(): void }[] = [];
      try {
        const readFs = new lib.MemoryReadFileSystem();
        readFs.set(input, bytes);
        sources = await lib.readFile({
          filename: input,
          inputFormat: lib.getInputFormat(input),
          fileSystem: readFs,
        });
        const source = sources[0];
        if (!source) throw new Error("splat-transform 没有读出任一 source");
        const writeFs = new lib.MemoryFileSystem();
        // `spzVersion` 默认就是 4，这里显式写下来——引擎只认 4，不要依赖默认值。
        await lib.writeSource(
          { filename: output, outputFormat: "spz", source, pool, options: { spzVersion: SPZ_V4_VERSION } },
          writeFs,
        );
        const out = writeFs.results.get(output);
        if (!out) throw new Error("splat-transform 没有产出 out.spz");
        return out;
      } finally {
        for (const source of sources) source.close?.();
        pool.destroy?.();
      }
    },
  };
}

/**
 * 确保给定的 `.spz` 字节是 v4：
 * - 已经是 v4 → 原样返回（**不**载入转换器）；
 * - 是 legacy gzip → 试着转；转不了（没装工具 / 抛错 / 产物不是 v4）→ **保留原样**并给出 reason；
 * - 两种都不是 → 原样返回，reason 说明不认识的魔数（不猜、不动它）。
 *
 * `converter` 传 `null` 表示"明确没有转换器"；不传则按需载入。
 */
export async function ensureSpzV4(
  bytes: Uint8Array,
  converter?: SpzConverter | null,
): Promise<SpzConversion> {
  if (isSpzV4(bytes)) return { bytes, converted: false, reason: null };
  if (!isLegacyGzipSpz(bytes)) {
    return { bytes, converted: false, reason: "unrecognised-spz-header" };
  }
  const tool = converter === undefined ? await loadSpzConverter() : converter;
  if (!tool) return { bytes, converted: false, reason: "converter-unavailable" };
  try {
    const converted = await tool.toV4(bytes);
    if (!isSpzV4(converted)) return { bytes, converted: false, reason: "converted-not-v4" };
    return { bytes: converted, converted: true, reason: null };
  } catch (error) {
    return { bytes, converted: false, reason: `convert-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 同一件事一个进程只喊一次（世界资产有 4 个 spz 变体，逐件喊会刷屏）。 */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[spz] ${message}`);
}
