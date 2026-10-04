/**
 * 「静了多久才算落定」的状态机（two 渲染路径共用；与引擎无关，所以能单测）。
 *
 * ### 为什么不能只看"这一刻速度小"
 * 松手那一瞬物体**看起来也可能是静止的**：用户把沙发端在半空、停下鼠标再松开，
 * 球形关节会把它稳稳吊住 ⇒ 那一刻速度 ≈ 0。照"速度小就落盘"判，会在**半空**里
 * 记下摆放，随后重力把它放到地上——两本账差了整整一个高度，而且这种松开方式
 * （停下来、再放下）恰恰是最常见的"我就放在这儿"。
 *
 * 所以要求**连续静够 `SETTLE_HOLD_MS`**：只要重力/碰撞让物体重新动起来，
 * 计时立刻清零、重新开始等（`settleHeld` 的第三个分支就是这条）。
 */

/** 连续静止多久才算落定（毫秒）：约为若干物理步，够重力把"假静止"揭穿 */
export const SETTLE_HOLD_MS = 150;

/**
 * 推进一次判据，返回"这次要不要落盘"与新的计时起点。
 *
 * @param stillSince 上一次的计时起点（`null` = 上一帧还在动）
 * @param settledNow 这一帧是不是静下来了（调用方按速度/睡着判）
 * @param now        当前时刻（毫秒，`Date.now()`）
 */
export function settleHeld(
  stillSince: number | null,
  settledNow: boolean,
  now: number,
  holdMs = SETTLE_HOLD_MS,
): { commit: boolean; stillSince: number | null } {
  if (!settledNow) return { commit: false, stillSince: null };
  // 刚静下来的第一帧只记起点，绝不落盘：这一刻正可能是"关节还吊着"的假静止
  if (stillSince === null) return { commit: false, stillSince: now };
  return { commit: now - stillSince >= holdMs, stillSince };
}
