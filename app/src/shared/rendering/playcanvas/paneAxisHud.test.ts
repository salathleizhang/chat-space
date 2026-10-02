import { describe, expect, test } from "bun:test";
import type { CameraRig } from "../../../shared/lib/cameraRig";
import {
  AXIS_HEADS, createAxisHudWidget, createPaneAxisHud, HALF_SIZE_PX, headWorldPositions, HUD_DEPTH, hudPlacement,
  MARGIN_PX, pickAxisHead, rigForAxisSnap, type AxisHudLayer, type AxisWidgetLike, type HudCameraLike,
} from "./paneAxisHud";

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10, fov: 60, projection: "perspective", ...over,
});

/** 一台朝向 -Z 的相机（右手系：right=+X、up=+Y、forward=-Z），与 applyRig 的默认朝向一致。 */
const camera = (over: Partial<HudCameraLike> = {}): HudCameraLike => ({
  position: [0, 0, 10], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
  fov: 60, projection: "perspective", orthoHeight: 7.5, ...over,
});

describe("部件摆放（屏幕等大 + 右上角锚点）", () => {
  test("透视：一个像素的世界大小 = 2·depth·tan(fov/2)/窗格高", () => {
    const { worldPerPixel, scale, position } = hudPlacement({ camera: camera(), paneWidth: 800, paneHeight: 600 });
    const expected = (2 * HUD_DEPTH * Math.tan(Math.PI / 6)) / 600;
    expect(worldPerPixel).toBeCloseTo(expected, 12);
    // 部件半边长 40 px ⇒ 屏幕上直径 80 px
    expect(scale).toBeCloseTo(expected * HALF_SIZE_PX, 12);
    // 位置：相机前方 depth、右偏 (400-64) px、上偏 (300-64) px（相机在 +Z 看向 -Z）
    expect(position[0]).toBeCloseTo((800 / 2 - MARGIN_PX) * expected, 9);
    expect(position[1]).toBeCloseTo((600 / 2 - MARGIN_PX) * expected, 9);
    expect(position[2]).toBeCloseTo(10 - HUD_DEPTH, 9);
  });

  test("fov 或窗格高变化时部件**在屏幕上的**大小不变：比例尺跟着换算", () => {
    const a = hudPlacement({ camera: camera({ fov: 60 }), paneWidth: 800, paneHeight: 600 });
    const b = hudPlacement({ camera: camera({ fov: 30 }), paneWidth: 800, paneHeight: 600 });
    // fov 变窄 → 一个像素对应的世界单位更小（同样 40px 只需更小的世界尺寸）
    expect(b.scale).toBeLessThan(a.scale);
    expect(b.scale / a.scale).toBeCloseTo(Math.tan(Math.PI / 12) / Math.tan(Math.PI / 6), 9);
    // 窗格高一倍 → 一个像素对应的世界单位减半（屏幕上仍是 80px）
    const tall = hudPlacement({ camera: camera(), paneWidth: 800, paneHeight: 1200 });
    expect(tall.scale / a.scale).toBeCloseTo(0.5, 9);
  });

  test("正交窗格用 orthoHeight（可见高度是常量，与深度/距离无关）", () => {
    const { worldPerPixel, scale, position } = hudPlacement({
      camera: camera({ projection: "orthographic", orthoHeight: 7.5 }), paneWidth: 800, paneHeight: 600,
    });
    expect(worldPerPixel).toBeCloseTo(15 / 600, 12);
    expect(scale).toBeCloseTo((15 / 600) * HALF_SIZE_PX, 12);
    // 正交也要放到相机前方固定深度（否则会被近裁剪面切掉）
    expect(position[2]).toBeCloseTo(10 - HUD_DEPTH, 9);
  });

  test("窗格退化尺寸不产生 NaN", () => {
    const { worldPerPixel, scale } = hudPlacement({ camera: camera(), paneWidth: 0, paneHeight: 0 });
    expect(Number.isFinite(worldPerPixel)).toBe(true);
    expect(Number.isFinite(scale)).toBe(true);
  });
});

