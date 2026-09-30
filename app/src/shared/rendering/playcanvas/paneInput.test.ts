import { describe, expect, test } from "bun:test";
import {
  fitDistance, MAX_DISTANCE, MIN_POLAR, ORTHO_VIEW_WORLD_HEIGHT, rigPosition, type CameraRig,
} from "../../../shared/lib/cameraRig";
import {
  applyDrag, applyWheel, attachPanePointerInput, CLICK_SLOP_PX, DOUBLE_CLICK_MS, dragKindForButton,
  focusRig, focusRigWithTarget, normalizeWheelPx, paneAt, paneSpecAt, PaneGestureRouter,
  WHEEL_LINE_HEIGHT_PX, worldHeightAtTarget, ZOOM_RATE_PER_PX, type PaneInputHost, type PaneInputSpec,
} from "./paneInput";

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10, fov: 60, projection: "perspective", ...over,
});

const PANES: PaneInputSpec[] = [
  { id: "pane-0", viewport: { left: 0, top: 0, width: 400, height: 300 } },
  { id: "pane-1", viewport: { left: 400, top: 0, width: 400, height: 300 } },
];

/** 可控时钟：双击判定要测"超时"这条否定分支，不能真等 400ms。 */
function fixture(panes: readonly PaneInputSpec[] = PANES, clock = { t: 0 }) {
  const rigs = new Map<string, CameraRig>(panes.map((pane) => [pane.id, rig()]));
  const writes: { paneId: string; rig: CameraRig }[] = [];
  const clicks: { paneId: string; x: number; y: number }[] = [];
  let interactions = 0;
  const host: PaneInputHost = {
    panes: () => panes,
    getRig: (paneId) => rigs.get(paneId) ?? null,
    setRig: (paneId, next) => { rigs.set(paneId, next); writes.push({ paneId, rig: next }); },
    focusTarget: () => ({ center: [1, 2, 3], radius: 2 }),
    onClick: (paneId, point) => { clicks.push({ paneId, x: point.x, y: point.y }); },
    onInteraction: () => { interactions += 1; },
  };
  const router = new PaneGestureRouter(host, () => clock.t);
  return { host, rigs, writes, router, clicks, interactions: () => interactions, clock };
}

/** 一次完整的左键拖动：按下 → 若干步移动 → 抬起。 */
function drag(router: PaneGestureRouter, from: [number, number], to: [number, number], steps = 4, pointerId = 1) {
  router.start(from[0], from[1], pointerId, 0);
  for (let step = 1; step <= steps; step += 1) {
    router.move(pointerId, from[0] + ((to[0] - from[0]) * step) / steps, from[1] + ((to[1] - from[1]) * step) / steps);
  }
  return router.end(pointerId);
}

/** 一次点击（按下即抬起，无位移）。 */
function click(router: PaneGestureRouter, x: number, y: number, pointerId = 1) {
  router.start(x, y, pointerId, 0);
  return router.end(pointerId);
}

describe("命中测试", () => {
  test("指针落在正确的窗格：左闭右开，相邻窗格共享的边只属于前一个", () => {
    expect(paneAt(PANES, 0, 0)).toBe("pane-0");
    expect(paneAt(PANES, 399.9, 299.9)).toBe("pane-0");
    expect(paneAt(PANES, 400, 0)).toBe("pane-1");
    expect(paneAt(PANES, 799, 299)).toBe("pane-1");
    // 窗外
    expect(paneAt(PANES, -1, 10)).toBeNull();
    expect(paneAt(PANES, 800, 10)).toBeNull();
    expect(paneAt(PANES, 10, 300)).toBeNull();
  });

  test("尺寸为 0 的窗格不参与命中（首帧/隐藏的分页还没有尺寸）", () => {
    const zero: PaneInputSpec[] = [{ id: "pane-0", viewport: { left: 0, top: 0, width: 0, height: 0 } }];
    expect(paneAt(zero, 0, 0)).toBeNull();
    // 同一个命中逻辑的"返回整条 spec"形式（路由用它拿窗格高）
    expect(paneSpecAt(PANES, 10, 10)).toBe(PANES[0]!);
    expect(paneSpecAt(PANES, 500, 10)).toBe(PANES[1]!);
  });

  test("鼠标键映射：左键转、中键缩放、右键平移，其它键不受理", () => {
    expect(dragKindForButton(0)).toBe("orbit");
    expect(dragKindForButton(1)).toBe("dolly");
    expect(dragKindForButton(2)).toBe("pan");
    expect(dragKindForButton(3)).toBeNull();
    expect(dragKindForButton(4)).toBeNull();
  });
});

