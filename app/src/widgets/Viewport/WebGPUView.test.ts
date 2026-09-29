import { expect, test } from "bun:test";
import { viewRect } from "./viewRect";

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
