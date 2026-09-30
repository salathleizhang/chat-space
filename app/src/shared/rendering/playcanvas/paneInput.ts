import {
  dollyBy,
  focusOn,
  MAX_DISTANCE,
  MAX_POLAR,
  MIN_DISTANCE,
  MIN_POLAR,
  orbitBy,
  panBy,
  ORTHO_VIEW_WORLD_HEIGHT,
  type CameraRig,
  type Vec3,
} from "../../../shared/lib/cameraRig";
import type { PixelViewport } from "./paneCamera";

/**
 * 窗格指针输入：把 DOM 指针事件**路由到某一个窗格**的相机台架（轨道/缩放/平移/聚焦）。
 *
 * ### 为什么不能用引擎自带的 `orbitCamera` 脚本
 * 它是**全局输入**（挂在 `app.mouse` 上、对整张画布生效），而本应用是多窗格：每格有自己的
 * 相机与轨道状态，指针落在哪一格就只该动那一格。所以这里按与 `PaneRegistry` 的 `camera.rect`
 * **同源**的 CSS px 视口做命中测试，自己接事件。
 *
 * ### 手势映射（与 three 侧 drei `OrbitControls` 的**按键映射**一致）
 * - 左键拖动 → 轨道旋转（全速 = 2π rad / 窗格高 px）
 * - 中键拖动 → 缩放（纵向拖动，乘性）
 * - 右键拖动 → 平移（"画面跟着手走"）
 * - 滚轮 → 乘性缩放（把 `deltaMode` 归一化成 CSS px）
 * - 双击（两次左键点击，见下）→ 聚焦到 `focusTarget()` 给的包围球
 *
 * **比例尺按窗格高而不是画布高**，这是与 three 侧一处**有意**的差异：three 把 OrbitControls
 * 挂在整张画布上，所以它的 `rotateLeft(2π·dx/element.clientHeight)` 与
 * `panLeft(dx·worldHeight/element.clientHeight)` 用的都是**画布**高——4 窗格布局下每格只有
 * 画布的一半高，于是旋转、平移、中键缩放全都只有一半的响应，平移时模型不跟手。
 * 按窗格高算，每格"拖满自己的高度 = 一整圈"，且平移 1:1 跟手，与布局无关。
 *
 * ### 五个静默失败点（不报错、只是不动或粘住）
 * ① `wheel` 监听必须 `{ passive: false }`：passive 监听里 `preventDefault()` 无效，滚轮会
 *    **同时**缩放页面（控制台只有一条 warning）。所以这里显式声明并 `preventDefault()`。
 * ② 拖动必须 `setPointerCapture` **并且**在 `window` 上收 move/up：只听画布自己的 `pointerup`
 *    时，指针在画布外松开就没有 up 事件，手势**永久粘住**（此后每次移动都在轨道旋转）。
 *    捕获让指针移出画布/窗口后事件仍回投到画布；window 监听兜住捕获不可用的情况
 *    （合成事件里 `setPointerCapture` 对不存在的 pointerId 会抛 `NotFoundError`）。
 * ③ 右键拖动要在 `contextmenu` 上 `preventDefault()`：否则一松手弹出原生菜单，拖动看起来"被中断"
 *    （three 的 `OrbitControls` 也是这么做的）。
 * ④ `pointercancel` / `lostpointercapture` / `blur` 都要按"抬手"处理，否则同样是粘住。
 * ⑤ **双击不依赖 DOM 的 `dblclick`**：本层自己在 `pointerup` 上按"两次左键点击 + 位移与间隔
 *    都在窗口内"判定（所以时钟可注入、可单测）。理由是兼容事件的生成规则**是浏览器实现细节，
 *    而我们正在扰动它**：因为本层在 `pointerdown` 上 `preventDefault()`（否则拖动会选中页面文本、
 *    中键会触发自动滚动），实测（Chrome 154，§三之六）`mousedown` 被抑制（0 次）而
 *    `click`/`dblclick` **照旧派发**（3 次 / 1 次）——也就是说"原生 dblclick 还能用"，
 *    但**不能**依赖 `mousedown`/`mouseup`，且这个组合在别的浏览器上不保证。自算双击同时覆盖
 *    触摸双击，并能明确忽略"拖动之后紧跟的点击"。
 *    → 推论（写给后面的拾取实现）：画布上的拾取要走**指针事件**，不要走 `mousedown`/`mouseup`。
 *
 * ### 刻意没做的部分（不要当成 bug）
 * - **没有阻尼/惯性**：three 侧的 `enableDamping` 需要每帧推进会衰减的状态，属于渲染循环的事；
 *   这里保持"事件进、台架出"的纯事件驱动。双击聚焦也是**立即到位**，没有 three 侧的缓动飞行。
 * - **没有捏合缩放**：只处理指针事件，触摸只支持单指轨道。
 * - **不做拾取**：双击聚焦的是 `focusTarget()` 给的包围球（整场景/整个模型），
 *   按被点中的部件聚焦需要先做拾取（`PLAYCANVAS_MIGRATION.md` §五.2）。
 */

