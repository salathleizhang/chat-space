/**
 * 把 `public/env/sky.exr` 预渲染成资产列表用的球形缩略图 `public/env/sky-thumb.png`。
 * 用法：`bun run scripts/render-sky-thumb.ts`（换 sky.exr 时重跑一次）。
 *
 * 为什么离线渲：生成出来的天空盒由 app 端离屏 R3F 渲缩略图并落进资产库，但**默认
 * 天空盒不在资产库里**（没有资产目录，缩略图无处落盘），所以这一张预渲成静态资源
 * 随 app 一起发。取景与朝向按 `widgets/ModelList/ThumbnailRenderer.tsx` 那颗球复刻：
 * fov 45 + FIT_MARGIN 1.25 的等效半径、正对赤道平视、SphereGeometry 的 UV 参数化、
 * `toneMapped={false}` 对应的"线性截断 + sRGB 编码"。
 *
 * 没有 WebGL 也能出图：EXRLoader.parse 是纯 JS，球面只有一层等距柱状贴图采样，
 * 直接按像素求交算就行，不需要渲染器。
 */
import { deflateSync } from "node:zlib";
import { FloatType } from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const SRC = new URL("../public/env/sky.exr", import.meta.url).pathname;
const OUT = new URL("../public/env/sky-thumb.png", import.meta.url).pathname;

const SIZE = 256;
/** 球在画面里的半径（px）：与 R3F 那边 fov45 + FIT_MARGIN 1.25 的取景等效 */
const RADIUS = 108.5;
/** 每像素超采样边长 */
const SS = 4;

const buf = await Bun.file(SRC).arrayBuffer();
const loader = new EXRLoader();
loader.setDataType(FloatType);
const tex = loader.parse(buf) as {
  data: Float32Array | Uint16Array;
  width: number;
  height: number;
  type: number;
};
console.log("exr:", tex.width, tex.height, tex.data.constructor.name, "type", tex.type);

const { width: TW, height: TH } = tex;
const src = tex.data as Float32Array;
if (!(src instanceof Float32Array)) throw new Error("期望 FloatType 数据");

/** 线性 → sRGB（与 toneMapped={false} 时渲染器的输出编码一致） */
function encodeSrgb(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** 等距柱状贴图采样：row 从内存首行起算（EXR 首行是图像下沿，即 uv 的 v=0） */
function sample(u: number, vUv: number, out: [number, number, number]) {
  const x = Math.min(TW - 1, Math.max(0, Math.floor(u * TW)));
  const y = Math.min(TH - 1, Math.max(0, Math.floor(vUv * TH)));
  const i = (y * TW + x) * 4;
  out[0] = src[i]!;
  out[1] = src[i + 1]!;
  out[2] = src[i + 2]!;
}

const rgba = new Uint8Array(SIZE * SIZE * 4);
const rgb: [number, number, number] = [0, 0, 0];
const cx = SIZE / 2;
const cy = SIZE / 2;

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = px + (sx + 0.5) / SS;
        const fy = py + (sy + 0.5) / SS;
        const nx = (fx - cx) / RADIUS;
        const ny = -(fy - cy) / RADIUS;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        // SphereGeometry 的参数化：x=-cosφ·sinθ, y=cosθ, z=sinφ·sinθ, uv=(φ/2π, 1-θ/π)
        const theta = Math.acos(Math.min(1, Math.max(-1, ny)));
        let phi = Math.atan2(nz, -nx);
        if (phi < 0) phi += Math.PI * 2;
        sample(phi / (Math.PI * 2), 1 - theta / Math.PI, rgb);
        r += rgb[0];
        g += rgb[1];
        b += rgb[2];
        hits++;
      }
    }
    const o = (py * SIZE + px) * 4;
    const total = SS * SS;
    if (hits === 0) continue;
    rgba[o] = encodeSrgb(r / hits);
    rgba[o + 1] = encodeSrgb(g / hits);
    rgba[o + 2] = encodeSrgb(b / hits);
    rgba[o + 3] = Math.round((hits / total) * 255);
  }
}

// ---- 最小 PNG 编码器（RGBA8，无滤波） ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const raw = new Uint8Array((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  raw.set(rgba.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1);
}
const ihdr = new Uint8Array(13);
const ihdrView = new DataView(ihdr.buffer);
ihdrView.setUint32(0, SIZE);
ihdrView.setUint32(4, SIZE);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
  chunk("IEND", new Uint8Array(0)),
]);
await Bun.write(OUT, png);
console.log("written", OUT, png.length, "bytes");
