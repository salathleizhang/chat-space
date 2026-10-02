import { describe, expect, test } from "bun:test";
import {
  createPanePicker, describePickTarget, entityWorldBounds, firstPickResult, toPickPixel,
  type PickerLike,
} from "./panePicking";

const CANVAS = { width: 800, height: 400 };

describe("画布坐标 → 拾取缓冲像素", () => {
  test("1:1 时是恒等映射（拾取缓冲按画布 CSS 尺寸建）", () => {
    expect(toPickPixel({ x: 0, y: 0 }, CANVAS, CANVAS)).toEqual({ x: 0, y: 0 });
    expect(toPickPixel({ x: 799, y: 399 }, CANVAS, CANVAS)).toEqual({ x: 799, y: 399 });
    expect(toPickPixel({ x: 400, y: 200 }, CANVAS, CANVAS)).toEqual({ x: 400, y: 200 });
  });

  test("半分辨率时按**归一化**位置缩放（与窗格大小/DPR 无关）", () => {
    const half = { width: 400, height: 200 };
    expect(toPickPixel({ x: 0, y: 0 }, CANVAS, half)).toEqual({ x: 0, y: 0 });
    expect(toPickPixel({ x: 400, y: 200 }, CANVAS, half)).toEqual({ x: 200, y: 100 });
    // 画布右下角不能越出缓冲（越界读回会抛/返回零值）
    expect(toPickPixel({ x: 799, y: 399 }, CANVAS, half)).toEqual({ x: 399, y: 199 });
  });

  test("画布之外、退化尺寸、非有限值都返回 null（把窗外与窗内没物体区分开）", () => {
    expect(toPickPixel({ x: -1, y: 10 }, CANVAS, CANVAS)).toBeNull();
    expect(toPickPixel({ x: 10, y: 400 }, CANVAS, CANVAS)).toBeNull();
    expect(toPickPixel({ x: 800, y: 10 }, CANVAS, CANVAS)).toBeNull();
    expect(toPickPixel({ x: 10, y: 10 }, { width: 0, height: 0 }, CANVAS)).toBeNull();
    expect(toPickPixel({ x: 10, y: 10 }, CANVAS, { width: 0, height: 0 })).toBeNull();
    expect(toPickPixel({ x: Number.NaN, y: 10 }, CANVAS, CANVAS)).toBeNull();
  });
});