/** 一个窗格在**当前布局**里的 CSS px 视口，相对画布左上角（与 `PaneRegistry.sync` 的入参同源）。 */
export interface PaneInputSpec {
  id: string;
  viewport: PixelViewport;
}

export type DragKind = "orbit" | "pan" | "dolly";

/** 轨道全速：拖满一个窗格高度 = 一整圈。与 three `OrbitControls` 的 `2π/h` 同式。 */
export const ORBIT_RADIANS_PER_PANE_HEIGHT = 2 * Math.PI;
/** 滚轮/中键缩放速率：100 px ≈ ×0.8（向上滚变近）。取自然指数保证多格手感可加。 */
export const ZOOM_RATE_PER_PX = Math.log(1.25) / 100;
/** `deltaMode === DOM_DELTA_LINE` 时一行折合多少 CSS px。 */
export const WHEEL_LINE_HEIGHT_PX = 16;
/** 判定"这是拖动而不是点击"的累计位移（CSS px），也是两次点击的空间容忍。 */
export const CLICK_SLOP_PX = 4;
/** 两次点击判为双击的时间窗（ms）。系统双击间隔通常是 500ms，这里取略紧的值。 */
export const DOUBLE_CLICK_MS = 400;

/** 命中测试：画布局部 CSS px 落在哪个窗格里。边界按左闭右开，让相邻窗格共享的边只属于一个格子。 */
export function paneSpecAt(panes: readonly PaneInputSpec[], x: number, y: number): PaneInputSpec | null {
  for (const pane of panes) {
    const { left, top, width, height } = pane.viewport;
    if (width <= 0 || height <= 0) continue;
    if (x >= left && x < left + width && y >= top && y < top + height) return pane;
  }
  return null;
}

/** 同上的 id 形式。 */
export function paneAt(panes: readonly PaneInputSpec[], x: number, y: number): string | null {
  return paneSpecAt(panes, x, y)?.id ?? null;
}

/** 鼠标键 → 手势。与 three `OrbitControls` 的默认映射一致（左键转、中键缩放、右键平移）。 */
export function dragKindForButton(button: number): DragKind | null {
  if (button === 0) return "orbit";
  if (button === 1) return "dolly";
  if (button === 2) return "pan";
  return null;
}

/** 把 `deltaMode` 归一化成 CSS px：0=像素、1=行、2=页（一页按窗格高算）。 */
export function normalizeWheelPx(deltaY: number, deltaMode: number, paneHeightPx: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  const scale = deltaMode === 1
    ? WHEEL_LINE_HEIGHT_PX
    : deltaMode === 2
      ? Math.max(paneHeightPx, WHEEL_LINE_HEIGHT_PX)
      : 1;
  return deltaY * scale;
}

/**
 * 目标平面上可见的世界高度：透视 `2·d·tan(fov/2)`，正交恒为 `ORTHO_VIEW_WORLD_HEIGHT`。
 * `panBy` 需要它把像素位移换算成世界位移——两个投影的"一格像素等于多少世界单位"不同。
 */
export function worldHeightAtTarget(rig: CameraRig): number {
  if (rig.projection === "orthographic") return ORTHO_VIEW_WORLD_HEIGHT;
  return 2 * rig.distance * Math.tan((rig.fov * Math.PI) / 360);
}

