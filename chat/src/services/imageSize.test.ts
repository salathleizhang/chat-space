import { describe, expect, test } from "bun:test";
import { FALLBACK_IMAGE_ASPECT, imageAspect, readImageSize } from "./imageSize";

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** 最小 JPEG：SOI + [APP1/EXIF] + SOF0 + EOI。 */
function jpegBytes(
  width: number,
  height: number,
  orientation?: number,
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    // Exif\0\0 + TIFF(II, 42, IFD0@8) + 1 条目（0x0112 SHORT 1 = orientation）+ 下个 IFD 偏移
    const payload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ];
    const length = payload.length + 2;
    parts.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  parts.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  bytes[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >> 8) & 0xff;
  bytes[23] = (bits >> 16) & 0xff;
  bytes[24] = (bits >> 24) & 0xff;
  return bytes;
}

describe("readImageSize", () => {
  test("PNG 读 IHDR 的宽高", () => {
    expect(readImageSize(pngBytes(1200, 800))).toEqual({ width: 1200, height: 800 });
  });

  test("JPEG 读 SOF0 的宽高", () => {
    expect(readImageSize(jpegBytes(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  test("JPEG 的 EXIF 方向 6 表示旋转 90°：宽高要对调", () => {
    // 浏览器显示时会把这张"存储为 4032×3024 + 方向 6"的照片竖过来。
    expect(readImageSize(jpegBytes(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 });
    expect(readImageSize(jpegBytes(4032, 3024, 1))).toEqual({ width: 4032, height: 3024 });
  });

  test("WebP 的 VP8X / VP8L 两种头都认", () => {
    expect(readImageSize(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageSize(webpVp8l(640, 480))).toEqual({ width: 640, height: 480 });
  });

  test("截断或伪造的字节不抛错，只给 null", () => {
    // 测试夹具里的"源图"就是四字节 PNG 魔数，摆放必须能继续跑。
    expect(readImageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0]))).toBeNull();
  });

  test("imageAspect：读得到就用真实比例，读不到退回 4:3", () => {
    expect(imageAspect({ width: 1200, height: 800 })).toBeCloseTo(1.5, 5);
    expect(imageAspect(null)).toBe(FALLBACK_IMAGE_ASPECT);
    expect(imageAspect({ width: 0, height: 800 })).toBe(FALLBACK_IMAGE_ASPECT);
  });
});
