import type { CameraRig } from "../../../shared/lib/cameraRig";
import type { CameraKind } from "../../../widgets/Viewport/paneLayouts";

/**
 * `CameraKind` → 初始台架。**轴向约定由单测钉住**（`paneRigPresets.test.ts`），因为它错了两边都
 * 静默：视口照样出画面，只是"顶视图"变成了侧视图。
 *
 * `rigDirection = [sin(polar)·sin(azimuth), cos(polar), sin(polar)·cos(azimuth)]`，机位 =
 * 目标点 + 方向 × 距离，所以：
 * - `azimuth = 0, polar = π/2` → 方向 `[0,0,1]` ⇒ 相机在 **+Z**，朝 −Z 看 = **前视图**；
 * - `azimuth = π/2, polar = π/2` → 方向 `[1,0,0]` ⇒ 相机在 **+X**，朝 −X 看 = **右视图**；
 * - `polar → 0` → 方向 `[0,1,0]` ⇒ 相机在正上方朝下看 = **顶视图**。
 *
 * 顶视图的极角**取一个小 ε 而不是 0**：正上方时视线与默认 up 共线，`lookAt` 退化
 * （`cameraRig.ts` 的 `orbitBy` 也为此把极角钳在开区间内）。
 */
export const TOP_POLAR_EPSILON = 1e-3;

/** 正交窗格的可见高度是产品常量（`ORTHO_VIEW_WORLD_HEIGHT`），与距离无关——距离只影响裁剪。 */
const ORTHO_DISTANCE = 12;
const TARGET: [number, number, number] = [0, 0.8, 0];

/**
 * three 侧**透视格的默认机位**（`widgets/Viewport/index.tsx` 的 `ORBIT_CAMERA` + `DEFAULT_LOOK_AT`）：
 * 机位 `[5, 4.5, 5]`、`fov 45`、看原点。
 *
 * 这里以前是自造的"总览机位"（方位角 0.22π、极角 1.15、距离 12、fov 60、目标 `[0,0.8,0]`），
 * 注释写着"不追精确一致，只求看得全"——于是同一个项目在两个分支下**构图明显不同**。
 * 用户要求"让 playcanvas 跟 three 参数效果一样"，机位也是参数：现在由这一份 three 的数值反解台架。
 */
export const THREE_ORBIT_CAMERA = {
  position: [5, 4.5, 5] as [number, number, number],
  target: [0, 0, 0] as [number, number, number],
  fov: 45,
} as const;

/**
 * 由"机位 + 目标 + fov"反解台架（方位角 / 极角 / 距离）。
 * 约定与 `shared/lib/cameraRig.ts` 的 `rigDirection` 一致：
 * `direction = [sin(polar)·sin(azimuth), cos(polar), sin(polar)·cos(azimuth)]`，
 * 机位 = 目标 + 方向 × 距离。所以 `azimuth = atan2(dx, dz)`、`polar = acos(dy / 距离)`。
 */
export function rigFromOrbit(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
  fov: number,
): CameraRig {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    target: [target[0], target[1], target[2]],
    azimuth: Math.atan2(dx, dz),
    polar: Math.acos(dy / distance),
    distance,
    fov,
    projection: "perspective",
  };
}

export function rigForPaneCamera(kind: CameraKind): CameraRig {
  switch (kind) {
    case "top":
      return { target: TARGET, azimuth: 0, polar: TOP_POLAR_EPSILON, distance: ORTHO_DISTANCE, fov: 60, projection: "orthographic" };
    case "front":
      return { target: TARGET, azimuth: 0, polar: Math.PI / 2, distance: ORTHO_DISTANCE, fov: 60, projection: "orthographic" };
    case "right":
      return { target: TARGET, azimuth: Math.PI / 2, polar: Math.PI / 2, distance: ORTHO_DISTANCE, fov: 60, projection: "orthographic" };
    case "perspective":
    default:
      // 透视格：与 three 的 `ORBIT_CAMERA` **同一机位**（位置 / 朝向 / fov 全对齐）
      return rigFromOrbit(THREE_ORBIT_CAMERA.position, THREE_ORBIT_CAMERA.target, THREE_ORBIT_CAMERA.fov);
  }
}