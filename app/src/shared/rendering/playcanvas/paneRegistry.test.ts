import { expect, test } from "bun:test";
import { PaneRegistry, cameraLayers, type CameraApplyOptions, type PaneSpec } from "./paneRegistry";

const CANVAS = { width: 1000, height: 800 };

function harness() {
  const applied: { paneId: string; options: CameraApplyOptions }[] = [];
  const destroyed: string[] = [];
  const layers = { created: [] as string[], removed: [] as number[], next: 10 };
  let seq = 0;
  const registry = new PaneRegistry({
    canvasSize: () => CANVAS,
    createCamera: (paneId) => {
      const key = `${paneId}#${++seq}`;
      return {
        applyCamera: (options) => { applied.push({ paneId: key, options }); },
        destroy: () => { destroyed.push(key); },
      };
    },
    createPaneLayer: (paneId) => { layers.created.push(paneId); return layers.next++; },
    removePaneLayer: (layerId) => { layers.removed.push(layerId); },
    worldLayerId: () => 0,
  });
  return { registry, applied, destroyed, layers };
}

const pane = (id: string, over: Partial<PaneSpec> = {}): PaneSpec => ({
  id,
  viewport: { left: 0, top: 0, width: 1000, height: 800 },
  ...over,
});

test("相机可见层 = 共享核心 + 自己那层，且顺序稳定", () => {
  expect(cameraLayers(0, 10)).toEqual([0, 10]);
  expect(cameraLayers(0, 0)).toEqual([0]); // 不重复
});

test("额外层（变换 gizmo）进相机 layers：去重、排序，且重复 id 只出现一次", () => {
  // 相机 layers 里出现重复 id 会让同一层被画两遍，所以这里必须去重
  expect(cameraLayers(0, 10, [12])).toEqual([0, 10, 12]);
  expect(cameraLayers(0, 10, [10, 0, 12, 12])).toEqual([0, 10, 12]);
  expect(cameraLayers(0, 0, [7])).toEqual([0, 7]);
});

test("extraLayerIds 走注册表写入相机 layers（外部 concat 会被下次 sync 抹掉）", () => {
  const h = harness();
  h.registry.sync([pane("a", { extraLayerIds: [12] })]);
  expect(h.applied.at(-1)!.options.layers).toEqual([0, 10, 12]);
  // 下一次 sync 仍然带着它——这正是"相机 layers 只有一个写入点"的意义
  h.registry.sync([pane("a")]);
  expect(h.applied.at(-1)!.options.layers).toEqual([0, 10]);
});

test("1 → 2 → 4 窗格：只建缺的，已存在的实体被复用（身份稳定）", () => {
  const h = harness();
  h.registry.sync([pane("a")]);
  expect(h.applied.map((a) => a.paneId)).toEqual(["a#1"]);

  h.registry.sync([pane("a", { viewport: { left: 0, top: 0, width: 500, height: 800 } }), pane("b", { viewport: { left: 500, top: 0, width: 500, height: 800 } })]);
  expect(h.applied.map((a) => a.paneId)).toEqual(["a#1", "a#1", "b#2"]);
  expect(h.destroyed).toEqual([]);

  h.registry.sync([
    pane("a", { viewport: { left: 0, top: 0, width: 500, height: 400 } }),
    pane("b", { viewport: { left: 500, top: 0, width: 500, height: 400 } }),
    pane("c", { viewport: { left: 0, top: 400, width: 500, height: 400 } }),
    pane("d", { viewport: { left: 500, top: 400, width: 500, height: 400 } }),
  ]);
  expect(h.registry.size).toBe(4);
  // a、b 复用原实体（#1/#2），只有 c、d 是新建的
  expect(h.applied.slice(-4).map((a) => a.paneId)).toEqual(["a#1", "b#2", "c#3", "d#4"]);
  expect(h.destroyed).toEqual([]);
});

