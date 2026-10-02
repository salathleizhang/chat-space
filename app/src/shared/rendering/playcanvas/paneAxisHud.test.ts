import { describe, expect, test } from "bun:test";
import type { CameraRig } from "../../../shared/lib/cameraRig";
import {
  AXIS_HEADS, createPaneAxisHud, HALF_SIZE_PX, headWorldPositions, HUD_DEPTH, hudPlacement,
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