/**
 * 一次拖动位移 → 新的台架状态。
 *
 * 旋转、平移、中键缩放的比例都按**窗格**高度算（不是整张画布，理由见文件头）：
 * 拖满窗格高度 = 一整圈，平移 1 世界单位对应光标 1 px（在目标平面上），与几宫格布局无关。
 *
 * `worldUp` 要**和喂给 `applyRig` 的 up 用同一个值**——俯视窗格是 `(0,0,-1)`，
 * 否则平移方向差 90°（见 `shared/lib/cameraRig.ts` 的 `panBy`）。
 */
export function applyDrag(
  rig: CameraRig,
  kind: DragKind,
  deltaXPx: number,
  deltaYPx: number,
  paneHeightPx: number,
  worldUp?: Vec3,
): CameraRig {
  if (paneHeightPx <= 0) return rig;
  if (kind === "pan") {
    return panBy(rig, deltaXPx, deltaYPx, paneHeightPx, worldHeightAtTarget(rig), worldUp);
  }
  if (kind === "dolly") {
    return dollyBy(rig, Math.exp(deltaYPx * ZOOM_RATE_PER_PX));
  }
  const perHeight = ORBIT_RADIANS_PER_PANE_HEIGHT / paneHeightPx;
  // 符号与 three 一致：向右拖 → 方位角减小（相机绕到 -X 侧，画面上的物体跟着手向右转）；
  // 向下拖 → 极角减小（相机升高、看到顶面）。断言见 paneInput.test.ts。
  return orbitBy(rig, -deltaXPx * perHeight, -deltaYPx * perHeight);
}

/**
 * 滚轮 → 新的台架状态。
 *
 * **正交窗格不动**：`camera.orthoHeight` 固定为 `ORTHO_VIEW_WORLD_HEIGHT/2`（产品可见值），
 * 缩放必然破坏"竖直恒定可见 15 个世界单位"。three 侧同样是死的——`OrthoZoomSync` 每帧把
 * zoom 按像素高反推回 15 个世界单位，`OrbitControls` 的 dolly 下一帧就被覆盖。
 */
export function applyWheel(rig: CameraRig, wheelPx: number): CameraRig {
  if (rig.projection === "orthographic") return rig;
  return dollyBy(rig, Math.exp(wheelPx * ZOOM_RATE_PER_PX));
}

/**
 * 聚焦：目标点移到球心。透视同时按 `fitDistance` 退到能装下包围球的距离；
 * 正交只挪目标点——正交的可见范围是常量，退远退近都不改变画面大小。
 * 返回的 `target` 是**拷贝**（`focusOn` 会直接用调用方传进来的数组）。
 */
export function focusRig(rig: CameraRig, center: Vec3, radius: number, margin = 1.35): CameraRig {
  const target: Vec3 = [center[0], center[1], center[2]];
  if (rig.projection === "orthographic") return { ...rig, target };
  return focusOn(rig, target, radius, margin);
}

/**
 * 聚焦目标。两种口径**并存**，因为产品里两件事都用：
 *  - `radius`：把 `radius` 的包围球装进画面（`fitDistance`）。用于"聚焦到整个模型/场景"。
 *  - `offset`：相机相对目标点的**固定偏移**。three 侧双击聚焦就是这一口径
 *    （`FOCUS_CAMERA_OFFSET = [3, 2, 3]`，`widgets/Viewport/index.tsx:113-114,453-469`）：
 *    距离 = `|offset|`，方位角/极角由偏移方向给出，与物体大小无关。
 */
export type FocusTarget = { center: Vec3; radius: number } | { center: Vec3; offset: Vec3 };

/**
 * 按上面两种口径算出新的台架。
 *
 * 正交窗格只挪目标点（**不改朝向、不改距离**）：正交的可见范围是常量，而 three 侧的双击飞行
 * 只挂在透视窗格上（`PaneCamera.tsx:630` 的 `{isPerspective && <CameraRig …/>}`）——
 * 正交窗格双击的净效果就只是"把目标点挪过去"。
 */
