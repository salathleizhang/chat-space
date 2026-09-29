/** WebGPU viewport/scissor coordinates start at the top, unlike WebGL. */
export function viewRect(canvas: { left: number; top: number }, pane: { left: number; top: number; width: number; height: number }) {
  return { left: pane.left - canvas.left, top: pane.top - canvas.top, width: pane.width, height: pane.height };
}
