import { expect, test } from "bun:test";
import { ORTHO_VIEW_WORLD_HEIGHT, type CameraRig } from "../../../shared/lib/cameraRig";
import { applyRig, ORTHO_UP, type RigEntityLike } from "./cameraRig";

const PERSPECTIVE = 0;
const ORTHOGRAPHIC = 1;
const OPTIONS = { perspective: PERSPECTIVE, orthographic: ORTHOGRAPHIC };

function fakeEntity() {
  const calls: string[] = [];
  const entity: RigEntityLike = {
    up: { set: (x, y, z) => { calls.push(`up(${x},${y},${z})`); } },
    setPosition: (x, y, z) => { calls.push(`pos(${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)})`); },
    lookAt: (x, y, z) => { calls.push(`look(${x},${y},${z})`); },
    camera: { projection: -1, fov: 0, orthoHeight: 0, nearClip: 0, farClip: 0 },
  };
  return { entity, calls };
}

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10, fov: 60, projection: "perspective", ...over,
});

test("透视：写 fov 与 projection，不碰 orthoHeight", () => {
  const { entity } = fakeEntity();
  applyRig(entity, rig({ fov: 45 }), OPTIONS);
  expect(entity.camera.projection).toBe(PERSPECTIVE);
  expect(entity.camera.fov).toBe(45);
  expect(entity.camera.orthoHeight).toBe(0);
});

test("正交：写 orthoHeight = 7.5（竖直恒定可见 15 个世界单位），与窗格像素无关", () => {
  // three 侧要靠 zoom = 像素高/15 每帧反推；这里只有一个常量。
  const { entity } = fakeEntity();
  applyRig(entity, rig({ projection: "orthographic", distance: 200 }), OPTIONS);
  expect(entity.camera.projection).toBe(ORTHOGRAPHIC);
  expect(entity.camera.orthoHeight).toBe(ORTHO_VIEW_WORLD_HEIGHT / 2);
  // 距离变了也不影响正交可见高度——这正是"恒定"的含义
  const far = fakeEntity();
  applyRig(far.entity, rig({ projection: "orthographic", distance: 3 }), OPTIONS);
  expect(far.entity.camera.orthoHeight).toBe(entity.camera.orthoHeight);
});

test("机位与朝向：位置 = 目标 + 方向×距离，lookAt 指回目标", () => {
  const { entity, calls } = fakeEntity();
  applyRig(entity, rig({ target: [1, 2, 3], distance: 10 }), OPTIONS);
  expect(calls).toContain("pos(1.000,2.000,13.000)");
  expect(calls).toContain("look(1,2,3)");
});

test("上方向可覆盖：俯视窗格必须用 (0,0,-1)，否则会有 45° 滚转", () => {
  const { entity, calls } = fakeEntity();
  applyRig(entity, rig(), { ...OPTIONS, up: ORTHO_UP.top });
  expect(calls).toContain("up(0,0,-1)");
  expect(ORTHO_UP.top).toEqual([0, 0, -1]);
  // 默认是 Y-up
  const plain = fakeEntity();
  applyRig(plain.entity, rig(), OPTIONS);
  expect(plain.calls).toContain("up(0,1,0)");
});

test("裁剪面跟随距离，且近裁剪恒为正（0 会让投影矩阵退化）", () => {
  const { entity } = fakeEntity();
  applyRig(entity, rig({ distance: 10 }), OPTIONS);
  expect(entity.camera.nearClip).toBeGreaterThan(0);
  expect(entity.camera.farClip).toBeGreaterThan(entity.camera.nearClip);
  const tiny = fakeEntity();
  applyRig(tiny.entity, rig({ distance: 0.001 }), OPTIONS);
  expect(tiny.entity.camera.nearClip).toBeGreaterThan(0);
});