export function focusRigWithTarget(rig: CameraRig, target: FocusTarget, margin = 1.35): CameraRig {
  const center: Vec3 = [target.center[0], target.center[1], target.center[2]];
  if (!("offset" in target)) return focusRig(rig, center, target.radius, margin);
  if (rig.projection === "orthographic") return { ...rig, target: center };
  const offset = target.offset;
  const distance = Math.hypot(offset[0], offset[1], offset[2]);
  if (!(distance > 0)) return { ...rig, target: center };
  // 偏移方向 = 目标点 → 相机的方向，直接给出方位角与极角（极角仍要钳制，免得与 up 共线）
  const horizontal = Math.hypot(offset[0], offset[2]);
  const polar = Math.atan2(horizontal, offset[1]);
  return {
    ...rig,
    target: center,
    azimuth: Math.atan2(offset[0], offset[2]),
    polar: Math.min(Math.max(polar, MIN_POLAR), MAX_POLAR),
    distance: Math.min(Math.max(distance, MIN_DISTANCE), MAX_DISTANCE),
  };
}

/** 输入层需要的东西：布局、台架读写、聚焦目标。**一个引擎 API 都不需要**，所以可单测。 */
export interface PaneInputHost {
  /** 当前布局。每次事件重新读，切布局/改尺寸后自动生效。 */
  panes(): readonly PaneInputSpec[];
  getRig(paneId: string): CameraRig | null;
  /** 写回台架。实现方负责 `applyRig` 到引擎实体。 */
  setRig(paneId: string, rig: CameraRig): void;
  /** 双击聚焦的目标；返回 null 表示这一格现在没有可聚焦目标。 */
  focusTarget?(paneId: string): FocusTarget | null;
  /** 这一格相机的上方向，默认世界 +Y。俯视窗格要给 `(0,0,-1)`。 */
  paneUp?(paneId: string): Vec3 | undefined;
  /**
   * 一次**左键点击**（位移不超过 `CLICK_SLOP_PX` 的按下+抬起）。拾取/选择挂这里——
   * 拖动不会触发它，所以"转视角"和"点选"不会互相误触发。
   */
  onClick?(paneId: string, point: { x: number; y: number }): void;
  /**
   * 这一格现在是否把手势让给别人（典型：正在拖**变换 gizmo 手柄**）。返回 true 就不开始
   * 轨道手势——否则拖手柄的同时相机会跟着转。信号要来自 gizmo 自己的 `transform:start/end`
   * （`paneGizmo.ts` 的 `dragging()`），**不要**靠"指针离手柄多近"去猜。
   */
  isPointerClaimed?(paneId: string): boolean;
  /** 任何一次会改变画面的输入（截图队列的"交互让行"要用）。 */
  onInteraction?(): void;
}

interface Gesture {
  paneId: string;
  pointerId: number;
  kind: DragKind;
  lastX: number;
  lastY: number;
  /** 累计位移，用来区分"点击"和"拖动"。 */
  moved: number;
}

interface ClickRecord {
  paneId: string;
  at: number;
  x: number;
  y: number;
}

const defaultNow = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * 手势路由：**纯逻辑**，不碰 DOM。DOM 绑定只做"事件 → 画布局部坐标"的转换。
 *
 * 同一时刻只认一个手势：拖动期间第二个指针（多点触控）不参与，避免两套状态互相覆盖。
 * 双击在 `finish()` 里按两次点击的**时间与位移**判定（原因见文件头 ⑤），
 * 所以时钟可注入，测试里不用真等 400ms。
 */
export class PaneGestureRouter {
  private gesture: Gesture | null = null;
  private lastClick: ClickRecord | null = null;

  constructor(private readonly host: PaneInputHost, private readonly now: () => number = defaultNow) {}

  /** 正在进行的拖动；没有则 null。 */
  active(): { paneId: string; pointerId: number; kind: DragKind } | null {
    const g = this.gesture;
    return g ? { paneId: g.paneId, pointerId: g.pointerId, kind: g.kind } : null;
  }

  /** 指针按下。返回受理的窗格 id（null = 不受理，DOM 层就不该 preventDefault / 捕获）。 */
  start(x: number, y: number, pointerId: number, button: number): string | null {
    if (this.gesture) return null;
    const kind = dragKindForButton(button);
    if (!kind) return null;
    const pane = paneSpecAt(this.host.panes(), x, y);
    if (!pane || !this.host.getRig(pane.id)) return null;
    // 别人（gizmo 手柄）正在用这个指针：不动相机，也不认这次点击
    if (this.host.isPointerClaimed?.(pane.id)) return null;
    this.gesture = { paneId: pane.id, pointerId, kind, lastX: x, lastY: y, moved: 0 };
    this.host.onInteraction?.();
    return pane.id;
  }