describe("滚轮归一化", () => {
  test("像素/行/页三种 deltaMode 都折成 CSS px", () => {
    expect(normalizeWheelPx(-100, 0, 300)).toBe(-100);
    expect(normalizeWheelPx(3, 1, 300)).toBe(3 * WHEEL_LINE_HEIGHT_PX);
    // 一页 = 一个窗格高
    expect(normalizeWheelPx(1, 2, 300)).toBe(300);
    // 窗格高度还没量到时退回一行，不能算出 0（否则滚轮静默失效）
    expect(normalizeWheelPx(1, 2, 0)).toBe(WHEEL_LINE_HEIGHT_PX);
  });

  test("非有限的 deltaY 归零", () => {
    expect(normalizeWheelPx(Number.NaN, 0, 300)).toBe(0);
    expect(normalizeWheelPx(Number.POSITIVE_INFINITY, 0, 300)).toBe(0);
  });
});

describe("拖动 → 台架", () => {
  test("世界高度：透视 2·d·tan(fov/2)，正交恒为 15 且与距离无关", () => {
    expect(worldHeightAtTarget(rig({ distance: 10, fov: 60 }))).toBeCloseTo(20 * Math.tan(Math.PI / 6), 12);
    expect(worldHeightAtTarget(rig({ projection: "orthographic", distance: 3 }))).toBe(ORTHO_VIEW_WORLD_HEIGHT);
    expect(worldHeightAtTarget(rig({ projection: "orthographic", distance: 5000 }))).toBe(ORTHO_VIEW_WORLD_HEIGHT);
  });

  test("轨道：拖满一个窗格高度 = 一整圈；向右拖方位角减小、向下拖极角减小", () => {
    const perHeight = (2 * Math.PI) / 500;
    expect(applyDrag(rig(), "orbit", 100, 0, 500).azimuth).toBeCloseTo(-100 * perHeight, 12);
    expect(applyDrag(rig(), "orbit", 0, 100, 500).polar).toBeCloseTo(Math.PI / 2 - 100 * perHeight, 12);
    // 极角被钳在开区间内（俯视到正上方会与 up 共线）
    expect(applyDrag(rig(), "orbit", 0, 5000, 500).polar).toBe(MIN_POLAR);
  });

  test("轨道方向：向右拖把相机绕到 -X 侧（画面上的物体跟着手向右转）", () => {
    const moved = applyDrag(rig({ azimuth: 0 }), "orbit", 100, 0, 500);
    expect(moved.azimuth).toBeLessThan(0);
    expect(rigPosition(moved)[0]).toBeLessThan(0);
    // 机位距离不变（纯旋转）
    expect(moved.distance).toBe(10);
  });

  test("平移：像素按窗格高换算成世界位移，只动目标点", () => {
    const moved = applyDrag(rig(), "pan", 100, 0, 500);
    expect(moved.target[0]).toBeCloseTo(-100 * (worldHeightAtTarget(rig()) / 500), 9);
    expect(moved.target[1]).toBeCloseTo(0, 12);
    expect([moved.azimuth, moved.polar, moved.distance]).toEqual([0, Math.PI / 2, 10]);
  });

  test("平移：正交窗格按 15 个世界单位换算，而不是 fov（同一台架数值差一倍）", () => {
    const ortho = rig({ projection: "orthographic" });
    expect(applyDrag(ortho, "pan", 100, 0, 500).target[0]).toBeCloseTo(-100 * (ORTHO_VIEW_WORLD_HEIGHT / 500), 12);
    expect(applyDrag(rig(), "pan", 100, 0, 500).target[0]).not.toBeCloseTo(-100 * (ORTHO_VIEW_WORLD_HEIGHT / 500), 3);
  });

  test("平移：窗格自己的 up 会透传（俯视窗格传 (0,0,-1) 得到不同的方向）", () => {
    const tilted = rig({ azimuth: 0.3, polar: 0.7 });
    expect(applyDrag(tilted, "pan", 100, 0, 500).target[1]).toBeCloseTo(0, 12);
    expect(applyDrag(tilted, "pan", 100, 0, 500, [0, 0, -1]).target[1]).not.toBeCloseTo(0, 6);
  });

  test("中键纵向拖动：向下退远、向上靠近，并钳在距离上下限", () => {
    expect(applyDrag(rig({ distance: 10 }), "dolly", 0, 100, 500).distance).toBeCloseTo(12.5, 10);
    expect(applyDrag(rig({ distance: 10 }), "dolly", 0, -100, 500).distance).toBeCloseTo(8, 10);
    expect(applyDrag(rig({ distance: MAX_DISTANCE }), "dolly", 0, 4000, 500).distance).toBe(MAX_DISTANCE);
  });

  test("零高度窗格不产生任何位移（首帧、隐藏分页）", () => {
    for (const kind of ["orbit", "pan", "dolly"] as const) {
      const result = applyDrag(rig(), kind, 50, 50, 0);
      expect(result.azimuth).toBe(0);
      expect(result.distance).toBe(10);
      expect(result.target).toEqual([0, 0, 0]);
    }
  });
});

