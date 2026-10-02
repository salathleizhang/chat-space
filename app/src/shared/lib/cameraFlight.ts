/**
 * 相机飞行的纯数学（不 import three，进得了单测）。
 *
 * 两个入口共用同一份口径：
 *  - `CameraRig`（双击模型列表触发的聚焦缓动，只挂在透视窗格）；
 *  - `CloseupInspectionRig`（agent 的贴近检查：飞到模型旁边 → 拍 → 飞回原机位）。
 *
 * 常数与步进式分开写迟早会漂，症状是"看着已经到了、判定还没到"——动画每帧都在跑、
 * 但飞行永远结束不了；或者反过来的"没到位就拍"，图里的模型是歪的。所以这里只放一份，
 * 两边都从这里取（`cameraFlight.test.ts` 钉住数值与单调收敛）。
 */

/** 缓动系数（越大越快收敛）。与双击聚焦的历史手感一致，不要随手调。 */
export const FLIGHT_DAMP_LAMBDA = 4;

/** 到达阈值（平方）：**0.02 世界单位**。写成平方是为了免掉每帧一次开方。 */
export const FLIGHT_ARRIVE_EPS_SQ = 0.02 * 0.02;

/**
 * three `MathUtils.damp` 的同式实现：`y + (x − y)·e^(−λ·dt)`。
 * 用同一表达式而不是各自调 three，是为了让"两边手感一样"这件事可被单测证明。
 */
export function dampToward(
  current: number,
  target: number,
  lambda: number,
  delta: number,
): number {
  return target + (current - target) * Math.exp(-lambda * delta);
}

/** 位置差是否已经落在到达阈值内（严格小于）。 */
export function hasArrived(
  dx: number,
  dy: number,
  dz: number,
  epsilonSq = FLIGHT_ARRIVE_EPS_SQ,
): boolean {
  return dx * dx + dy * dy + dz * dz < epsilonSq;
}
