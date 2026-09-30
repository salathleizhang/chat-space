/**
 * 只读文件头拿图片像素尺寸与宽高比。
 *
 * 摆放需要宽高比：归一化 x 换算成真实横向视场时，横向焦距 = aspect × 竖直焦距，
 * 少了 aspect 横向位置会整体偏窄或偏宽（4:3 与 3:4 差 1.78 倍）。
 *
 * **任何一步读不出来都不能抛错。** 源图可能是任何东西（测试夹具就是四字节的 PNG
 * 魔数），摆放必须退化成 4:3 继续跑；宁可少一点精度，也不能让整个 placement 节点失败。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 读不出尺寸时的兜底宽高比（常见手机竖拍 4:3 的反面也是它，误差有界）。 */
export const FALLBACK_IMAGE_ASPECT = 4 / 3;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** EXIF 方向 5–8 表示图像被旋转了 90°，宽高要对调（浏览器显示时就是这么做的）。 */
const SWAPPED_ORIENTATIONS = new Set([5, 6, 7, 8]);

export function imageAspect(size: ImageSize | null): number {
  return size && size.width > 0 && size.height > 0
    ? size.width / size.height
    : FALLBACK_IMAGE_ASPECT;
}

export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  // 8 字节签名 + 4 字节长度/类型 + IHDR 的宽高
  if (bytes.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const data = view(bytes);
  const size = { width: data.getUint32(16), height: data.getUint32(20) };
  return size.width > 0 && size.height > 0 ? size : null;
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = view(bytes);
  let orientation: number | undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // 0xFF 填充与无载荷标记（RSTn / SOI / EOI）
    if (marker === 0xff || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    // 扫描数据开始后不再有 SOF，继续找没有意义
    if (marker === 0xda) break;
    const length = data.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker === 0xe1 && orientation === undefined) {
      orientation = exifOrientation(bytes.subarray(offset + 4, offset + 2 + length));
    }
    // SOF0–SOF15，去掉 DHT/JPG/DAC 三个非 SOF 的码位
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      const height = data.getUint16(offset + 5);
      const width = data.getUint16(offset + 7);
      if (width === 0 || height === 0) return null;
      return orientation !== undefined && SWAPPED_ORIENTATIONS.has(orientation)
        ? { width: height, height: width }
        : { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** 从 APP1 段里读 EXIF 方向（TIFF 头 + IFD0 的 0x0112）；解析不了就返回 undefined。 */
function exifOrientation(segment: Uint8Array): number | undefined {
  if (segment.length < 14) return undefined;
  if (String.fromCharCode(...segment.subarray(0, 6)) !== "Exif\0\0") return undefined;
  const tiff = segment.subarray(6);
  const data = view(tiff);
  const byteOrder = String.fromCharCode(tiff[0]!, tiff[1]!);
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return undefined;
  const ifdOffset = data.getUint32(4, little);
  if (ifdOffset + 2 > tiff.length) return undefined;
  const entries = data.getUint16(ifdOffset, little);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (data.getUint16(entry, little) !== 0x0112) continue;
    const value = data.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return null;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return null;
  const data = view(bytes);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  const positive = (width: number, height: number): ImageSize | null =>
    width > 0 && height > 0 ? { width, height } : null;
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return positive(width, height);
  }
  if (chunk === "VP8 ") {
    // 帧头：3 字节 tag + 3 字节起始码 0x9d 0x01 0x2a，之后是 14 位宽高
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return positive(data.getUint16(26) & 0x3fff, data.getUint16(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return positive(
      1 + (bits & 0x3fff),
      1 + ((bits >>> 14) & 0x03ff),
    );
  }
  return null;
}