describe("滚轮缩放", () => {
  test("向上滚变近、向下滚变远；100 px ≈ ×0.8 / ×1.25", () => {
    expect(applyWheel(rig({ distance: 10 }), -100).distance).toBeCloseTo(8, 9);
    expect(applyWheel(rig({ distance: 10 }), 100).distance).toBeCloseTo(12.5, 9);
    // 多格可加：两格 −50px 等于一格 −100px
    const twice = applyWheel(applyWheel(rig({ distance: 10 }), -50), -50);
    expect(twice.distance).toBeCloseTo(8, 9);
  });

  test("正交窗格滚轮不动：可见高度是产品常量，缩放会破坏它", () => {
    const ortho = rig({ projection: "orthographic" });
    expect(applyWheel(ortho, -100)).toBe(ortho);
    expect(applyWheel(ortho, 100)).toBe(ortho);
  });

  test("非法倍率不动（NaN 会污染整个台架状态）", () => {
    expect(applyWheel(rig(), Number.NaN).distance).toBe(10);
    expect(applyWheel(rig(), Number.POSITIVE_INFINITY).distance).toBe(10);
    // 速率常量必须是正的有限值，否则滚轮方向会反
    expect(ZOOM_RATE_PER_PX).toBeGreaterThan(0);
  });
});