describe("轴球的世界位置与屏幕命中", () => {
  test("六个轴球：中心 + 方向 × 半径，正负成对", () => {
    const points = headWorldPositions([1, 2, 3], 0.5);
    expect(points.length).toBe(6);
    expect(points.find((p) => p.head.axis === "x" && p.head.sign === 1)!.position).toEqual([1.5, 2, 3]);
    expect(points.find((p) => p.head.axis === "y" && p.head.sign === -1)!.position).toEqual([1, 1.5, 3]);
    expect(points.find((p) => p.head.axis === "z" && p.head.sign === 1)!.position).toEqual([1, 2, 3.5]);
  });

  test("命中取最近的、且必须在半径内", () => {
    const head = AXIS_HEADS.find((h) => h.axis === "x" && h.sign === 1)!;
    const other = AXIS_HEADS.find((h) => h.axis === "y" && h.sign === 1)!;
    const points = [
      { head, screen: { x: 100, y: 100 } },
      { head: other, screen: { x: 140, y: 100 } },
    ];
    expect(pickAxisHead(points, { x: 102, y: 100 }, 22)).toBe(head);
    expect(pickAxisHead(points, { x: 139, y: 100 }, 22)).toBe(other);
    // 两个都在半径内时取更近的（head 在 100、other 在 140；119 离 head 更近）
    expect(pickAxisHead(points, { x: 119, y: 100 }, 40)).toBe(head);
    expect(pickAxisHead(points, { x: 121, y: 100 }, 40)).toBe(other);
    // 都不在半径内 → null
    expect(pickAxisHead(points, { x: 300, y: 100 }, 22)).toBeNull();
    expect(pickAxisHead([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("点击轴球后的机位", () => {
  test("只改朝向：距离与目标点不动；方位角/极角由方向给出", () => {
    const snapped = rigForAxisSnap(rig({ target: [4, 5, 6], distance: 33 }), [1, 0, 0]);
    expect(snapped.target).toEqual([4, 5, 6]);
    expect(snapped.distance).toBe(33);
    expect(snapped.azimuth).toBeCloseTo(Math.PI / 2, 12); // 从 +X 看过去
    expect(snapped.polar).toBeCloseTo(Math.PI / 2, 12);
  });

  test("正上/正下：极角钳到开区间，方位角保持原样（atan2(0,0) 无意义）", () => {
    const top = rigForAxisSnap(rig({ azimuth: 1.234 }), [0, 1, 0]);
    expect(top.polar).toBeCloseTo(0.01, 12);
    expect(top.azimuth).toBe(1.234);
    const bottom = rigForAxisSnap(rig({ azimuth: 1.234 }), [0, -1, 0]);
    expect(bottom.polar).toBeCloseTo(Math.PI - 0.01, 12);
    expect(bottom.azimuth).toBe(1.234);
  });

  test("六个方向都能算出有限的朝向", () => {
    for (const head of AXIS_HEADS) {
      const snapped = rigForAxisSnap(rig(), head.direction);
      expect(Number.isFinite(snapped.azimuth)).toBe(true);
      expect(Number.isFinite(snapped.polar)).toBe(true);
      expect(snapped.polar).toBeGreaterThan(0);
      expect(snapped.polar).toBeLessThan(Math.PI);
    }
  });
});

describe("逐窗格 HUD 句柄（注入假部件）", () => {
  function fixture() {
    const layers: AxisHudLayer[] = [];
    const removed: AxisHudLayer[] = [];
    const widgets: { paneId: string; transforms: { position: number[]; scale: number }[]; destroyed: number }[] = [];
    // 相机实体：位置 (0,0,10) 看向 -Z；camera 组件把世界点投到屏幕（画布 800×600，左上原点）
    const cameraEntity = {
      getPosition: () => ({ x: 0, y: 0, z: 10 }),
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: -1 },
      camera: {
        fov: 60,
        projection: 0,
        orthoHeight: 7.5,
        worldToScreen: (p: unknown) => {
          const point = p as { x: number; y: number; z: number };
          // 世界 → 屏幕：以 (0,0,10) 为相机、fov 60、画布 800×600（够用即可，不是通用投影）
          const depth = 10 - point.z;
          const worldPerPixel = (2 * depth * Math.tan(Math.PI / 6)) / 600;
          return { x: 400 + point.x / worldPerPixel, y: 300 - point.y / worldPerPixel };
        },
      },
    };
    const app = {
      root: { addChild: () => {} },
      on: (_event: string, handler: () => void) => {
        handlers.push(handler);
        return { off: () => { handlers = handlers.filter((h) => h !== handler); } };
      },
    };
    let handlers: (() => void)[] = [];
    const handlePromise = createPaneAxisHud(app, {
      createLayer: (paneId) => {
        const layer = { id: 20 + layers.length, layer: { name: `hud:${paneId}` } };
        layers.push(layer);
        return layer;
      },
      removeLayer: (layer) => { removed.push(layer); },
      cameraFor: (paneId) => (paneId === "pane-0" ? cameraEntity : null),
      paneRectFor: () => ({ width: 800, height: 600 }),
      createWidget: (paneId) => {
        const record = { paneId, transforms: [] as { position: number[]; scale: number }[], destroyed: 0 };
        widgets.push(record);
        const widget: AxisWidgetLike = {
          setTransform: (position, scale) => { record.transforms.push({ position: [...position], scale }); },
          setVisible: () => {},
          destroy: () => { record.destroyed += 1; },
        };
        return widget;
      },
    });
    const tick = () => { for (const handler of handlers) handler(); };
    return { handlePromise, layers, removed, widgets, tick, handlers: () => handlers };
  }

  test("第一次用到才建层与部件；层 id 能交给 extraLayerIds", async () => {
    const f = fixture();
    const hud = await f.handlePromise;
    expect(f.layers.length).toBe(0);
    expect(hud.layerIdFor("pane-0")).toBe(20);
    expect(f.layers.length).toBe(1);
    expect(f.widgets.length).toBe(1);
    // 没有相机的窗格不建
    expect(hud.layerIdFor("pane-9")).toBeNull();
    expect(f.layers.length).toBe(1);
  });

  test("每帧更新一次 transform，位置/缩放都来自 hudPlacement", async () => {
    const f = fixture();
    const hud = await f.handlePromise;
    hud.layerIdFor("pane-0");
    f.tick();
    f.tick();
    const widget = f.widgets[0]!;
    expect(widget.transforms.length).toBe(2);
    const expected = hudPlacement({ camera: camera(), paneWidth: 800, paneHeight: 600 });
    expect(widget.transforms[0]!.scale).toBeCloseTo(expected.scale, 12);
    expect(widget.transforms[0]!.position[0]).toBeCloseTo(expected.position[0], 9);
  });

  test("命中与吸附：屏幕点落在某个轴球上就返回那个轴的方向", async () => {
    const f = fixture();
    const hud = await f.handlePromise;
    f.tick();
    const points = hud.screenPoints("pane-0");
    expect(points.length).toBe(6);
    const target = points.find((p) => p.head.axis === "x" && p.head.sign === 1)!;
    expect(hud.hit("pane-0", target.screen)?.direction).toEqual([1, 0, 0]);
    // 空白处不命中
    expect(hud.hit("pane-0", { x: target.screen.x + 100, y: target.screen.y + 100 })).toBeNull();
    // 吸附返回新台架（距离不变）
    const snapped = hud.snapTarget("pane-0", target.screen, rig({ distance: 7 }));
    expect(snapped?.distance).toBe(7);
    expect(snapped?.azimuth).toBeCloseTo(Math.PI / 2, 12);
  });

  test("dispose 销毁部件、删层、并退订每帧更新", async () => {
    const f = fixture();
    const hud = await f.handlePromise;
    hud.layerIdFor("pane-0");
    expect(f.handlers().length).toBe(1);
    hud.dispose();
    expect(f.widgets[0]!.destroyed).toBe(1);
    expect(f.removed.length).toBe(1);
    expect(f.handlers().length).toBe(0);
    // dispose 之后不再复活
    expect(hud.layerIdFor("pane-0")).toBeNull();
    expect(f.layers.length).toBe(1);
  });
});

/**
 * 真实工厂的回归（**这条是 4 窗格下"从一格能看见别格的坐标轴"那个 bug 的守卫**）。
 *
 * 引擎里 `Entity`/`GraphNode` **没有** `layers`（只有 `RenderComponent` 这类组件有），
 * 所以层只能通过 `addComponent("render", { ..., layers: [...] })` 写进去；旧写法
 * `entity.layers = [layer.id]` 只是挂了个**没人读**的自有属性 → 12 个部件全留在默认的
 * World 层 → 每格相机（都含 World 层）把 4 个窗格的坐标轴全画出来。
 *
 * 假引擎把"写错的地方"也如实建模：实体上有个 `layers` 计数属性，**只要有人往它赋值就记一笔**，
 * 测试断言那一笔是 0。
 */
describe("真实部件工厂：层写在 render 组件上（不是实体上）", () => {
  interface FakeNode {
    name: string;
    enabled: boolean;
    children: FakeNode[];
    componentData: { type: string; layers?: number[] }[];
    render: { material?: unknown; meshInstances: { pick: boolean }[] } | null;
    layerWrites: number;
  }

  function fakeEngine() {
    const nodes: FakeNode[] = [];
    const layersSeen = new Set<number>();
    class Entity {
      name: string;
      enabled = true;
      children: FakeNode[] = [];
      componentData: { type: string; layers?: number[] }[] = [];
      render: FakeNode["render"] = null;
      layerWrites = 0;
      constructor(name = "") {
        this.name = name;
        nodes.push(this as unknown as FakeNode);
      }
      addComponent(type: string, data: Record<string, unknown> = {}) {
        const record = { type, layers: data.layers as number[] | undefined };
        this.componentData.push(record);
        for (const id of record.layers ?? []) layersSeen.add(id);
        this.render = { material: data.material, meshInstances: [{ pick: true }] };
        return this.render;
      }
      addChild(child: Entity) { this.children.push(child as unknown as FakeNode); }
      setLocalPosition() {}
      setLocalScale() {}
      setPosition() {}
      destroy() {}
      /** 谁要是写 `entity.layers = [...]`，这里记一笔（引擎里那是个没人读的自有属性）。 */
      set layers(_value: number[]) { this.layerWrites += 1; }
      get layers() { return [] as number[]; }
    }
    class StandardMaterial {
      useLighting = true; diffuse: unknown; emissive: unknown; opacity = 1; blendType = 0;
      update() {}
    }
    class Color { constructor(public r: number, public g: number, public b: number) {} }
    const added: unknown[] = [];
    const app = { root: { addChild: (child: unknown) => { added.push(child); } } };
    const pc = { Entity, StandardMaterial, Color, BLEND_NORMAL: 2 };
    return { pc, nodes, app, added, layersSeen };
  }

  test("12 个 render 部件，**每一个**都带 layers:[本格层 id]；没有任何一处写 entity.layers", () => {
    const f = fakeEngine();
    const layer: AxisHudLayer = { id: 31, layer: {} };
    const widget = createAxisHudWidget(f.pc as never, f.app, "pane-0", layer);

    const renderNodes = f.nodes.filter((node) => node.componentData.length > 0);
    // 6 条色条 + 6 个轴球；根节点不建 render 组件（它只是个 transform 挂点）
    expect(renderNodes.length).toBe(12);
    for (const node of renderNodes) {
      expect(node.componentData[0]!.layers).toEqual([31]);
    }
    // 整棵树里没有一处往实体上写 layers（旧写法；引擎不读它）
    expect(f.nodes.reduce((sum, node) => sum + node.layerWrites, 0)).toBe(0);
    expect([...f.layersSeen]).toEqual([31]);

    // 挂到 root 上，并且是那棵树（不是别的东西）
    expect(f.added).toEqual([f.nodes[0]!]);
    // 部件不可拾取（拾取只走 Picker + 核心层）
    const meshes = f.nodes.flatMap((node) => node.render?.meshInstances ?? []);
    expect(meshes.length).toBe(12);
    expect(meshes.every((instance) => instance.pick === false)).toBe(true);

    // setVisible / destroy 的接线没坏
    widget.setVisible(false);
    expect(f.nodes[0]!.enabled).toBe(false);
  });

  test("换一层 → 部件落在新的那一层（层 id 不是写死的）", () => {
    const f = fakeEngine();
    createAxisHudWidget(f.pc as never, f.app, "pane-3", { id: 37, layer: {} });
    expect([...f.layersSeen]).toEqual([37]);
  });
});