  /** 指针移动。返回是否被这个手势消费。 */
  move(pointerId: number, x: number, y: number): boolean {
    const g = this.gesture;
    if (!g || g.pointerId !== pointerId) return false;
    // 拖动途中别人接管了这个指针（gizmo 手柄）：立刻收手。**不能只看按下时那一刻**——
    // 手柄的 `transform:start` 是不是"先于"我们的 pointerdown 触发，取决于两边监听器的注册顺序，
    // 这里每帧复查就与顺序无关了。
    if (this.host.isPointerClaimed?.(g.paneId)) {
      this.cancel();
      return true;
    }
    const dx = x - g.lastX;
    const dy = y - g.lastY;
    g.lastX = x;
    g.lastY = y;
    g.moved += Math.hypot(dx, dy);
    if (dx === 0 && dy === 0) return true;
    // 布局可能在中途变了（窗格被销毁 / 尺寸为 0）：这时收手，不要拿旧高度继续算
    const pane = this.host.panes().find((candidate) => candidate.id === g.paneId);
    const rig = this.host.getRig(g.paneId);
    if (!pane || pane.viewport.height <= 0 || !rig) {
      this.cancel();
      return true;
    }
    this.host.setRig(g.paneId, applyDrag(rig, g.kind, dx, dy, pane.viewport.height, this.host.paneUp?.(g.paneId)));
    this.host.onInteraction?.();
    return true;
  }

  /** 指针抬起。返回是否是本次手势的收尾（收尾时可能触发双击聚焦）。 */
  end(pointerId: number): boolean {
    const g = this.gesture;
    if (!g || g.pointerId !== pointerId) return false;
    this.finish(g);
    return true;
  }

  /** 非正常收尾（`pointercancel` / 失焦 / 布局变化）。幂等，**不计入点击**。 */
  cancel(): void {
    if (!this.gesture) return;
    this.gesture = null;
  }

  /** 滚轮。返回受理的窗格 id。 */
  wheel(x: number, y: number, deltaY: number, deltaMode: number): string | null {
    const pane = paneSpecAt(this.host.panes(), x, y);
    const rig = pane ? this.host.getRig(pane.id) : null;
    if (!pane || !rig) return null;
    const next = applyWheel(rig, normalizeWheelPx(deltaY, deltaMode, pane.viewport.height));
    if (next !== rig) {
      this.host.setRig(pane.id, next);
      this.host.onInteraction?.();
    }
    return pane.id;
  }

  /** 直接聚焦某一格（探针/测试用；正常路径是双击）。返回是否真的聚焦了。 */
  focus(paneId: string): boolean {
    const rig = this.host.getRig(paneId);
    const target = this.host.focusTarget?.(paneId);
    if (!rig || !target) return false;
    this.host.setRig(paneId, focusRigWithTarget(rig, target));
    this.host.onInteraction?.();
    return true;
  }

  private finish(gesture: Gesture): void {
    this.gesture = null;
    // 拖动过、或不是左键：不算点击，也清掉上一次点击（避免"拖动 + 单击"被拼成双击）
    if (gesture.moved > CLICK_SLOP_PX || gesture.kind !== "orbit") {
      this.lastClick = null;
      return;
    }
    // 单击先通知出去（拾取/选择挂这里），双击判定在它之后——"点选 + 双击聚焦"是两步，都要发生
    this.host.onClick?.(gesture.paneId, { x: gesture.lastX, y: gesture.lastY });
    const at = this.now();
    const previous = this.lastClick;
    const isDouble = previous !== null
      && previous.paneId === gesture.paneId
      && at - previous.at <= DOUBLE_CLICK_MS
      && Math.hypot(gesture.lastX - previous.x, gesture.lastY - previous.y) <= CLICK_SLOP_PX;
    if (!isDouble) {
      this.lastClick = { paneId: gesture.paneId, at, x: gesture.lastX, y: gesture.lastY };
      return;
    }
    this.lastClick = null;
    this.focus(gesture.paneId);
  }
}

