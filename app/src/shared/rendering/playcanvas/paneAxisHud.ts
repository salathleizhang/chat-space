import type { CameraRig, Vec3 } from "../../../shared/lib/cameraRig";

/**
 * 屏幕等大的**坐标轴球 HUD**：三根轴向色条 + 六个轴球，钉在窗格右上角，尺寸不随机位/距离变化。
 * 对应 three 侧 `widgets/Viewport/PaneCamera.tsx` 的 `CameraAxes` / `PaneGizmo`
 * （`GIZMO_SCALE = 40`、`GIZMO_MARGIN_PX = 64`、点击轴球把机位吸附过去）。
 *
 * ### 实现路线：**不加相机**
 * three 侧是"给每格再开一台像素正交相机 + 把 HUD 组放在 (w/2-64, h/2-64)"。PlayCanvas 里那样做
 * 要么多开 4 台 HUD 相机（`startRenderPass` 的验收线要重新谈），要么自己算正交投影。这里改成：
 * **把部件放在相机前方固定深度、按"一个像素等于多少世界单位"缩放**，于是
 * - 屏幕等大：`scale = worldPerPixel × 半个部件的像素半径`；
 * - 位置：`camPos + right·(dx·worldPerPixel) + up·(dy·worldPerPixel) + forward·(-depth)`；
 * - 朝向：**不旋转**（世界轴）——相机绕它转，看到的自然就是"世界轴相对当前视线"的方向。
 *
 * ### 四条约束
 * ① HUD 层必须 `clearDepthBuffer: true`（永远画在世界之上），并且**要进 `PaneSpec.extraLayerIds`**
 *    （`PaneRegistry.sync()` 会重写 `camera.layers`，见 §三之七）。
 * ② **不加相机**：部件靠上面的换算定位，每帧只更新一个实体的 transform（几个向量运算）。
 * ③ 命中用**屏幕空间**（把 6 个轴球投回屏幕、按像素半径判），不要去射线求交——简单、可单测。
 * ④ 轴球点击要**先于拾取**：命中轴球时既不能开始轨道手势（输入层的 `isPointerClaimed`），
 *    也不能把它当成"点选物体"（`onClick` 里先问 HUD）。
 *
 * ### 刻意没做
 * - **trackball 自由旋转**（three 侧 `GizmoTrackballHandle`）：它要绕任意轴旋转相机、相机会带滚转，
 *   而当前台架是 turntable（只有方位角/极角，`up` 固定）。要做得先扩台架模型——**有意差异**，不是漏做。
 * - **轴球上的字母**（three 侧画在 canvas 纹理上）：只做颜色区分。
 * - **吸附动画**：three 侧按 `SNAP_TURN_RATE` 缓动，这里**立即到位**（与聚焦同理，动画属渲染循环那一步）。
 */

/** 三根轴的配色，取自 three 侧 `PaneCamera.tsx` 的 `AXIS_COLORS`。 */
export const AXIS_COLORS = { x: [0.898, 0.42, 0.42], y: [0.42, 0.796, 0.467], z: [0.302, 0.561, 0.898] } as const;

/** 一个轴球：方向 = 轴向 × 正负号。六个（每轴两个）。 */
export interface AxisHead {
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  direction: Vec3;
  color: readonly [number, number, number];
}

export const AXIS_HEADS: readonly AxisHead[] = (["x", "y", "z"] as const).flatMap((axis) =>
  ([1, -1] as const).map((sign) => {
    const direction: Vec3 = [0, 0, 0];
    direction["xyz".indexOf(axis)] = sign;
    return { axis, sign, direction, color: AXIS_COLORS[axis] };
  }));

/** 部件尺寸（"单位"空间）：轴球在 ±1，色条 0.15→0.85。 */
export const HEAD_RADIUS = 0.14;
export const NEGATIVE_HEAD_SCALE = 0.75;
export const BAR_INNER = 0.15;
export const BAR_OUTER = 0.85;
/** 部件在屏幕上的**半**边长（像素）：`GIZMO_SCALE = 40` ⇒ 直径 80 px。 */
export const HALF_SIZE_PX = 40;
/** 距窗格右上角的边距（像素）。 */
export const MARGIN_PX = 64;
/** 点击轴球的命中半径（像素）：轴球半径 + 一点余量。 */
export const HEAD_HIT_RADIUS_PX = 22;
/** 部件放在相机前方多远（世界单位）。近裁剪面远小于它，所以不会被裁掉。 */
export const HUD_DEPTH = 1;

/**
 * 引擎的 `PROJECTION_ORTHOGRAPHIC`（`scene/constants.js` 里就是 `1`）。
 * 写成常量而不是动态导入引擎：`hudPlacement()` 这一层是纯逻辑，单测不该依赖引擎模块。
 */