describe("聚焦", () => {
  test("透视：目标点移到球心、距离按包围球；正交：只挪目标点，距离不动", () => {
    const perspective = focusRig(rig(), [3, 1, -2], 2);
    expect(perspective.target).toEqual([3, 1, -2]);
    expect(perspective.distance).toBeCloseTo(fitDistance(2, 60), 9);

    const ortho = focusRig(rig({ projection: "orthographic", distance: 42 }), [3, 1, -2], 2);
    expect(ortho.target).toEqual([3, 1, -2]);
    expect(ortho.distance).toBe(42);
  });

  test("聚焦的 target 是拷贝：调用方改原数组不影响台架", () => {
    const center: [number, number, number] = [1, 2, 3];
    const focused = focusRig(rig(), center, 2);
    center[0] = 99;
    expect(focused.target).toEqual([1, 2, 3]);
  });

  test("offset 口径（three 侧双击聚焦的 (3,2,3)）：距离=|offset|，方位角/极角由偏移方向给出", () => {
    const focused = focusRigWithTarget(rig(), { center: [1, 2, 3], offset: [3, 2, 3] });
    expect(focused.target).toEqual([1, 2, 3]);
    expect(focused.distance).toBeCloseTo(Math.hypot(3, 2, 3), 12);
    expect(focused.azimuth).toBeCloseTo(Math.PI / 4, 12);          // atan2(3, 3)
    expect(focused.polar).toBeCloseTo(Math.atan2(Math.hypot(3, 3), 2), 12);
    // 与物体大小无关：换一个半径（口径里没有半径）结果一样
    expect(focusRigWithTarget(rig(), { center: [1, 2, 3], offset: [3, 2, 3] })).toEqual(focused);
  });

  test("offset 口径的三个退化分支：零偏移、极角钳制、正交只挪目标点", () => {
    // 零偏移：不动朝向（会算出 NaN）
    const zero = focusRigWithTarget(rig(), { center: [4, 5, 6], offset: [0, 0, 0] });
    expect(zero.target).toEqual([4, 5, 6]);
    expect([zero.azimuth, zero.polar, zero.distance]).toEqual([0, Math.PI / 2, 10]);
    // 正上方：极角被钳到 MIN_POLAR，不与 up 共线
    const top = focusRigWithTarget(rig(), { center: [0, 0, 0], offset: [0, 5, 0] });
    expect(top.polar).toBe(MIN_POLAR);
    // 正交窗格：不改朝向、不改距离（three 侧的双击飞行只挂透视窗格）
    const ortho = focusRigWithTarget(rig({ projection: "orthographic", distance: 42 }), { center: [7, 8, 9], offset: [3, 2, 3] });
    expect(ortho.target).toEqual([7, 8, 9]);
    expect([ortho.azimuth, ortho.polar, ortho.distance]).toEqual([0, Math.PI / 2, 42]);
  });

  test("radius 口径仍走 fitDistance（两种口径并存）", () => {
    const focused = focusRigWithTarget(rig(), { center: [3, 1, -2], radius: 2 });
    expect(focused.distance).toBeCloseTo(fitDistance(2, 60), 12);
  });
});