export interface PanePointerInputOptions extends PaneInputHost {
  /** 监听哪个元素。默认就是画布本身（命中坐标仍相对**画布**）。 */
  target?: HTMLElement;
  /** 测试注入点：手势路由用的时钟。 */
  now?: () => number;
}

export interface PanePointerInputHandle {
  /** 正在进行的拖动（无则 null）——供探针/测试读。 */
  active(): { paneId: string; pointerId: number; kind: DragKind } | null;
  /** 手动派发用（探针里模拟输入，或将来接 `Viewport` 已有的合成事件）。 */
  router: PaneGestureRouter;
  detach(): void;
}

/** 画布局部 CSS px。**不做 DPR 换算**：台架的比例尺全程是 CSS px（见 paneCamera.ts ③）。 */
function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * 把指针事件接到台架上。
 *
 * `pointermove` / `pointerup` / `pointercancel` / `blur` 只在**手势进行中**才挂到 window 上：
 * 静止时一个监听都没有（否则每次鼠标移动都会进一遍我们的代码）。
 *
 * ⚠️ 本层会取消画布上的 `pointerdown` / `wheel` / `contextmenu` 默认行为，所以**画布上的
 * `click` / `dblclick` / `mousedown` 不再可靠**（见文件头 ⑤）。拾取之类的功能要走指针事件。
 */
export function attachPanePointerInput(canvas: HTMLCanvasElement, options: PanePointerInputOptions): PanePointerInputHandle {
  const target = options.target ?? canvas;
  const router = new PaneGestureRouter(options, options.now);
  const onWindow = typeof window === "undefined" ? null : window;

  const releaseCapture = (pointerId: number) => {
    try {
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
    } catch {
      // 指针已经不存在了：无所谓
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    if (!router.move(event.pointerId, point.x, point.y)) return;
    event.preventDefault();
    // 布局被换掉 / 台架没了时 move() 会自己收手，这里把 window 监听也撤掉
    if (!router.active()) detachWindow();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!router.end(event.pointerId)) return;
    releaseCapture(event.pointerId);
    event.preventDefault();
    detachWindow();
  };

  const onPointerCancel = () => {
    if (!router.active()) return;
    router.cancel();
    detachWindow();
  };

  const onBlur = () => onPointerCancel();

  const attachWindow = () => {
    if (!onWindow) return;
    onWindow.addEventListener("pointermove", onPointerMove, { passive: false });
    onWindow.addEventListener("pointerup", onPointerUp, { passive: false });
    onWindow.addEventListener("pointercancel", onPointerCancel);
    onWindow.addEventListener("blur", onBlur);
  };

  const detachWindow = () => {
    if (!onWindow) return;
    onWindow.removeEventListener("pointermove", onPointerMove);
    onWindow.removeEventListener("pointerup", onPointerUp);
    onWindow.removeEventListener("pointercancel", onPointerCancel);
    onWindow.removeEventListener("blur", onBlur);
  };

  const onPointerDown = (event: PointerEvent) => {
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    if (!router.start(point.x, point.y, event.pointerId, event.button)) return;
    event.preventDefault();
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // 合成事件里 pointerId 不是活动指针 → NotFoundError；window 上的监听仍然兜得住
    }
    attachWindow();
  };

  const onWheel = (event: WheelEvent) => {
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    if (!router.wheel(point.x, point.y, event.deltaY, event.deltaMode)) return;
    // 必须在 `{ passive: false }` 的监听里才有意义，否则页面会跟着一起滚
    event.preventDefault();
  };

  const onContextMenu = (event: MouseEvent) => {
    // 与 three 的 OrbitControls 一致：窗格上不给原生菜单，右键留给平移
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    if (paneAt(options.panes(), point.x, point.y)) event.preventDefault();
  };

  const onLostPointerCapture = () => {
    // 捕获被抢走 / 元素被移除：按抬手处理，否则手势粘住
    if (router.active()) {
      router.cancel();
      detachWindow();
    }
  };

  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("wheel", onWheel, { passive: false });
  target.addEventListener("contextmenu", onContextMenu);
  target.addEventListener("lostpointercapture", onLostPointerCapture);

  return {
    active: () => router.active(),
    router,
    detach() {
      router.cancel();
      detachWindow();
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("contextmenu", onContextMenu);
      target.removeEventListener("lostpointercapture", onLostPointerCapture);
    },
  };
}
