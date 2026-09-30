import { expect, test } from "bun:test";
import { ArrayCamera, OrthographicCamera, PerspectiveCamera } from "three";
import { ARRAY_CAMERA_CAPACITY, fitCameraToViewport, syncArrayCamera, type PaneView } from "./paneViewports";

function pane(camera: PerspectiveCamera | OrthographicCamera, layer: number, size = 10): PaneView {
  return { layer, resolve: () => ({ camera, left: 1, top: 2, ...{ width: size, height: size } }) };
}

/*
  回归：子相机数量**必须恒定**。

  这条不是洁癖。three 给 `cameraProjectionMatrices` 分配的 uniform buffer 按当时的相机数定容，
  之后按名字共享且**不会增长**；实测 2 窗格时建了 128 字节（2 × 64），切到 4 窗格时
  `Queue.WriteBuffer` 写 256 字节 → `GPUValidationError`，整个画布直接落到 "3D rendering needs WebGPU"
  失败面板。所以不足的槽位要用空相机补齐，而不是让数组变短。
*/
test("子相机数量恒定，不足的槽位用空相机补齐", () => {
  const arrayCamera = new ArrayCamera();
  const first = new PerspectiveCamera();
  const second = new PerspectiveCamera();

  expect(syncArrayCamera(arrayCamera, [pane(first, 1)])).toBe(1);
  expect(arrayCamera.cameras.length).toBe(ARRAY_CAMERA_CAPACITY);
  expect(arrayCamera.cameras[0]).toBe(first);
  // 空相机与任何对象都不相交 → 后端一次 draw 都不会为它发
  for (let slot = 1; slot < ARRAY_CAMERA_CAPACITY; slot += 1) {
    expect(arrayCamera.cameras[slot]!.layers.mask).toBe(0);
  }

  expect(syncArrayCamera(arrayCamera, [pane(first, 1), pane(second, 2)])).toBe(2);
  // 数量不变：这正是那条 GPUValidationError 的直接原因
  expect(arrayCamera.cameras.length).toBe(ARRAY_CAMERA_CAPACITY);
  expect(arrayCamera.cameras[1]).toBe(second);
  // 空槽位仍然空
  for (let slot = 2; slot < ARRAY_CAMERA_CAPACITY; slot += 1) {
    expect(arrayCamera.cameras[slot]!.layers.mask).toBe(0);
  }
});

test("每个真实子相机拿到自己的 layer mask 与视口", () => {
  const arrayCamera = new ArrayCamera();
  const perspective = new PerspectiveCamera();
  const orthographic = new OrthographicCamera();
  syncArrayCamera(arrayCamera, [pane(perspective, 1), pane(orthographic, 3)]);
  expect(perspective.layers.mask).toBe(1 | (1 << 1));
  expect(orthographic.layers.mask).toBe(1 | (1 << 3));
  // viewport 是**左上原点、CSS px**（three 在这条路径上不做 WebGL 的 height-h-y 翻转）
  expect(perspective.viewport!.x).toBe(1);
  expect(perspective.viewport!.y).toBe(2);
  expect(perspective.viewport!.width).toBe(10);
});

test("窗格卸载后不留上一帧的相机", () => {
  const arrayCamera = new ArrayCamera();
  const camera = new PerspectiveCamera();
  syncArrayCamera(arrayCamera, [pane(camera, 1)]);
  expect(arrayCamera.cameras[0]).toBe(camera);
  expect(syncArrayCamera(arrayCamera, [])).toBe(0);
  expect(arrayCamera.cameras.length).toBe(ARRAY_CAMERA_CAPACITY);
  expect(arrayCamera.cameras.every((entry) => entry.layers.mask === 0)).toBe(true);
});

test("尺寸为零的窗格不占用槽位", () => {
  const arrayCamera = new ArrayCamera();
  const camera = new PerspectiveCamera();
  expect(syncArrayCamera(arrayCamera, [pane(camera, 1, 0)])).toBe(0);
  expect(arrayCamera.cameras.every((entry) => entry.layers.mask === 0)).toBe(true);
});

test("相机投影按窗格尺寸适配，且值没变时不重建矩阵", () => {
  const perspective = new PerspectiveCamera();
  fitCameraToViewport(perspective, 400, 200);
  expect(perspective.aspect).toBe(2);
  const matrix = perspective.projectionMatrix.clone();
  fitCameraToViewport(perspective, 400, 200);
  expect(perspective.projectionMatrix.equals(matrix)).toBe(true);

  const orthographic = new OrthographicCamera();
  fitCameraToViewport(orthographic, 400, 200);
  expect([orthographic.left, orthographic.right, orthographic.top, orthographic.bottom]).toEqual([-200, 200, 100, -100]);
});