describe("手势路由", () => {
  test("按下只受理落在窗格内、且有台架的指针", () => {
    const { router } = fixture();
    expect(router.start(10, 10, 1, 0)).toBe("pane-0");
    router.cancel();
    // 窗外
    expect(router.start(900, 10, 1, 0)).toBeNull();
    // 不受理的键
    expect(router.start(10, 10, 1, 3)).toBeNull();
    // 已有手势时第二个指针不参与
    expect(router.start(10, 10, 1, 0)).toBe("pane-0");
    expect(router.start(500, 10, 2, 0)).toBeNull();
  });

  test("没有台架的窗格不受理（相机还没建好）", () => {
    const f = fixture();
    const router = new PaneGestureRouter({ ...f.host, getRig: () => null }, () => 0);
    expect(router.start(10, 10, 1, 0)).toBeNull();
  });

  test("拖动只改被按下的那一格：多窗格各自输入的核心断言", () => {
    const { rigs, writes, router } = fixture();
    drag(router, [100, 100], [180, 140]);
    expect(writes.every((w) => w.paneId === "pane-0")).toBe(true);
    expect(rigs.get("pane-1")).toEqual(rig());
    expect(rigs.get("pane-0")!.azimuth).not.toBe(0);
    // 右键拖动落到另一格，只改那一格
    router.start(500, 100, 3, 2);
    router.move(3, 540, 100);
    router.end(3);
    expect(writes.at(-1)!.paneId).toBe("pane-1");
    expect(rigs.get("pane-1")!.target).not.toEqual([0, 0, 0]);
  });

  test("拖动平移会把窗格自己的 up 传给 panBy（俯视窗格用 (0,0,-1)）", () => {
    const make = (paneUp?: () => [number, number, number]) => {
      const f = fixture();
      f.rigs.set("pane-0", rig({ azimuth: 0.3, polar: 0.7 }));
      if (paneUp) f.host.paneUp = paneUp;
      f.router.start(10, 10, 1, 2); // 右键 = 平移
      f.router.move(1, 60, 10);
      return f.rigs.get("pane-0")!;
    };
    // 世界 +Y 做 up：横向拖动没有竖直分量
    expect(Math.abs(make().target[1])).toBeLessThan(1e-9);
    // 俯视窗格的 up 是 -Z：同一个拖动会带出俯仰分量——这正是透传生效的标志
    expect(Math.abs(make(() => [0, 0, -1]).target[1])).toBeGreaterThan(1e-6);
  });

  test("只有匹配的 pointerId 能推动手势", () => {
    const { writes, router } = fixture();
    router.start(10, 10, 7, 0);
    expect(router.move(8, 100, 100)).toBe(false);
    expect(writes.length).toBe(0);
    expect(router.move(7, 100, 100)).toBe(true);
    expect(writes.length).toBe(1);
  });

  test("布局中途变化（窗格消失 / 高度归零）时自动收手，不再写台架", () => {
    const panes: PaneInputSpec[] = [...PANES];
    const { router, writes } = fixture(panes);
    router.start(10, 10, 1, 0);
    router.move(1, 60, 10);
    expect(writes.length).toBe(1);
    panes[0] = { id: "pane-0", viewport: { left: 0, top: 0, width: 400, height: 0 } };
    router.move(1, 90, 10);
    expect(writes.length).toBe(1);
    expect(router.active()).toBeNull();
  });

  test("pointercancel 收手，且不计入点击（不会被误判成双击的前半）", () => {
    const clock = { t: 0 };
    const { router, writes } = fixture(PANES, clock);
    router.start(10, 10, 1, 0);
    router.cancel();
    expect(router.active()).toBeNull();
    clock.t = DOUBLE_CLICK_MS - 1;
    click(router, 10, 10);
    expect(writes.filter((w) => w.rig.distance !== 10).length).toBe(0);
  });

  test("双击：同一格、位移在容差内、间隔在窗口内 → 聚焦到包围球", () => {
    const clock = { t: 0 };
    const { router, writes } = fixture(PANES, clock);
    click(router, 100, 100);
    clock.t = DOUBLE_CLICK_MS;
    click(router, 100 + CLICK_SLOP_PX, 100);
    const focused = writes.at(-1)!;
    expect(focused.paneId).toBe("pane-0");
    expect(focused.rig.target).toEqual([1, 2, 3]);
    expect(focused.rig.distance).toBeCloseTo(fitDistance(2, 60), 9);
  });

  test("双击的三条否定分支：超时、跨窗格、位移超过容差", () => {
    const clock = { t: 0 };
    const stale = fixture(PANES, clock);
    click(stale.router, 100, 100);
    clock.t = DOUBLE_CLICK_MS + 1;
    click(stale.router, 100, 100);
    expect(stale.writes.length).toBe(0);

    const clock2 = { t: 0 };
    const across = fixture(PANES, clock2);
    click(across.router, 100, 100);
    clock2.t = 100;
    click(across.router, 500, 100);
    expect(across.writes.length).toBe(0);

    const clock3 = { t: 0 };
    const far = fixture(PANES, clock3);
    click(far.router, 100, 100);
    clock3.t = 100;
    click(far.router, 100 + CLICK_SLOP_PX + 1, 100);
    expect(far.writes.length).toBe(0);
  });

  test("拖动不会和后面的点击拼成双击，但两次真点击仍然算", () => {
    const clock = { t: 0 };
    const { router, writes } = fixture(PANES, clock);
    drag(router, [100, 100], [200, 200]); // 拖动：清掉点击记录
    const afterDrag = writes.length;
    expect(afterDrag).toBeGreaterThan(0); // 每一步移动都写了台架
    clock.t = 100;
    click(router, 200, 200);
    expect(writes.length).toBe(afterDrag); // 单击不聚焦
    clock.t = 200;
    click(router, 200, 200);
    expect(writes.length).toBe(afterDrag + 1);
    expect(writes.at(-1)!.rig.target).toEqual([1, 2, 3]);
  });

  test("没有聚焦目标时不写台架（比如空场景）", () => {
    const { router, writes, host } = fixture();
    host.focusTarget = () => null;
    click(router, 100, 100);
    click(router, 100, 100);
    expect(writes.length).toBe(0);
  });

  test("单击回调：只有左键、且没拖动过才触发，并带上点击位置（拾取挂这里）", () => {
    const { router, clicks } = fixture();
    // 拖动不算点击
    drag(router, [10, 10], [80, 40]);
    expect(clicks).toEqual([]);
    // 单击：带上当时的位置
    click(router, 120, 30);
    expect(clicks).toEqual([{ paneId: "pane-0", x: 120, y: 30 }]);
    // 右键点击不算
    router.start(300, 30, 1, 2);
    router.end(1);
    expect(clicks.length).toBe(1);
    // 落点仍在哪一格就报哪一格
    click(router, 500, 30);
    expect(clicks.at(-1)).toEqual({ paneId: "pane-1", x: 500, y: 30 });
  });

  test("被 gizmo 手柄接管时：按下不受理，拖动途中被接管也会立刻收手", () => {
    const f = fixture();
    let claimed = true;
    f.host.isPointerClaimed = () => claimed;
    // 按下就已被占用：不开始轨道手势
    expect(f.router.start(10, 10, 1, 0)).toBeNull();
    expect(f.writes).toEqual([]);
    // 按下时没占用、拖动途中被接管（手柄的 transform:start 可能晚于我们的 pointerdown）
    claimed = false;
    f.router.start(10, 10, 1, 0);
    f.router.move(1, 60, 10);
    expect(f.writes.length).toBe(1);
    claimed = true;
    f.router.move(1, 120, 10);
    expect(f.writes.length).toBe(1); // 不再写台架
    expect(f.router.active()).toBeNull(); // 手势已收手
  });

  test("onInteraction 只在真的会改画面的输入上触发", () => {
    const { router, interactions } = fixture();
    router.start(10, 10, 1, 0);
    expect(interactions()).toBe(1);
    router.move(1, 60, 10);
    expect(interactions()).toBe(2);
    router.end(1);
    router.wheel(10, 10, -100, 0);
    expect(interactions()).toBe(3);
    // 窗外滚轮什么也不做
    expect(router.wheel(900, 10, -100, 0)).toBeNull();
    expect(interactions()).toBe(3);

    // 正交窗格的滚轮是空操作：不该通知截图队列"让行"
    const ortho = fixture();
    ortho.rigs.set("pane-0", rig({ projection: "orthographic" }));
    expect(ortho.router.wheel(10, 10, -100, 0)).toBe("pane-0");
    expect(ortho.interactions()).toBe(0);
  });
});