test("4 → 1 窗格：多余的实体与自建 layer 都被销毁", () => {
  const h = harness();
  h.registry.sync([pane("a"), pane("b"), pane("c"), pane("d")]);
  expect(h.registry.size).toBe(4);
  h.registry.sync([pane("a")]);
  expect(h.registry.ids()).toEqual(["a"]);
  expect(h.destroyed.sort()).toEqual(["b#2", "c#3", "d#4"]);
  // 只回收自建的 layer，不能动共享核心层
  expect(h.layers.removed.sort()).toEqual([11, 12, 13]);
});

test("调用方自带 hudLayerId 时不新建、也不回收那一层", () => {
  const h = harness();
  h.registry.sync([pane("a", { hudLayerId: 0 })]);
  expect(h.layers.created).toEqual([]);
  h.registry.sync([]);
  expect(h.layers.removed).toEqual([]);
  // hudLayerId 与核心同层时不能重复列出
  expect(h.applied.at(-1)!.options.layers).toEqual([0]);
});

test("每格都必须清深度；颜色默认也逐格清", () => {
  const h = harness();
  h.registry.sync([pane("a"), pane("b", { viewport: { left: 500, top: 0, width: 500, height: 800 } })]);
  for (const { options } of h.applied.slice(-2)) expect(options.clearDepthBuffer).toBe(true);
  expect(h.applied.at(-2)!.options.clearColorBuffer).toBe(true);
  expect(h.applied.at(-1)!.options.clearColorBuffer).toBe(true);

  h.registry.sync([pane("a"), pane("b", { viewport: { left: 500, top: 0, width: 500, height: 800 }, clearColorPerPane: false })]);
  expect(h.applied.at(-1)!.options.clearDepthBuffer).toBe(true);
  expect(h.applied.at(-1)!.options.clearColorBuffer).toBe(false);
});

test("priority 与窗格顺序一致（渲染顺序 = DOM 顺序）", () => {
  const h = harness();
  h.registry.sync([pane("a"), pane("b"), pane("c"), pane("d")]);
  expect(h.applied.slice(-4).map((a) => a.options.priority)).toEqual([0, 1, 2, 3]);
});

test("尺寸为 0 的窗格被跳过：不建实体、不产出 rect", () => {
  const h = harness();
  const rects = h.registry.sync([pane("a", { viewport: { left: 0, top: 0, width: 0, height: 0 } })]);
  expect(rects).toEqual([]);
  expect(h.registry.size).toBe(0);
  expect(h.applied).toEqual([]);
});

test("同一批里重名的窗格只建一次", () => {
  const h = harness();
  h.registry.sync([pane("a"), pane("a", { viewport: { left: 500, top: 0, width: 500, height: 800 } })]);
  expect(h.registry.size).toBe(1);
  expect(h.applied.length).toBe(1);
});

test("dispose 释放全部实体与自建 layer，且幂等", () => {
  const h = harness();
  h.registry.sync([pane("a"), pane("b")]);
  h.registry.dispose();
  expect(h.registry.size).toBe(0);
  expect(h.destroyed.sort()).toEqual(["a#1", "b#2"]);
  expect(h.layers.removed.sort()).toEqual([10, 11]);
  h.registry.dispose();
  expect(h.destroyed.length).toBe(2); // 没有第二次
});

test("rect 用的是当前画布尺寸（换尺寸后同一 DOM 视口得到不同归一化值）", () => {
  let canvas = { width: 1000, height: 800 };
  const seen: CameraApplyOptions[] = [];
  const registry = new PaneRegistry({
    canvasSize: () => canvas,
    createCamera: () => ({ applyCamera: (o) => seen.push(o), destroy: () => {} }),
    createPaneLayer: () => 10,
  });
  const half = { left: 500, top: 0, width: 500, height: 800 };
  registry.sync([pane("a", { viewport: half })]);
  expect(seen.at(-1)!.rect.x).toBe(0.5);
  canvas = { width: 2000, height: 800 };
  registry.sync([pane("a", { viewport: half })]);
  expect(seen.at(-1)!.rect.x).toBe(0.25);
});
