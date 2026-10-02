import { describe, expect, test } from "bun:test";
import {
  ensureSpzV4,
  isLegacyGzipSpz,
  isSpzV4,
  loadSpzConverter,
  SPZ_V4_MAGIC,
  type SpzConverter,
} from "./spz";

/** 造一个能过 `isSpzV4` 的 32 字节头（点数写 7，方便断言"原样返回"时没被改过）。 */
function v4Bytes(numPoints = 7): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SPZ_V4_MAGIC, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, numPoints, true);
  return bytes;
}

/** legacy：整段 gzip，所以头两个字节就是 gzip 魔数。 */
function legacyBytes(payload = 16): Uint8Array {
  const bytes = new Uint8Array(2 + payload);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  return bytes;
}

describe("SPZ 头判定", () => {
  test("v4：魔数 NGSP + 版本号 4 才算", () => {
    expect(isSpzV4(v4Bytes())).toBe(true);
    const wrongVersion = v4Bytes();
    new DataView(wrongVersion.buffer).setUint32(4, 3, true);
    expect(isSpzV4(wrongVersion)).toBe(false);
    const wrongMagic = v4Bytes();
    new DataView(wrongMagic.buffer).setUint32(0, 0x12345678, true);
    expect(isSpzV4(wrongMagic)).toBe(false);
  });

  test("太短的字节既不判 v4 也不判 legacy（不许越界读）", () => {
    expect(isSpzV4(new Uint8Array(0))).toBe(false);
    expect(isSpzV4(new Uint8Array(7))).toBe(false);
    expect(isLegacyGzipSpz(new Uint8Array(1))).toBe(false);
  });

  test("legacy：gzip 魔数 1f 8b", () => {
    expect(isLegacyGzipSpz(legacyBytes())).toBe(true);
    expect(isLegacyGzipSpz(v4Bytes())).toBe(false);
  });
});

describe("ensureSpzV4", () => {
  test("已经是 v4 就原样返回，**不**惊动转换器", async () => {
    let called = 0;
    const converter: SpzConverter = { async toV4(bytes) { called += 1; return bytes; } };
    const input = v4Bytes(11);
    const result = await ensureSpzV4(input, converter);
    expect(result.converted).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.bytes).toBe(input);
    expect(called).toBe(0);
  });

  test("legacy 转换成功：返回 v4 字节且 converted=true", async () => {
    const output = v4Bytes(98304);
    const converter: SpzConverter = { async toV4() { return output; } };
    const result = await ensureSpzV4(legacyBytes(), converter);
    expect(result.converted).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bytes).toBe(output);
  });

  test("**没有转换器时保留原文件**（资产不能因为缺工具而丢）", async () => {
    const input = legacyBytes();
    const result = await ensureSpzV4(input, null);
    expect(result.converted).toBe(false);
    expect(result.reason).toBe("converter-unavailable");
    expect(result.bytes).toBe(input);
  });

  test("转换器抛错时保留原文件，reason 带原始错误", async () => {
    const input = legacyBytes();
    const converter: SpzConverter = { async toV4() { throw new Error("boom"); } };
    const result = await ensureSpzV4(input, converter);
    expect(result.converted).toBe(false);
    expect(result.reason).toContain("convert-failed");
    expect(result.reason).toContain("boom");
    expect(result.bytes).toBe(input);
  });

  test("转换器给出非 v4 的产物时**不落盘**（宁可留 legacy，也不写坏文件）", async () => {
    const input = legacyBytes();
    const converter: SpzConverter = { async toV4() { return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); } };
    const result = await ensureSpzV4(input, converter);
    expect(result.converted).toBe(false);
    expect(result.reason).toBe("converted-not-v4");
    expect(result.bytes).toBe(input);
  });

  test("既不认识魔数又不是 gzip：不猜、不动它", async () => {
    const input = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0, 0, 0, 0]);
    const result = await ensureSpzV4(input, null);
    expect(result.converted).toBe(false);
    expect(result.reason).toBe("unrecognised-spz-header");
    expect(result.bytes).toBe(input);
  });
});

describe("loadSpzConverter", () => {
  test("包（或给定路径）不存在时返回 null，不抛", async () => {
    // 真实场景：平台侧还没 `bun install` 这个可选依赖
    await expect(loadSpzConverter("__definitely_missing_splat_transform__")).resolves.toBeNull();
  });
});