describe("DOM 绑定（happy-dom）", () => {
  function makeCanvas(width = 800, height = 300) {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }),
    });
    return canvas;
  }

  const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
    new PointerEvent(type, { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, bubbles: true, cancelable: true, ...init });

  function attached() {
    const canvas = makeCanvas();
    const f = fixture();
    const handle = attachPanePointerInput(canvas, { ...f.host });
    return { canvas, ...f, handle };
  }

  test("在窗格上按下、在 window 上移动：改的是那一格，pointerup 在画布外也不会粘住", () => {
    const { canvas, rigs, handle } = attached();
    canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
    expect(handle.active()!.paneId).toBe("pane-0");
    // 指针移出画布：事件落在 window 上（捕获 + window 监听两条路都要能收到）
    window.dispatchEvent(pointer("pointermove", 200, 100));
    expect(rigs.get("pane-0")!.azimuth).not.toBe(0);
    expect(rigs.get("pane-1")).toEqual(rig());
    // 在画布外抬手（不是画布上的 pointerup）
    window.dispatchEvent(pointer("pointerup", 900, 400, { button: 0, buttons: 0 }));
    expect(handle.active()).toBeNull();
    const azimuth = rigs.get("pane-0")!.azimuth;
    window.dispatchEvent(pointer("pointermove", 400, 100));
    expect(rigs.get("pane-0")!.azimuth).toBe(azimuth); // 粘住的话这里会变
    handle.detach();
  });

  test("setPointerCapture 抛错（合成事件里 pointerId 不是活动指针）不影响拖动", () => {
    const { canvas, rigs, handle } = attached();
    canvas.setPointerCapture = () => { throw new Error("NotFoundError"); };
    canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
    window.dispatchEvent(pointer("pointermove", 180, 100));
    window.dispatchEvent(pointer("pointerup", 180, 100));
    expect(rigs.get("pane-0")!.azimuth).not.toBe(0);
    expect(handle.active()).toBeNull();
    handle.detach();
  });

  test("wheel 以 { passive: false } 注册，并且取消默认行为", () => {
    const canvas = makeCanvas();
    const registered: [string, unknown][] = [];
    const original = canvas.addEventListener.bind(canvas);
    canvas.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      registered.push([type, options]);
      return original(type, listener, options as never);
    }) as typeof canvas.addEventListener;
    const f = fixture();
    const handle = attachPanePointerInput(canvas, { ...f.host });
    const wheel = registered.find(([type]) => type === "wheel");
    expect(wheel).toBeDefined();
    // passive: true 会让 preventDefault() 静默失效（页面跟着滚），这条断言守住它
    expect(wheel![1]).toEqual({ passive: false });

    const event = new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, bubbles: true, cancelable: true });
    // happy-dom 的 WheelEvent 不接 `clientX/clientY`（真实浏览器按 MouseEvent 继承，会接），
    // 所以这里补上——否则坐标是 undefined，命中测试必然落空
    Object.defineProperty(event, "clientX", { value: 100 });
    Object.defineProperty(event, "clientY", { value: 100 });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(f.rigs.get("pane-0")!.distance).toBeCloseTo(8, 9);
    expect(f.rigs.get("pane-1")).toEqual(rig());
    handle.detach();
  });

  test("右键菜单只在窗格上被取消（右键留给平移，但不吞掉别处的菜单）", () => {
    const { canvas, handle } = attached();
    const overPane = new MouseEvent("contextmenu", { clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    canvas.dispatchEvent(overPane);
    expect(overPane.defaultPrevented).toBe(true);
    const outside = new MouseEvent("contextmenu", { clientX: 100, clientY: 299 + 1, bubbles: true, cancelable: true });
    canvas.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
    handle.detach();
  });

  test("pointercancel / 失焦中途收手", () => {
    const { canvas, handle } = attached();
    canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
    canvas.dispatchEvent(pointer("pointercancel", 150, 100));
    expect(handle.active()).toBeNull();

    canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
    window.dispatchEvent(new Event("blur"));
    expect(handle.active()).toBeNull();
    handle.detach();
  });

  test("detach 之后事件不再被处理", () => {
    const { canvas, rigs, handle } = attached();
    handle.detach();
    canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
    window.dispatchEvent(pointer("pointermove", 200, 100));
    window.dispatchEvent(pointer("pointerup", 200, 100));
    expect(rigs.get("pane-0")).toEqual(rig());
    expect(handle.active()).toBeNull();
  });

  test("两次真实点击（在画布上）触发聚焦——不依赖被 pointerdown 抑制的 dblclick 事件", () => {
    const { canvas, rigs, handle } = attached();
    for (let i = 0; i < 2; i += 1) {
      canvas.dispatchEvent(pointer("pointerdown", 100, 100, { button: 0, buttons: 1 }));
      canvas.dispatchEvent(pointer("pointerup", 100, 100, { button: 0, buttons: 0 }));
    }
    expect(rigs.get("pane-0")!.target).toEqual([1, 2, 3]);
    expect(rigs.get("pane-0")!.distance).toBeCloseTo(fitDistance(2, 60), 9);
    handle.detach();
  });
});
