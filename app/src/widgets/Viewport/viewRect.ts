/** WebGPU viewport/scissor coordinates start at the top, unlike WebGL. */
export function viewRect(canvas: { left: number; top: number }, pane: { left: number; top: number; width: number; height: number }) {
  return { left: pane.left - canvas.left, top: pane.top - canvas.top, width: pane.width, height: pane.height };
}

/**
 * 两个矩形在数值上是否相同。
 *
 * 为什么不能用 `===`：`Element.getBoundingClientRect()` 每次都返回一个**新对象**，所以按引用
 * 比较永远不相等，React 也就永远无法 bail out。而窗格矩形是挂在 window 上的捕获相 `scroll`
 * 监听里同步的——在模型列表或聊天记录里滚一下也会打进来——于是旧写法会把"窗格根本没动"
 * 的一次滚动变成"重渲染每个窗格 + 多画一整帧"。
 */
export function sameRect(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
