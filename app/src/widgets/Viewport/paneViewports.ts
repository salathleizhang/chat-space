import { ArrayCamera, PerspectiveCamera, Vector4, type Camera, type OrthographicCamera } from "three";
import { LAYOUTS } from "./paneLayouts";

/**
 * `ArrayCamera.cameras` 的**恒定**长度。
 *
 * 这不是"最多 4 个窗格"的重复声明，而是一个硬约束：three 给 `cameraProjectionMatrices` 分配的
 * uniform buffer 按**当时的相机数**定容，之后在 backend 里按名字共享、**不会随相机数增长**。
 * 实测（2026-09-30）：2 窗格时建了 `size(128)`（2 × 64 字节），切到 4 窗格时 `Queue.WriteBuffer`
 * 写 256 字节 → `GPUValidationError`，整个画布走 `WebGPUCanvas` 的失败面板。
 *
 * 所以子相机数必须自始至终不变：不足的槽位用**空相机**补齐——`layers.mask = 0` 让
 * `object.layers.test(...)` 恒假，三个后端一次 draw 都不会为它发。
 */
export const ARRAY_CAMERA_CAPACITY = Math.max(...Object.values(LAYOUTS).map((panes) => panes.length));

const idleCameras: PerspectiveCamera[] = [];

/** 补齐用的空相机：与任何对象的 layers 都不相交，因此只占槽位、不产生 draw。 */
function idleCamera(slot: number): PerspectiveCamera {
  let camera = idleCameras[slot];
  if (!camera) {
    camera = new PerspectiveCamera();
    camera.name = `pane-idle:${slot}`;
    camera.matrixAutoUpdate = false;
    idleCameras[slot] = camera;
  }
  camera.layers.mask = 0;
  const carrier = camera as ViewportCarrier;
  carrier.viewport ??= new Vector4();
  carrier.viewport.set(0, 0, 1, 1);
  return camera;
}

/** 一帧里某个窗格为共享核心场景贡献的绘制信息。 */
export interface PaneView {
  /** 相机可见层（与 `VIEW_LAYERS` 对应）；核心场景里的 splat 在 layer 0，每个相机都看得见。 */
  layer: number;
  /** 本帧要画就返回相机与它相对画布的视口（**左上原点、CSS px**）；不画返回 null。 */
  resolve(): { camera: Camera; left: number; top: number; width: number; height: number } | null;
}

type ViewportCarrier = Camera & { viewport?: Vector4; isArrayCamera?: boolean };

/**
 * 把 N 个窗格相机同步进一个复用的 `ArrayCamera`，返回本帧可画的相机数。
 *
 * 为什么能用：three 0.186.1 的 WebGPU 后端在 `renderObject` 里对 `camera.isArrayCamera` 有完整分支——
 * 在**同一个 render pass** 内逐子相机 `setViewport`、按 `object.layers.test(subCamera.layers)` 过滤、
 * 逐子相机写 `cameraIndex` 绑定，然后各发一次 draw。所以"4 个窗格"不必是 4 趟 `gl.render()`：
 * 一趟就够，`info.render.calls` 也只记 1 次（`_renderScene` 每次 +1）。GSL 也认这个形状：
 * 它的投影器看到 `array.cameras` 就把所有眼放进**同一条 compute 链**，并用 `cameraIndex` 取每眼的排序。
 *
 * 三件 three 不会替你做、漏掉任何一件都会画错的事：
 *  ① **子相机矩阵**：`renderer.render()` 只对传进去的那个相机调 `updateMatrixWorld()`，而
 *     `ArrayCamera.cameras` 不是它的子节点；`FrustumArray` 与 `cameraIndex` 绑定都读子相机的
 *     `matrixWorldInverse`，所以这里逐个更新。
 *  ② **viewport 的单位与原点**：`WebGPUBackend.renderObject` 把 `subCamera.viewport` 直接乘
 *     `getPixelRatio()` 交给 `pass.setViewport`，**没有** `WebGLBackend` 那条 `height - h - y` 翻转
 *     （实测：翻转只存在于 `WebGLBackend`）。所以这里必须是**左上原点、CSS px**——正好是
 *     `viewRect()` 的输出，与逐窗格 `gl.setViewport()` 走的是同一套值。
 *  ③ **layers 是两层过滤，两层都要给**：
 *     - `Renderer._projectObject` 先做一次 `object.layers.test(camera.layers)`——**用的是
 *       ArrayCamera 自己的 mask**。对不上就**根本进不了 render list**，子相机再对也没用；
 *     - `WebGPUBackend.renderObject` 再用 `object.layers.test(subCamera.layers)` 决定"这一眼画不画"。
 *     所以这里既要把每个子相机的 mask 设成"layer 0 + 自己那层"，也要把 ArrayCamera 自己的 mask
 *     设成**所有窗格 layer 的并集**。（实测踩过：HUD 的 gizmo 放在 layer 1–4，只设了子相机，
 *     结果四个坐标轴球一个都不画——因为它们在投影阶段就被丢掉了。）
 *  ④ **槽位恒定**：见 `ARRAY_CAMERA_CAPACITY` —— 相机数一变，three 的 `cameraProjectionMatrices`
 *     uniform buffer 就写不下（它是定容的）。
 */
