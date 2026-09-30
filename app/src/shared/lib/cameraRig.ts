/**
 * 相机台架的**纯数学**：轨道状态 → 机位、缩放、平移、聚焦。不依赖 three / playcanvas。
 *
 * 两个引擎的差别只在"把这份状态写到哪"（three 写 `PerspectiveCamera.position` + `.lookAt`，
 * PlayCanvas 写实体 transform），状态机本身共用。
 *
 * ### 正交窗格的约定（读自 `PaneCamera.tsx`，不要想当然）
 * 应用要的是「正交窗格**竖直方向恒定可见 15 个世界单位**」，与窗格有多少像素无关。
 * three 侧为此绕了一圈：drei `View` 每帧把正交视锥按**像素**重设（`left/right/top/bottom = ±像素/2`），
 * 所以只能拿 `zoom = 窗格像素高 / 15` 每帧反推。
 *
 * **PlayCanvas 的 `camera.orthoHeight` 本身就是世界单位的半高**，所以那一整套每帧反推
 * **不存在**——直接 `orthoHeight = ORTHO_VIEW_WORLD_HEIGHT / 2`，宽高比由 `camera.rect` +
 * `calculateAspectRatio()` 负责。这是迁移里少见的"净删代码"。
 */

/** 正交窗格竖直方向恒定可见的世界高度。产品可见值，不要随手改。 */
export const ORTHO_VIEW_WORLD_HEIGHT = 15;

/** 极角钳制：留 0.01 rad 余量，避免在正上/正下方时 `lookAt` 与 up 共线导致滚转跳变。 */
export const MIN_POLAR = 0.01;
export const MAX_POLAR = Math.PI - 0.01;
export const MIN_DISTANCE = 0.05;
export const MAX_DISTANCE = 5000;

export type Vec3 = [number, number, number];

export interface CameraRig {
  /** 轨道围绕的目标点。 */
  target: Vec3;
  /** 方位角（弧度），绕 +Y 从 +Z 向 +X 旋转。 */
  azimuth: number;
  /** 极角（弧度），自 +Y 起算；π/2 即水平。 */
  polar: number;
  distance: number;
  /** 透视竖直视场角（度）。 */
  fov: number;
  projection: "perspective" | "orthographic";
}

const clamp = (value: number, lo: number, hi: number) => (value < lo ? lo : value > hi ? hi : value);

/** 相机相对目标点的方向（单位向量）。 */
export function rigDirection(rig: Pick<CameraRig, "azimuth" | "polar">): Vec3 {
  const sinPolar = Math.sin(rig.polar);
  return [sinPolar * Math.sin(rig.azimuth), Math.cos(rig.polar), sinPolar * Math.cos(rig.azimuth)];
}

/** 相机机位 = 目标点 + 方向 × 距离。 */
export function rigPosition(rig: CameraRig): Vec3 {
  const [dx, dy, dz] = rigDirection(rig);
  return [rig.target[0] + dx * rig.distance, rig.target[1] + dy * rig.distance, rig.target[2] + dz * rig.distance];
}

/** 正交窗格的半高（世界单位）。宽高比由 camera.rect 负责，这里只管竖直方向。 */
export function orthoHalfHeight(): number {
  return ORTHO_VIEW_WORLD_HEIGHT / 2;
}

/** 轨道旋转。极角钳制在开区间内，避免俯视到正上方时 up 与视线共线。 */
export function orbitBy(rig: CameraRig, deltaAzimuth: number, deltaPolar: number): CameraRig {
  return {
    ...rig,
    azimuth: rig.azimuth + deltaAzimuth,
    polar: clamp(rig.polar + deltaPolar, MIN_POLAR, MAX_POLAR),
  };
}

/** 缩放：**乘性**（滚轮每格感觉一致），并钳到 [MIN_DISTANCE, MAX_DISTANCE]。 */
export function dollyBy(rig: CameraRig, factor: number): CameraRig {
  if (!Number.isFinite(factor) || factor <= 0) return rig;
  return { ...rig, distance: clamp(rig.distance * factor, MIN_DISTANCE, MAX_DISTANCE) };
}

/**
 * 平移：把像素位移换算成目标点在世界里的位移。
 *
 * `worldHeightAtTarget` 是目标平面上可见的世界高度（透视用 `2·d·tan(fov/2)`，
 * 正交用 `ORTHO_VIEW_WORLD_HEIGHT`）——两个投影的"一格像素等于多少世界单位"不同，
 * 所以必须由调用方按当前投影算好传进来，不能在这里猜。
 *
 * `worldUp` 是**这个窗格相机的上方向**，默认世界 +Y。俯视窗格的上方向是 `(0,0,-1)`
 * （`ORTHO_UP.top`，见 `playcanvas/cameraRig.ts`），不传就按 +Y 算——那会让俯视窗格
 * 的平移方向差 90°。调用方应该把它**和喂给 `applyRig` 的 up 用同一个值**。
 */
export function panBy(
  rig: CameraRig,
  deltaXPx: number,
  deltaYPx: number,
  paneHeightPx: number,
  worldHeightAtTarget: number,
  worldUp: Vec3 = [0, 1, 0],
): CameraRig {
  if (paneHeightPx <= 0 || worldHeightAtTarget <= 0) return rig;
  const perPixel = worldHeightAtTarget / paneHeightPx;
  // 屏幕右 = 相机右向；屏幕上 = 相机上向。目标点**反向**移动，画面才跟着手走。
  const [dx, dy, dz] = rigDirection(rig);
  // 相机的 forward 是 -dir（dir 是 target → 相机）。
  const forward: Vec3 = [-dx, -dy, -dz];
  // 相机右向 = normalize(cross(forward, worldUp))；视线与 up 共线时退化（俯视正下方配上 +Y），退回世界 X
  const right: Vec3 = (() => {
    const rx = forward[1] * worldUp[2] - forward[2] * worldUp[1];
    const ry = forward[2] * worldUp[0] - forward[0] * worldUp[2];
    const rz = forward[0] * worldUp[1] - forward[1] * worldUp[0];
    const len = Math.hypot(rx, ry, rz);
    return len < 1e-6 ? [1, 0, 0] : [rx / len, ry / len, rz / len];
  })();
  // 相机上向 = cross(right, forward)
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const sx = -deltaXPx * perPixel;
  const sy = deltaYPx * perPixel;
  return {
    ...rig,
    target: [
      rig.target[0] + right[0] * sx + up[0] * sy,
      rig.target[1] + right[1] * sx + up[1] * sy,
      rig.target[2] + right[2] * sx + up[2] * sy,
    ],
  };
}

/** 把 `radius` 的包围球装进画面所需的距离（含 `margin` 余量）。 */
export function fitDistance(radius: number, fovDegrees: number, margin = 1.35): number {
  const safeRadius = Math.max(radius, 1e-3);
  const halfFov = (fovDegrees * Math.PI) / 360;
  return (safeRadius / Math.tan(halfFov)) * margin;
}

/** 聚焦到某个包围球：目标点移到球心，距离按 `fitDistance`。 */
export function focusOn(rig: CameraRig, target: Vec3, radius: number, margin = 1.35): CameraRig {
  return { ...rig, target, distance: clamp(fitDistance(radius, rig.fov, margin), MIN_DISTANCE, MAX_DISTANCE) };
}
