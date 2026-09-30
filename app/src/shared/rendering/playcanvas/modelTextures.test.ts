import { expect, test } from "bun:test";
import { collectChannelTextures, collectMaterials, collectTextureEntries, type PcEntityLike } from "./modelTextures";
import { isDrawableImage } from "../../../shared/lib/textureSlots";

const texture = (id: number, width = 0, height = 0) => ({
  id,
  getSource: () => ({ width, height, source: null }),
});

const entity = (materials: Record<string, unknown>[], children: PcEntityLike[] = []): PcEntityLike => ({
  render: { meshInstances: materials.map((material) => ({ material })) },
  children,
});

test("用 PlayCanvas 的属性名取通道（照搬 three 的名字会一个都发现不到）", () => {
  const root = entity([{ name: "M", diffuseMap: texture(1), glossMap: texture(2), clearCoatMap: texture(3) }]);
  const entries = collectTextureEntries(root);
  expect(entries.map((e) => e.label).sort()).toEqual(["Base Color", "CC", "Rough"]);
});

test("不支持的通道被跳过，而不是被当成缺失", () => {
  // bumpMap 在 PlayCanvas 上没有对应物；就算材质上真有个同名字段也不该被误报
  const root = entity([{ name: "M", bumpMap: texture(9), diffuseMap: texture(1) }]);
  expect(collectTextureEntries(root).map((e) => e.label)).toEqual(["Base Color"]);
});

test("同一张贴图被多个槽位/材质复用时只出一条，标注按通道表顺序合并", () => {
  const shared = texture(7);
  // 注意用 PlayCanvas 的属性名 glossMap（不是 three 的 roughnessMap）——
  // 用错名字会被正确忽略，见上一条测试
  const root = entity([
    { name: "A", metalnessMap: shared, glossMap: shared },
    { name: "B", metalnessMap: shared },
  ]);
  const entries = collectTextureEntries(root);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.label).toBe("Metal/Rough"); // 顺序由通道表决定，不随材质顺序变化
  expect(entries[0]!.materials).toEqual(["A", "B"]);
  expect(entries[0]!.id).toBe("pc-texture-7");
});

test("材质去重：同一材质被多个 meshInstance 引用时只处理一次", () => {
  const material = { name: "M", diffuseMap: texture(1) };
  const root: PcEntityLike = { render: { meshInstances: [{ material }, { material }] } };
  expect(collectMaterials(root)).toHaveLength(1);
});

test("递归子实体；同一张贴图跨层复用仍只出一条", () => {
  const shared = texture(3);
  const root = entity([{ name: "A", diffuseMap: shared }], [entity([{ name: "B", emissiveMap: shared }])]);
  const entries = collectTextureEntries(root);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.label).toBe("Base Color/Emissive");
  expect(entries[0]!.materials).toEqual(["A", "B"]);
});

test("按通道收集：每格取第一个填了它的材质，且跳过不支持/缺失的通道", () => {
  const root = entity([
    { name: "Main", diffuseMap: texture(1, 1024, 512) },
    { name: "Second", diffuseMap: texture(2), bumpMap: texture(3) },
  ]);
  const found = collectChannelTextures(root, ["map", "bumpMap", "normalMap", "clearcoatMap"]);
  expect([...found.keys()]).toEqual(["map"]);
  expect(found.get("map")).toMatchObject({ materialName: "Main", width: 1024, height: 512 });
});

test("贴图没有 id 时退到 name，再退到材质名+属性名（保证遍历内稳定）", () => {
  const root = entity([
    { name: "M", diffuseMap: { getSource: () => null } },
    { name: "M2", normalMap: { name: "NormalTex", getSource: () => null } },
  ]);
  const ids = collectTextureEntries(root).map((e) => e.id).sort();
  expect(ids).toEqual(["pc-fallback-M:diffuseMap", "pc-name-NormalTex"]);
});

test("level 本身就是可绘制图像（图像不在它的 .source 上）", () => {
  // 本机实测：GLB 贴图的 `getSource()` 返回的就是 `ImageBitmap`（原型只有 width/height/close），
  // 引擎的 `releaseImageSources()` 里直接判 `level instanceof ImageBitmap` 就是证据。
  // 唯一正确的判定是"level 自己可绘制"；旧假设 `level.source` 是错的。
  // happy-dom 没有 ImageBitmap，用同为 CanvasImageSource 的 canvas 等价验证谓词；
  // 端到端的缩略图产出由真实浏览器探针验证（单测环境画不出 data URL）。
  const canvas = document.createElement("canvas");
  expect(isDrawableImage(canvas)).toBe(true);
  expect(isDrawableImage((canvas as unknown as { source?: unknown }).source)).toBe(false);
});

test("取不到图像时不报错，尺寸退到 0 且缩略图为 null", () => {
  const root = entity([{ name: "M", diffuseMap: { id: 5, getSource: () => null } }]);
  const entries = collectTextureEntries(root);
  expect(entries[0]).toMatchObject({ width: 0, height: 0, dataUrl: null });
});

test("空场景 / 无材质实体不报错", () => {
  expect(collectTextureEntries({})).toEqual([]);
  expect(collectTextureEntries({ children: [{}, { render: {} }] })).toEqual([]);
  expect(collectChannelTextures({}, ["map"]).size).toBe(0);
});