export const PROJECTION_ORTHOGRAPHIC_VALUE = 1;

export interface HudCameraLike {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  fov: number;
  projection: "perspective" | "orthographic";
  orthoHeight: number;
}

export interface HudPlacementInput {
  camera: HudCameraLike;
  /** 窗格像素尺寸（CSS px）。 */
  paneWidth: number;
  paneHeight: number;
  depth?: number;
  halfSizePx?: number;
  marginPx?: number;
}

/**
 * 算出部件该放哪、缩放多少。
 *
 * `worldPerPixel`：透视是 `2·depth·tan(fov/2)/窗格高`，正交是 `2·orthoHeight/窗格高`
 * （正交的可见高度是常量，与距离无关）。像素偏移以**窗格中心**为原点、**向上为正**。
 */
export function hudPlacement(input: HudPlacementInput): { position: Vec3; scale: number; worldPerPixel: number } {
  const { camera, paneWidth, paneHeight } = input;
  const depth = input.depth ?? HUD_DEPTH;
  const halfSizePx = input.halfSizePx ?? HALF_SIZE_PX;
  const marginPx = input.marginPx ?? MARGIN_PX;
  const worldPerPixel = camera.projection === "orthographic"
    ? (2 * camera.orthoHeight) / Math.max(paneHeight, 1)
    : (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(paneHeight, 1);
  // 窗格右上角内缩一个边距；相机空间里 +x 向右、+y 向上
  const offsetX = paneWidth / 2 - marginPx;
  const offsetY = paneHeight / 2 - marginPx;
  // `GraphNode.forward` 就是**看向的方向**（世界 -Z 轴，`graph-node.js:96-101`），
  // 所以"相机前方 depth"是 `+ forward × depth`；`right`/`up` 同样是世界空间单位向量。
  const position: Vec3 = [
    camera.position[0] + camera.right[0] * offsetX * worldPerPixel + camera.forward[0] * depth,
    camera.position[1] + camera.right[1] * offsetX * worldPerPixel + camera.forward[1] * depth,
    camera.position[2] + camera.right[2] * offsetX * worldPerPixel + camera.forward[2] * depth,
  ];
  // 再叠上竖直方向的偏移
  position[0] += camera.up[0] * offsetY * worldPerPixel;
  position[1] += camera.up[1] * offsetY * worldPerPixel;
  position[2] += camera.up[2] * offsetY * worldPerPixel;
  return { position, scale: worldPerPixel * halfSizePx, worldPerPixel };
}

/** 轴球的世界位置（部件不旋转，所以就是"中心 + 方向 × 半径"）。 */
export function headWorldPositions(center: Vec3, scale: number): { head: AxisHead; position: Vec3 }[] {
  return AXIS_HEADS.map((head) => ({
    head,
    position: [
      center[0] + head.direction[0] * scale,
      center[1] + head.direction[1] * scale,
      center[2] + head.direction[2] * scale,
    ],
  }));
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** 屏幕空间命中：返回最近的、落在 `radiusPx` 内的轴球；没有就 null。 */
export function pickAxisHead(
  points: readonly { head: AxisHead; screen: ScreenPoint }[],
  pointer: ScreenPoint,
  radiusPx: number = HEAD_HIT_RADIUS_PX,
): AxisHead | null {
  let best: { head: AxisHead; distance: number } | null = null;
  for (const point of points) {
    const distance = Math.hypot(point.screen.x - pointer.x, point.screen.y - pointer.y);
    if (distance > radiusPx) continue;
    if (!best || distance < best.distance) best = { head: point.head, distance };
  }
  return best?.head ?? null;
}

/**
 * 点击某个轴球之后的机位：**距离与目标点都不变**，只把方位角/极角摆到"从那一侧看过去"。
 * 与 three 侧的 `snapTo` 同效（那边是四元数缓动，这里是立即到位）。
 * 正交窗格的朝向同样有意义（可见范围是常量，改的是观察方向）。
 */
export function rigForAxisSnap(rig: CameraRig, direction: Vec3): CameraRig {
  const [dx, dy, dz] = direction;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-6) {
    // 正上/正下：极角被钳到开区间，方位角保持原样（否则 atan2(0,0) 无意义）
    return { ...rig, polar: dy >= 0 ? 0.01 : Math.PI - 0.01 };
  }
  const polar = Math.atan2(horizontal, dy);
  return {
    ...rig,
    azimuth: Math.atan2(dx, dz),
    polar: Math.min(Math.max(polar, 0.01), Math.PI - 0.01),
  };
}

/** 部件的引擎绑定只需这两个动作（测试注入点）。 */
export interface AxisWidgetLike {
  setTransform(position: Vec3, scale: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export interface AxisHudLayer {
  id: number;
  layer: unknown;
}

export interface PaneAxisHudOptions {
  /** 建 HUD 层（`Gizmo.createLayer` 那套：`clearDepthBuffer: true` + `SORTMODE_NONE`）。 */
  createLayer(paneId: string): AxisHudLayer;
  /** **必须自己删层**（同 gizmo：引擎的 destroy 不管层）。 */
  removeLayer(layer: AxisHudLayer): void;
  cameraFor(paneId: string): unknown | null;
  /** 该窗格当前的 CSS px 视口；没有尺寸的帧不更新（首帧/隐藏分页）。 */
  paneRectFor(paneId: string): { width: number; height: number } | null;
  /** 测试注入点。 */
  createWidget?(paneId: string, layer: AxisHudLayer): AxisWidgetLike;
}

export interface PaneAxisHudHandle {
  /**
   * 该窗格的 HUD 层 id——**交给 `PaneSpec.extraLayerIds`**。
   * 第一次调用会**顺带把这一格的部件建出来**（集成层就是"问一次层 id、再填进 pane spec"这个顺序）。
   */
  layerIdFor(paneId: string): number | null;
  /** 六个轴球当前的**画布局部 CSS px** 位置（命中与探针共用同一份）。 */
  screenPoints(paneId: string): { head: AxisHead; screen: ScreenPoint }[];
  hit(paneId: string, point: ScreenPoint): AxisHead | null;
  /** 命中轴球就返回吸附后的台架；没命中返回 null（调用方决定要不要写回）。 */
  snapTarget(paneId: string, point: ScreenPoint, rig: CameraRig): CameraRig | null;
  /** 当前部件中心的世界坐标（诊断用）。 */
  centerOf(paneId: string): Vec3 | null;
  /** 显隐某一格的 HUD（探针用它做"只摘这一格"的逐格像素对比）。 */
  setVisible(paneId: string, visible: boolean): void;
  dispose(): void;
}

interface CameraComponentLike {
  camera?: unknown;
  fov?: number;
  projection?: number;
  orthoHeight?: number;
  worldToScreen?(point: unknown): { x: number; y: number };
}

interface CameraEntityLike {
  camera?: CameraComponentLike;
  getPosition(): { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
}

interface PaneEntry {
  layer: AxisHudLayer;
  widget: AxisWidgetLike;
  center: Vec3;
  scale: number;
}

const toVec3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

/**
 * 建一份**逐窗格**的坐标轴球 HUD：每种窗格一个部件、一层，每帧只更新一次 transform。
 *
 * 方向约定沿用 `applyRig` 那套：透视窗格的 `up` 是窗格自己的 up（俯视窗格是 `(0,0,-1)`），
 * 所以 HUD 的"上"与世界 +Y 不一定一致——这是**对的**：它表达的是"当前这个窗格看到的轴向"。
 */
export async function createPaneAxisHud(app: unknown, options: PaneAxisHudOptions): Promise<PaneAxisHudHandle> {
  const entries = new Map<string, PaneEntry>();
  let disposed = false;
  let createWidget = options.createWidget;

  if (!createWidget) {
    const pc = await import("playcanvas");
    const { Entity, StandardMaterial, Color, BLEND_NORMAL } = pc;
    createWidget = (paneId, layer) => {
      const root = new Entity(`axis-hud:${paneId}`);
      (root as unknown as { layers: number[] }).layers = [layer.id];
      const geometry = (shape: string) => {
        const entity = new Entity(shape);
        entity.addComponent("render", { type: shape as never });
        return entity;
      };
      const materialFor = (color: readonly [number, number, number], opacity: number) => {
        const material = new StandardMaterial();
        material.useLighting = false; // HUD 要的是纯色，不受光照影响
        material.diffuse = new Color(color[0], color[1], color[2]);
        material.emissive = new Color(color[0], color[1], color[2]);
        material.opacity = opacity;
        if (opacity < 1) material.blendType = BLEND_NORMAL;
        material.update();
        return material;
      };
      for (const head of AXIS_HEADS) {
        const bar = geometry("box");
        // 色条：从 BAR_INNER 到 BAR_OUTER，粗 0.04（`setLocalScale` 的世界 X 轴对应本地 X）
        const barLength = BAR_OUTER - BAR_INNER;
        const barMiddle = (BAR_INNER + BAR_OUTER) / 2;
        const barMaterial = materialFor(head.color, head.sign === 1 ? 1 : 0.75);
        if (bar.render) bar.render.material = barMaterial;
        if (head.axis === "x") {
          bar.setLocalScale(barLength, 0.04, 0.04);
          bar.setLocalPosition(head.sign * barMiddle, 0, 0);
        } else if (head.axis === "y") {
          bar.setLocalScale(0.04, barLength, 0.04);
          bar.setLocalPosition(0, head.sign * barMiddle, 0);
        } else {
          bar.setLocalScale(0.04, 0.04, barLength);
          bar.setLocalPosition(0, 0, head.sign * barMiddle);
        }
        root.addChild(bar);

        const ball = geometry("sphere");
        const ballMaterial = materialFor(head.color, head.sign === 1 ? 1 : 0.75);
        if (ball.render) ball.render.material = ballMaterial;
        const radius = HEAD_RADIUS * (head.sign === 1 ? 1 : NEGATIVE_HEAD_SCALE);
        ball.setLocalScale(radius * 2, radius * 2, radius * 2);
        ball.setLocalPosition(head.direction[0], head.direction[1], head.direction[2]);
        root.addChild(ball);
      }
      // 部件自身的 mesh instance 一律不可拾取（拾取只走 Picker + 核心层）
      const collect = (node: { render?: { meshInstances?: { pick: boolean }[] } | null; children?: unknown[] }) => {
        for (const instance of node.render?.meshInstances ?? []) instance.pick = false;
        for (const child of (node.children ?? []) as typeof node[]) collect(child);
      };
      collect(root as never);
      (app as { root: { addChild(child: unknown): void } }).root.addChild(root);
      return {
        setTransform(position, scale) {
          root.setPosition(position[0], position[1], position[2]);
          root.setLocalScale(scale, scale, scale);
        },
        setVisible(visible) {
          root.enabled = visible;
        },
        destroy() {
          root.destroy();
        },
      };
    };
  }

  const ensure = (paneId: string): PaneEntry | null => {
    if (disposed) return null;
    const existing = entries.get(paneId);
    if (existing) return existing;
    if (!options.cameraFor(paneId)) return null;
    const layer = options.createLayer(paneId);
    const widget = createWidget!(paneId, layer);
    const entry: PaneEntry = { layer, widget, center: [0, 0, 0], scale: 1 };
    entries.set(paneId, entry);
    return entry;
  };

  /** 每帧把部件摆到"相机前方固定深度 + 右上角边距"，并记住中心与缩放供命中用。 */
  const tick = () => {
    if (disposed) return;
    for (const [paneId, entry] of entries) {
      const entity = options.cameraFor(paneId) as CameraEntityLike | null;
      const rect = options.paneRectFor(paneId);
      const component = entity?.camera;
      if (!entity || !rect || !component) continue;
      const orthographic = component.projection === PROJECTION_ORTHOGRAPHIC_VALUE;
      const placement = hudPlacement({
        camera: {
          position: toVec3(entity.getPosition()),
          right: toVec3(entity.right),
          up: toVec3(entity.up),
          forward: toVec3(entity.forward),
          fov: component.fov ?? 60,
          projection: orthographic ? "orthographic" : "perspective",
          orthoHeight: component.orthoHeight ?? 7.5,
        },
        paneWidth: rect.width,
        paneHeight: rect.height,
      });
      entry.center = placement.position;
      entry.scale = placement.scale;
      entry.widget.setTransform(placement.position, placement.scale);
    }
  };
  const application = app as { on(event: string, handler: () => void): { off(): void } };
  const updateHandle = application.on("update", tick);

  const screenPoints = (paneId: string) => {
    const entry = entries.get(paneId) ?? ensure(paneId);
    if (!entry) return [];
    const entity = options.cameraFor(paneId) as CameraEntityLike | null;
    const camera = entity?.camera;
    if (!camera?.worldToScreen) return [];
    return headWorldPositions(entry.center, entry.scale).flatMap(({ head, position }) => {
      const screen = camera.worldToScreen!({ x: position[0], y: position[1], z: position[2] });
      return Number.isFinite(screen.x) && Number.isFinite(screen.y) ? [{ head, screen }] : [];
    });
  };

  return {
    layerIdFor: (paneId) => (entries.get(paneId) ?? ensure(paneId))?.layer.id ?? null,
    screenPoints,
    hit: (paneId, point) => pickAxisHead(screenPoints(paneId), point),
    snapTarget(paneId, point, rig) {
      const head = pickAxisHead(screenPoints(paneId), point);
      return head ? rigForAxisSnap(rig, head.direction) : null;
    },
    centerOf: (paneId) => entries.get(paneId)?.center ?? null,
    setVisible(paneId, visible) {
      const entry = entries.get(paneId) ?? ensure(paneId);
      entry?.widget.setVisible(visible);
    },
    dispose() {
      disposed = true;
      updateHandle.off();
      for (const entry of entries.values()) {
        entry.widget.destroy();
        // 引擎不删层，必须自己删（与 gizmo 同一条约束）
        options.removeLayer(entry.layer);
      }
      entries.clear();
    },
  };
}
