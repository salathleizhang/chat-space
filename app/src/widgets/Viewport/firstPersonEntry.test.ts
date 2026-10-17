import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  DEFAULT_FIRST_PERSON_ENTRY,
  ENTRY_GROUND_MARGIN,
  ENTRY_GROUND_Y,
  ENTRY_MAX_PITCH,
  firstPersonEntryFromControls,
  firstPersonEntryFromPose,
  yawPitchFromDirection,
} from "./firstPersonEntry";
import { CHARACTER_EYE_OFFSET } from "./physics";

/** three 当真值：把进场状态写进一台真相机，读它的世界视线 */
function worldDirectionOf(entry: { yaw: number; pitch: number }): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.quaternion.setFromEuler(new THREE.Euler(entry.pitch, entry.yaw, 0, "YXZ"));
  return camera.getWorldDirection(new THREE.Vector3());
}

describe("第一人称进场/firstPersonEntry", () => {
  test("回退就是改造前那个固定出生点（读不到机位时行为与改造前逐字一致）", () => {
    expect([...DEFAULT_FIRST_PERSON_ENTRY.spawn]).toEqual([0, CHARACTER_EYE_OFFSET + 0.2, 3]);
    expect(DEFAULT_FIRST_PERSON_ENTRY.yaw).toBe(0);
    expect(DEFAULT_FIRST_PERSON_ENTRY.pitch).toBe(0);
    expect(firstPersonEntryFromControls(null)).toEqual(DEFAULT_FIRST_PERSON_ENTRY);
    expect(firstPersonEntryFromControls(undefined)).toEqual(DEFAULT_FIRST_PERSON_ENTRY);
  });

  test("平面位置接当前机位：XZ 取相机自身，高度与相机的 y 无关（半空机位不掉下来）", () => {
    const lookAt = { x: 0, y: 0, z: 0 };
    const high = firstPersonEntryFromPose({ x: 5, y: 4.5, z: 5 }, lookAt);
    const low = firstPersonEntryFromPose({ x: 5, y: 0.9, z: 5 }, lookAt);
    expect(high.spawn).toEqual([5, ENTRY_GROUND_Y + CHARACTER_EYE_OFFSET + ENTRY_GROUND_MARGIN, 5]);
    expect(low.spawn).toEqual(high.spawn);
    // 脚略高于地面（留的那 0.2 m 余量），交给重力落定
    expect(high.spawn[1] - CHARACTER_EYE_OFFSET).toBeCloseTo(ENTRY_GROUND_MARGIN, 10);
  });

  test("朝向取相机这一帧的视线（用 three 的真相机当真值）", () => {
    const eye = { x: 2, y: 3, z: 4 };
    for (const target of [
      { x: 2, y: 3, z: -1 },   // 正前方：看向 -Z
      { x: -3, y: 3, z: 4 },   // 看向 -X
      { x: 7, y: 3, z: 4 },    // 看向 +X
      { x: 2, y: 3, z: 9 },    // 看向 +Z
      { x: 0, y: 1, z: 0 },    // 斜向下
    ]) {
      const entry = firstPersonEntryFromPose(eye, target);
      const expected = new THREE.Vector3(target.x - eye.x, target.y - eye.y, target.z - eye.z).normalize();
      const actual = worldDirectionOf(entry);
      expect(actual.x).toBeCloseTo(expected.x, 10);
      expect(actual.y).toBeCloseTo(expected.y, 10);
      expect(actual.z).toBeCloseTo(expected.z, 10);
      // 没有滚转：PointerLockControls 走 Euler 'YXZ'，第三分量必须是 0
      const euler = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(entry.pitch, entry.yaw, 0, "YXZ")),
        "YXZ",
      );
      expect(euler.z).toBeCloseTo(0, 10);
    }
  });

  test("俯仰钳在 ±(π/2 − 0.01)：正上方/正下方都不能与上方向共线", () => {
    expect(yawPitchFromDirection(0, 1, 0).pitch).toBeCloseTo(ENTRY_MAX_PITCH, 10);
    expect(yawPitchFromDirection(0, -1, 0).pitch).toBeCloseTo(-ENTRY_MAX_PITCH, 10);
    expect(yawPitchFromDirection(0, 100, 0).pitch).toBeLessThan(Math.PI / 2);
    // 抬头/低头方向不能反：俯仰 > 0 时视线朝上
    expect(worldDirectionOf(yawPitchFromDirection(0, 1, 0)).y).toBeGreaterThan(0);
    expect(worldDirectionOf(yawPitchFromDirection(0, -1, 0)).y).toBeLessThan(0);
  });

  test("退化输入不许产生 NaN（NaN 会一路写进相机四元数 ⇒ 纯黑且零报错）", () => {
    // 眼睛就落在注视点上：没有任何方向可接
    expect(firstPersonEntryFromPose({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toEqual({
      spawn: [1, ENTRY_GROUND_Y + CHARACTER_EYE_OFFSET + ENTRY_GROUND_MARGIN, 1],
      yaw: 0,
      pitch: 0,
    });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const angles = yawPitchFromDirection(bad, bad, bad);
      expect(Number.isFinite(angles.yaw)).toBe(true);
      expect(Number.isFinite(angles.pitch)).toBe(true);
      expect(angles).toEqual({ yaw: 0, pitch: 0 });
    }
  });

  test("从窗格控制器读：真实相机的 position/target 直接可用", () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(3, 6, -2);
    camera.lookAt(0, 1, 0);
    const controls = { object: camera, target: new THREE.Vector3(0, 1, 0), update: () => {} };
    const entry = firstPersonEntryFromControls(controls);
    expect(entry.spawn).toEqual([3, ENTRY_GROUND_Y + CHARACTER_EYE_OFFSET + ENTRY_GROUND_MARGIN, -2]);
    const expected = camera.getWorldDirection(new THREE.Vector3());
    const actual = worldDirectionOf(entry);
    expect(actual.x).toBeCloseTo(expected.x, 10);
    expect(actual.y).toBeCloseTo(expected.y, 10);
    expect(actual.z).toBeCloseTo(expected.z, 10);
  });
});
