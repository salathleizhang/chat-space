import { expect, test } from "bun:test";
import { sameRect, viewRect } from "./viewRect";

test("WebGPU panes use top-left coordinates, never WebGL bottom-left", () => {
  const canvas = { left: 20, top: 30 };
  const panes = [
    { left: 20, top: 30, width: 400, height: 300 },
    { left: 420, top: 30, width: 400, height: 300 },
    { left: 20, top: 330, width: 400, height: 300 },
    { left: 420, top: 330, width: 400, height: 300 },
  ];
  expect(panes.map((pane) => viewRect(canvas, pane))).toEqual([
    { left: 0, top: 0, width: 400, height: 300 },
    { left: 400, top: 0, width: 400, height: 300 },
    { left: 0, top: 300, width: 400, height: 300 },
    { left: 400, top: 300, width: 400, height: 300 },
  ]);
});

/*
  `getBoundingClientRect()` 每次返回新对象，所以按引用比较永远不相等。窗格矩形只在 window 的
  捕获相 scroll 里同步，而那个监听对"在模型列表/聊天记录里滚动"一样会触发——没有这个按值比较，
  一次与视口无关的滚动就会让每个窗格重渲染并多画一整帧。
*/
test("pane rects compare by value so an unmoved pane costs nothing", () => {
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  expect(sameRect(rect, { ...rect })).toBe(true);
  expect(sameRect(rect, { ...rect, left: 0.5 })).toBe(false);
  expect(sameRect(rect, { ...rect, top: -1 })).toBe(false);
  expect(sameRect(rect, { ...rect, width: 401 })).toBe(false);
  expect(sameRect(rect, { ...rect, height: 299 })).toBe(false);
});
