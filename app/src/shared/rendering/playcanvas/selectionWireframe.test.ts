import { describe, expect, test } from "bun:test";
import { createSelectionWireframe, type WireframeLayer, type WireframeObjectLike } from "./selectionWireframe";

const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

function fixture() {
  const layers: WireframeLayer[] = [];
  const removed: WireframeLayer[] = [];
  const children: unknown[] = [];
  const created: WireframeLayer[] = [];
  const records: { transforms: { center: number[]; size: number[] }[]; visible: boolean[]; opacity: number[]; destroyed: number }[] = [];
  const handle = createSelectionWireframe({}, {
    createLayer: () => {
      const layer = { id: 40 + layers.length, layer: {} };
      layers.push(layer);
      return layer;
    },
    removeLayer: (layer) => { removed.push(layer); },
    addChild: (child) => { children.push(child); },
    /**
     * 层是懒建的：调用方拿到句柄时 `layerId()` 还是 null，所以"把层 id 补进各格相机 layers"
     * 只能靠这个回调（不补的话线框永远不画——修掉 `entity.layers` 那个 no-op 之后才会暴露）。
     */
    onLayerCreated: (layer) => { created.push(layer); },
    createObject: () => {
      const record = { transforms: [] as { center: number[]; size: number[] }[], visible: [] as boolean[], opacity: [] as number[], destroyed: 0 };
      records.push(record);
      const object: WireframeObjectLike = {
        setTransform: (center, size) => { record.transforms.push({ center: [...center], size: [...size] }); },
        setVisible: (visible) => { record.visible.push(visible); },
        setOpacity: (opacity) => { record.opacity.push(opacity); },
        pickableCount: () => 0,
        instanceCount: () => 1,
        destroy: () => { record.destroyed += 1; },
      };
      return object;
    },
  });
  return { handlePromise: handle, layers, removed, children, created, records };
}

describe("选中线框引擎绑定", () => {
  test("懒建层与网格：第一次 set 才建，层 id 能交给 extraLayerIds", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    expect(f.layers.length).toBe(0);
    // 还没建层时回调**不能**发（发了的话调用方会拿到 null/不存在的层）
    expect(f.created.length).toBe(0);
    expect(handle.layerId()).toBeNull();
    handle.set(box([0, 0, 0], [1, 1, 1]), "selected");
    // 建了一层 + 一个部件（`children` 只有**默认** createObject 才会填——
    // 注入 createObject 的一方自己负责把实体挂进场景，契约如此）
    expect(f.layers.length).toBe(1);
    expect(f.records.length).toBe(1);
    expect(f.records[0]!.visible).toContain(true);
    expect(handle.layerId()).toBe(40);
    // 层建好的**那一刻**回调一次，带的就是这一层（调用方靠它把层补进各格相机的 layers）
    expect(f.created).toEqual([{ id: 40, layer: {} }]);
    // 再 set 几次不会重复回调（层只建一次）
    handle.set(box([0, 0, 0], [2, 2, 2]), "selected");
    handle.set(null, "none");
    handle.set(box([0, 0, 0], [3, 3, 3]), "selected");
    expect(f.created.length).toBe(1);
    // style = none 且还没建过时不建
    const g = fixture();
    const handle2 = await g.handlePromise;
    handle2.set(null, "none");
    expect(g.layers.length).toBe(0);
  });

  test("按外扩后的盒摆位置与缩放；hover 更淡、selected 实", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.set(box([0, 0, 0], [10, 2, 4]), "selected", 0.02);
    const pad = 10 * 0.02;
    const record = f.records[0]!;
    expect(record.transforms[0]!.center[0]).toBeCloseTo(5, 9);
    expect(record.transforms[0]!.size[0]).toBeCloseTo(10 + 2 * pad, 9);
    expect(record.opacity.at(-1)).toBe(1);
    handle.set(box([0, 0, 0], [10, 2, 4]), "hover", 0.02);
    expect(record.opacity.at(-1)).toBeCloseTo(0.35, 9);
    expect(record.visible.at(-1)).toBe(true);
    expect(handle.style()).toBe("hover");
    expect(handle.visible()).toBe(true);
  });

  test("set(null) / style=none 隐藏；再 set 回来会重新布局", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.set(box([0, 0, 0], [2, 2, 2]), "selected");
    const record = f.records[0]!;
    handle.set(null, "none");
    expect(record.visible.at(-1)).toBe(false);
    expect(handle.visible()).toBe(false);
    handle.set(box([1, 1, 1], [3, 3, 3]), "selected");
    expect(record.visible.at(-1)).toBe(true);
    expect(record.transforms.length).toBe(2);
    expect(handle.transform()!.center).toEqual([2, 2, 2]);
  });

  test("**不可拾取**：可拾取实例数恒为 0（three 侧那段注释的对应约束）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.set(box([0, 0, 0], [1, 1, 1]), "selected");
    expect(handle.pickableCount()).toBe(0);
  });

  test("dispose 销毁网格、删层、幂等", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.set(box([0, 0, 0], [1, 1, 1]), "selected");
    handle.dispose();
    expect(f.records[0]!.destroyed).toBe(1);
    expect(f.removed.length).toBe(1);
    expect(handle.layerId()).toBeNull();
    expect(handle.visible()).toBe(false);
    handle.dispose(); // 幂等
    expect(f.records[0]!.destroyed).toBe(1);
  });
});