export function syncArrayCamera(arrayCamera: ArrayCamera, panes: readonly PaneView[]): number {
  // three 的类型把 `ArrayCamera.cameras` 写成 `PerspectiveCamera[]`，但运行期它按 `Camera` 用
  // （本应用的正交窗格就是 OrthographicCamera）。这里按运行期语义取一份视图。
  const cameras = arrayCamera.cameras as unknown as Camera[];
  let count = 0;
  let accepted = 1;
  for (const pane of panes) {
    if (count === ARRAY_CAMERA_CAPACITY) break;
    const resolved = pane.resolve();
    if (!resolved || resolved.width <= 0 || resolved.height <= 0) continue;
    const camera = resolved.camera as ViewportCarrier;
    // 嵌套 ArrayCamera 不是这里的形状；跳过而不是猜。
    if (camera.isArrayCamera === true) continue;
    camera.updateMatrixWorld();
    camera.layers.mask = 1 | (1 << pane.layer);
    camera.viewport ??= new Vector4();
    camera.viewport.set(resolved.left, resolved.top, resolved.width, resolved.height);
    cameras[count] = camera;
    accepted |= 1 << pane.layer;
    count += 1;
  }
  // 投影阶段的那次过滤用的是 ArrayCamera 自己的 mask，必须是所有窗格 layer 的并集。
  arrayCamera.layers.mask = accepted;
  // 空槽位补空相机：数量恒定，且不产生任何 draw。
  for (let slot = count; slot < ARRAY_CAMERA_CAPACITY; slot += 1) cameras[slot] = idleCamera(slot);
  if (cameras.length > ARRAY_CAMERA_CAPACITY) cameras.length = ARRAY_CAMERA_CAPACITY;
  return count;
}

/**
 * 让相机采用渲染器的坐标约定（**WebGPU 的 NDC z 是 [0, 1]，WebGL 是 [-1, 1]**）。
 *
 * three 只在 `_projectObject` 里给**传进去的那个**相机修正 `coordinateSystem`
 * （bundle `_projectObject` 开头：`camera.coordinateSystem = this.coordinateSystem`），
 * 而 `ArrayCamera` 的**子相机它一律不碰**。子相机带着 `Camera` 的默认值（WebGL 约定）时，
 * `updateProjectionMatrix()` 会把物体放到**负的 NDC z** 上——WebGPU 的裁剪体只接受 [0, 1]，
 * 于是物体被整个裁掉。
 *
 * 实测症状极隐蔽（2026-09-30，HUD 合并时踩到）：每帧 `gl.render(hudScene, hudArrayCamera)`
 * 照常发出、scene 里 4 个 gizmo 的 layer 与 ArrayCamera 的 mask 全对、控制台零报错，
 * 就是**一个像素都不画**。核心场景之所以"看起来正常"，只是因为 1 窗格布局时透视相机当过一次
 * 顶层相机（被 three 修好了），那 3 个正交窗格的相机则是在 4 窗格时才新建的——同一类隐患。
 *
 * **顺序不能反**：`updateProjectionMatrix()` 把约定烘焙进矩阵，所以必须先改 `coordinateSystem`
 * 再重建。
 */
export function adoptCoordinateSystem(camera: Camera, coordinateSystem: Camera["coordinateSystem"]): void {
  const carrier = camera as Camera & { updateProjectionMatrix?: () => void };
  if (carrier.coordinateSystem === coordinateSystem) return;
  carrier.coordinateSystem = coordinateSystem;
  carrier.updateProjectionMatrix?.();
}

/**
 * 把相机投影适配到它的窗格尺寸：透视改 `aspect`，正视改 `left/right/top/bottom`。
 *
 * 这段逻辑原先住在每个窗格的 scene pass 里，但核心场景现在排在窗格 pass **之前**，所以它必须在
 * 那一趟里、**画之前**完成——否则渲染用的是上一帧的投影。判据保留原有的"值变了才重建"守卫，
 * 因为 `updateProjectionMatrix()` 每次都会重算矩阵。
 */
export function fitCameraToViewport(camera: Camera, width: number, height: number): void {
  const perspective = camera as PerspectiveCamera;
  const orthographic = camera as OrthographicCamera;
  if (perspective.isPerspectiveCamera) {
    if (perspective.aspect !== width / height) {
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
    }
  } else if (orthographic.isOrthographicCamera && (orthographic.right !== width / 2 || orthographic.top !== height / 2)) {
    orthographic.left = -width / 2;
    orthographic.right = width / 2;
    orthographic.top = height / 2;
    orthographic.bottom = -height / 2;
    orthographic.updateProjectionMatrix();
  }
}
