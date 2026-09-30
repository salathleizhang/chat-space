import { expect, test } from "bun:test";
import {
  dollyBy, fitDistance, focusOn, MAX_DISTANCE, MAX_POLAR, MIN_DISTANCE, MIN_POLAR,
  ORTHO_VIEW_WORLD_HEIGHT, orbitBy, orthoHalfHeight, panBy, rigDirection, rigPosition,
  type CameraRig,
} from "./cameraRig";

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10, fov: 60, projection: "perspective", ...over,
});

test("正交窗格竖直可见高度恒定 15 个世界单位，与窗格像素无关", () => {
  // drei 侧要靠「zoom = 像素高/15」每帧反推，因为它的视锥是像素单位；
  // PlayCanvas 的 orthoHeight 本身就是世界单位半高，所以只剩这一条常量。
  expect(ORTHO_VIEW_WORLD_HEIGHT).toBe(15);
  expect(orthoHalfHeight()).toBe(7.5);
});

test("机位 = 目标点 + 方向 × 距离；极角 π/2 时水平", () => {
  // 逐分量近似：`cos(π/2)` 是 6.1e-17 而不是 0，用 toEqual 会假失败
  const [dx, dy, dz] = rigDirection({ azimuth: 0, polar: Math.PI / 2 });
  expect(dx).toBeCloseTo(0, 12);
  expect(dy).toBeCloseTo(0, 12);
  expect(dz).toBeCloseTo(1, 12);
  const [px, py, pz] = rigPosition(rig());
  expect(px).toBeCloseTo(0, 12);
  expect(py).toBeCloseTo(0, 12);
  expect(pz).toBeCloseTo(10, 12);
  // 极角 0 => 正上方
  const top = rigPosition(rig({ polar: 0.01 }));
  expect(top[1]).toBeCloseTo(10 * Math.cos(0.01), 6);
});

test("轨道旋转钳制极角，避免在正上/正下方与 up 共线导致滚转跳变", () => {
  expect(orbitBy(rig({ polar: 1 }), 0.5, -5).polar).toBe(MIN_POLAR);
  expect(orbitBy(rig({ polar: 1 }), 0.5, 5).polar).toBe(MAX_POLAR);
  // 方位角不钳制（可以无限绕）
  expect(orbitBy(rig(), 100, 0).azimuth).toBe(100);
});

test("缩放是乘性的，并钳在 [MIN_DISTANCE, MAX_DISTANCE]", () => {
  expect(dollyBy(rig({ distance: 10 }), 0.5).distance).toBe(5);
  expect(dollyBy(rig({ distance: 10 }), 2).distance).toBe(20);
  expect(dollyBy(rig({ distance: MAX_DISTANCE }), 2).distance).toBe(MAX_DISTANCE);
  expect(dollyBy(rig({ distance: MIN_DISTANCE }), 0.5).distance).toBe(MIN_DISTANCE);
  // 非法倍率不动（NaN 会污染整个状态）
  expect(dollyBy(rig(), Number.NaN).distance).toBe(10);
  expect(dollyBy(rig(), 0).distance).toBe(10);
});

test("平移：目标点反向移动，画面才跟着手走", () => {
  // 相机在 +Z 看向 -Z：世界右 = -X？验证"向右拖 → 目标点左移"这一方向约定
  const moved = panBy(rig({ distance: 10 }), 100, 0, 500, 20);
  expect(moved.target).not.toEqual([0, 0, 0]);
  // 位移量 = 像素 × (世界高/像素高)，方向与像素相反
  const perPixel = 20 / 500;
  expect(Math.hypot(...moved.target)).toBeCloseTo(Math.abs(100 * perPixel), 6);
  // 只动目标点，不动机位姿态
  expect([moved.azimuth, moved.polar, moved.distance]).toEqual([0, Math.PI / 2, 10]);
});

test("平移在退化输入下不动：零高度窗格 / 零世界高", () => {
  expect(panBy(rig(), 10, 10, 0, 20).target).toEqual([0, 0, 0]);
  expect(panBy(rig(), 10, 10, 500, 0).target).toEqual([0, 0, 0]);
});

test("平移的横纵基准跟随窗格自己的 up：俯视窗格必须传 (0,0,-1)", () => {
  // 非俯视时看不出差别，所以特意选一个**倾斜**的机位：视线与 +Y 不共线。
  const tilted = rig({ azimuth: 0.3, polar: 0.7 });
  // 默认按世界 +Y 算：屏幕右没有竖直分量 → 纯水平位移
  const worldUp = panBy(tilted, 100, 0, 500, 20);
  expect(worldUp.target[1]).toBeCloseTo(0, 12);
  // 俯视窗格的 up 是 (0,0,-1)：屏幕右带出俯仰分量。这正是"照世界 +Y 算会差 90°"的表现。
  const paneUp = panBy(tilted, 100, 0, 500, 20, [0, 0, -1]);
  expect(paneUp.target[1]).not.toBeCloseTo(0, 6);
  // 换基只改方向，不改位移量（两种基下 right 都是单位向量）
  expect(Math.hypot(...paneUp.target)).toBeCloseTo(Math.hypot(...worldUp.target), 6);
});

test("正交俯视窗格：向右拖 → 目标点沿 -X 走（屏幕右是 +X），画面跟着手走", () => {
  const top = rig({ polar: 0 }); // 相机在 +Y 正上方看向 -Y
  const moved = panBy(top, 100, 0, 500, ORTHO_VIEW_WORLD_HEIGHT, [0, 0, -1]);
  expect(moved.target[0]).toBeCloseTo(-100 * (ORTHO_VIEW_WORLD_HEIGHT / 500), 12);
  expect(moved.target[1]).toBeCloseTo(0, 12);
  expect(moved.target[2]).toBeCloseTo(0, 12);
});

test("聚焦：目标点移到球心，距离按包围球与 fov 算", () => {
  const focused = focusOn(rig(), [3, 1, -2], 2);
  expect(focused.target).toEqual([3, 1, -2]);
  expect(focused.distance).toBeCloseTo(fitDistance(2, 60), 6);
  // 半径越大要退得越远；fov 越大可以更近
  expect(fitDistance(4, 60)).toBeGreaterThan(fitDistance(2, 60));
  expect(fitDistance(2, 90)).toBeLessThan(fitDistance(2, 60));
  // 半径 0 也不能算出 0 距离（会退化）
  expect(fitDistance(0, 60)).toBeGreaterThan(0);
});

test("聚焦的距离也受钳制（超大模型不会把相机推到天外）", () => {
  expect(focusOn(rig(), [0, 0, 0], 1e9).distance).toBe(MAX_DISTANCE);
});
