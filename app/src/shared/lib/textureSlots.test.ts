import { expect, test } from "bun:test";
import {
  bindingFor,
  combineSlotLabels,
  imageSize,
  isDrawableImage,
  missingBindings,
  PLAYCANVAS_SLOTS,
  PLAYCANVAS_UNSUPPORTED,
  TEXTURE_SLOTS,
  TEXTURE_SLOT_KEYS,
  textureThumbnail,
  thumbCacheSize,
} from "./textureSlots";

test("通道表：key 唯一，且与 materialSchema 的 7 项覆盖表**不是同一张表**", () => {
  // 这张表是"发现"（模型可能有哪些通道，18 项），覆盖表是"用户能换哪些"（7 项）。
  // 混用会让右侧栏出现换不了的通道，或让悬浮卡漏报模型实际带的贴图。
  expect(new Set(TEXTURE_SLOT_KEYS).size).toBe(TEXTURE_SLOTS.length);
  expect(TEXTURE_SLOTS.length).toBeGreaterThan(7);
  expect(TEXTURE_SLOT_KEYS).toContain("map");
  expect(TEXTURE_SLOT_KEYS).toContain("clearcoatMap"); // 覆盖表里没有的通道也要能发现
});

test("槽位合并名的顺序由通道表决定，不随命中顺序变化", () => {
  expect(combineSlotLabels(["roughnessMap", "metalnessMap"])).toBe("Metal/Rough");
  expect(combineSlotLabels(["metalnessMap", "roughnessMap"])).toBe("Metal/Rough");
  expect(combineSlotLabels(["map"])).toBe("Base Color");
  expect(combineSlotLabels([])).toBe("");
});

test("尺寸优先取 naturalWidth（HTMLImageElement 的 width 是 CSS 尺寸，常为 0）", () => {
  expect(imageSize({ width: 0, height: 0, naturalWidth: 1024, naturalHeight: 512 })).toEqual({ width: 1024, height: 512 });
  // ImageBitmap 没有 naturalWidth，退回 width/height
  expect(imageSize({ width: 256, height: 256 })).toEqual({ width: 256, height: 256 });
  expect(imageSize(null)).toEqual({ width: 0, height: 0 });
});

test("不可绘制的 image（压缩纹理 / DataTexture）返回 null，且结果进缓存", () => {
  const before = thumbCacheSize();
  expect(textureThumbnail("compressed-ktx2-1", { some: "compressed payload" })).toBeNull();
  // 第二次命中缓存，不再重新判断
  expect(textureThumbnail("compressed-ktx2-1", { some: "compressed payload" })).toBeNull();
  expect(thumbCacheSize()).toBe(before + 1);
  expect(isDrawableImage({})).toBe(false);
  expect(isDrawableImage(null)).toBe(false);
});

test("缩略图缓存有上界（FIFO），长会话反复导入不会无界累积", () => {
  for (let i = 0; i < 400; i += 1) textureThumbnail(`bulk-${i}`, null);
  // 上限 256；这里断言"不会随调用次数线性增长"
  expect(thumbCacheSize()).toBeLessThanOrEqual(256);
  expect(thumbCacheSize()).toBe(256);
});

test("每个规范通道要么有 PlayCanvas 映射、要么显式声明不支持（不能静默漏报）", () => {
  // 这条断言的作用：以后有人往 TEXTURE_SLOTS 里加通道却忘了配映射，测试会失败，
  // 而不是运行时"这个通道在 PlayCanvas 上永远发现不到"。
  expect(missingBindings(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED)).toEqual([]);
  expect(bindingFor(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED, "bumpMap")).toBeNull();
  expect(bindingFor(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED, "map")).toEqual({ property: "diffuseMap" });
});

test("语义不等的映射必须被标出来（照搬属性名会得到错误标注）", () => {
  // 粗糙度 ↔ 光泽度是**取反**关系：three 的 roughnessMap 越白越粗糙，
  // PlayCanvas 的 glossMap 越白越光滑。标注必须说明，否则用户以为在调粗糙度。
  expect(PLAYCANVAS_SLOTS.roughnessMap).toEqual({ property: "glossMap", inverted: true });
  expect(PLAYCANVAS_SLOTS.clearcoatRoughnessMap).toEqual({ property: "clearCoatGlossMap", inverted: true });
  // 位移图 ↔ 高度图语义不同，只能算近似
  expect(PLAYCANVAS_SLOTS.displacementMap).toEqual({ property: "heightMap", approximate: true });
  // 同名直通的通道不应带任何旗标
  for (const key of ["normalMap", "aoMap", "emissiveMap", "metalnessMap", "lightMap"]) {
    expect({ key, binding: PLAYCANVAS_SLOTS[key] }).toEqual({ key, binding: { property: key } });
  }
});