describe("拾取结果归一化", () => {
  test("MeshInstance → mesh，实体是它的 node，并带上世界 AABB", () => {
    const node = { name: "box-a" };
    const result = describePickTarget({
      node,
      aabb: { center: { x: 1, y: 2, z: 3 }, halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    });
    expect(result).toEqual({
      entity: node, kind: "mesh", name: "box-a",
      bounds: { center: [1, 2, 3], halfExtents: [0.5, 0.5, 0.5] },
    });
  });

  test("GSplatComponent → gsplat（它没有 mesh AABB，所以不猜 bounds）", () => {
    const entity = { name: "world" };
    expect(describePickTarget({ entity })).toEqual({ entity, kind: "gsplat", name: "world" });
  });

  test("认不出来的（null / 数字 / 空对象）返回 null：宁可漏，不可猜", () => {
    expect(describePickTarget(null)).toBeNull();
    expect(describePickTarget(7)).toBeNull();
    expect(describePickTarget({})).toBeNull();
  });

  test("多结果里取第一个认得出来的", () => {
    const node = { name: "b" };
    expect(firstPickResult([null, 3, { node }])?.name).toBe("b");
    expect(firstPickResult([null, 3])).toBeNull();
  });

  test("实体世界包围盒取所有 mesh instance 的并集", () => {
    // ⚠️ 假数据必须用**引擎的真实形状**（`Vec3`：只有 x/y/z，没有数字下标）。第一版这里写的是
    // 元组 `[0,0,0]`，而实现里读的是 `center[0]`——两边一起错、测试还通过，
    // 直到选中线框真的用上它才暴露（见 `meshBounds` 的注释）。
    const bounds = entityWorldBounds({
      render: {
        meshInstances: [
          { aabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } } },
          { aabb: { center: { x: 4, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } } },
        ],
      },
    });
    expect(bounds).toEqual({ center: [2, 0, 0], halfExtents: [3, 1, 1] });
    expect(entityWorldBounds({ render: { meshInstances: [] } })).toBeUndefined();
    expect(entityWorldBounds(undefined)).toBeUndefined();
  });

  test("世界 AABB 的每个分量都是有限数（NaN 会让选中线框静默消失）", () => {
    const bounds = entityWorldBounds({
      render: {
        meshInstances: [
          { node: { name: "box" }, aabb: { center: { x: 1, y: 2, z: 3 }, halfExtents: { x: 0.5, y: 1, z: 1.5 } } },
        ],
      },
    })!;
    expect(bounds.center).toEqual([1, 2, 3]);
    expect(bounds.halfExtents).toEqual([0.5, 1, 1.5]);
    for (const value of [...bounds.center, ...bounds.halfExtents]) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("按需拾取句柄", () => {
  function fixture(overrides: { selection?: unknown[]; canvas?: { width: number; height: number } } = {}) {
    const state = {
      canvas: overrides.canvas ?? { ...CANVAS },
      selection: overrides.selection ?? [{ node: { name: "hit" } }],
      created: 0,
      prepares: [] as { camera: unknown; layers: unknown[] | undefined }[],
      reads: [] as { x: number; y: number }[],
      destroyed: 0,
    };
    const createPicker = (width: number, height: number): PickerLike => {
      state.created += 1;
      const picker: PickerLike = {
        width, height,
        resize(w, h) { picker.width = w; picker.height = h; },
        prepare: (camera, _scene, layers) => { state.prepares.push({ camera, layers: layers as unknown[] | undefined }); },
        getSelectionAsync: async (x, y) => { state.reads.push({ x, y }); return state.selection; },
        destroy: () => { state.destroyed += 1; },
      };
      return picker;
    };
    const cameras = new Map<string, { camera: unknown }>([
      ["pane-0", { camera: { name: "camera-0" } }],
      ["pane-1", { camera: { name: "camera-1" } }],
    ]);
    const app = { scene: { layers: { getLayerById: (id: number) => ({ id }) } } };
    const handle = createPanePicker(app, {
      canvasSize: () => state.canvas,
      cameraFor: (paneId) => cameras.get(paneId) ?? null,
      createPicker,
    });
    return { state, handle, cameras };
  }

  test("第一趟 pick 才建 Picker（不拾取就不分配显存）", async () => {
    const { state, handle } = fixture();
    expect(state.created).toBe(0);
    await handle.pick("pane-0", { x: 10, y: 10 });
    expect(state.created).toBe(1);
    expect(handle.bufferSize()).toEqual({ width: 800, height: 400 });
  });

  test("只把共享核心层交给 prepare（HUD 坐标轴球与 gizmo 手柄不该被拾取到）", async () => {
    const { state, handle } = fixture();
    await handle.pick("pane-0", { x: 10, y: 10 });
    expect(state.prepares.length).toBe(1);
    expect(state.prepares[0]!.camera).toEqual({ name: "camera-0" });
    expect(state.prepares[0]!.layers).toEqual([{ id: 0 }]);
  });

  test("命中返回归一化结果，读的是那一个像素（归一化坐标）", async () => {
    const { state, handle } = fixture();
    const hit = await handle.pick("pane-0", { x: 400, y: 100 });
    expect(hit?.name).toBe("hit");
    expect(state.reads).toEqual([{ x: 400, y: 100 }]);
    // 半分辨率时按归一化位置缩放
    const half = fixture();
    Object.assign(half.state.canvas, { width: 800, height: 400 });
    const scaled = createPanePicker({ scene: { layers: { getLayerById: () => ({}) } } }, {
      canvasSize: () => ({ width: 800, height: 400 }),
      cameraFor: () => ({ camera: {} }),
      resolution: 0.5,
      createPicker: (w, h) => ({ width: w, height: h, resize() {}, prepare() {}, getSelectionAsync: async (x, y) => { half.state.reads.push({ x, y }); return []; }, destroy() {} }),
    });
    await scaled.pick("pane-0", { x: 200, y: 100 });
    expect(half.state.reads).toEqual([{ x: 100, y: 50 }]);
  });

  test("没有相机 / 点在画布外：不建缓冲也不读回", async () => {
    const { state, handle } = fixture();
    expect(await handle.pick("pane-9", { x: 10, y: 10 })).toBeNull();
    expect(state.created).toBe(0);
    await handle.pick("pane-0", { x: 900, y: 10 });
    expect(state.reads).toEqual([]);
    // 点在画布外时缓冲已经建了（第一趟 pick 就建），但不该读回
    expect(state.created).toBe(1);
  });

  test("画布尺寸变了会 resize 缓冲，不用重建 Picker", async () => {
    const { state, handle } = fixture();
    await handle.pick("pane-0", { x: 10, y: 10 });
    Object.assign(state.canvas, { width: 400, height: 200 });
    await handle.pick("pane-0", { x: 10, y: 10 });
    expect(state.created).toBe(1);
    expect(handle.bufferSize()).toEqual({ width: 400, height: 200 });
  });

  test("并发拾取被串行化：不会两次 prepare 叠在同一个缓冲上", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const picker: PickerLike = {
      width: 800, height: 400, resize() {},
      prepare: () => { order.push("prepare"); },
      getSelectionAsync: () => {
        order.push("read");
        if (!release) return new Promise((resolve) => { release = () => { order.push("resolve"); resolve([]); }; });
        return Promise.resolve([]);
      },
      destroy() {},
    };
    const handle = createPanePicker({ scene: { layers: { getLayerById: () => ({}) } } }, {
      canvasSize: () => CANVAS, cameraFor: () => ({ camera: {} }), createPicker: () => picker,
    });
    const first = handle.pick("pane-0", { x: 10, y: 10 });
    const second = handle.pick("pane-0", { x: 20, y: 20 });
    // 串行化经过几层 await（ensurePicker 是 async），让微任务跑完再断言
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 第二趟必须等第一趟读完（否则两个 prepare 会踩同一块缓冲）
    expect(order).toEqual(["prepare", "read"]);
    release!();
    await first;
    await second;
    expect(order).toEqual(["prepare", "read", "resolve", "prepare", "read"]);
  });

  test("dispose 释放缓冲且幂等；之后 pick 一律返回 null", async () => {
    const { state, handle } = fixture();
    await handle.pick("pane-0", { x: 10, y: 10 });
    handle.dispose();
    handle.dispose();
    expect(state.destroyed).toBe(1);
    expect(handle.bufferSize()).toEqual({ width: 0, height: 0 });
    expect(await handle.pick("pane-0", { x: 10, y: 10 })).toBeNull();
    expect(state.reads.length).toBe(1); // 只有 dispose 之前那一次
  });
});
