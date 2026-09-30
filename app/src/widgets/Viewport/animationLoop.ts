import type { AnimationAction } from "three";

/**
 * `frameloop="demand"` 下，这一帧结束后还要不要为下一帧续约。
 *
 * 判据是**片段真的在推进**，不是"这个模型带了片段"：
 *
 * - `LoopOnce` 播完后 three 会把 action 置成 `paused`（`clampWhenFinished`）或
 *   `enabled = false`，两者的 `isRunning()` 都变成 false → 续帧自然停止；
 * - 被 `stop()` 过、`timeScale === 0`、还没 `play()` 的 action 同样返回 false。
 *
 * 为什么不能只看"模型有没有片段"：`AnimatedObject` 本来**只在有片段时才渲染**
 * （见 `ModelMesh.tsx` 的 `ClonedAssembly` 分支），所以那是个恒真条件，等于无条件续帧。
 * 后果是只要场景里有一个带动画的模型，整块画布就永远以 vsync 重绘：`ClearFrame`、全部窗格的
 * core/overlay/HUD 三趟 render、以及每个可见 splat 视图的 `onBeforeRender` 全部每帧照跑，
 * `frameloop="demand"` 形同虚设。视口、预览小窗、缩略图三个画布都会中招。
 *
 * 抽成纯函数是为了能在没有 GPU、没有 R3F 画布的环境里直接验证（见 animationLoop.test.ts）。
 */
export function needsAnimationFrame(actions: readonly (AnimationAction | undefined)[]): boolean {
  return actions.some((action) => action?.isRunning() === true);
}
