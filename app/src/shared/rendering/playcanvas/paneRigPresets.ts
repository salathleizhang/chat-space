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
      // 透视格：three 侧总览机位（方位角 0.22π、极角 1.15）——不追精确一致，只求"看得全"
      return { target: TARGET, azimuth: Math.PI * 0.22, polar: 1.15, distance: 12, fov: 60, projection: "perspective" };
  }
}