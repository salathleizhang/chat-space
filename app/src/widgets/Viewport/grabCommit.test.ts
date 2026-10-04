import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { dropPoseMoved, placementFromBodyPose } from "./grabCommit";
import type { AssetPlacement } from "./scenePlacement";

/** 用 three 当真值构造四元数（与引擎侧同一套约定：弧度 + XYZ） */
function quat(euler: [number, number, number]): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2]));
  return [q.x, q.y, q.z, q.w];
}

const placed = (over: Partial<AssetPlacement> = {}): AssetPlacement => ({
  position: [1, 0, 2],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...over,
});

describe("placementFromBodyPose", () => {
  test("位置原样带过来，缩放取原摆放（物理不改缩放）", () => {
    const result = placementFromBodyPose(
      { position: [3, 0.5, -1], quaternion: quat([0, 0, 0]) },
      [2, 2, 2],
    );
    expect(result.position).toEqual([3, 0.5, -1]);
    expect(result.scale).toEqual([2, 2, 2]);
    expect(result.rotation.map((v) => +v.toFixed(6))).toEqual([0, 0, 0]);
  });

  test("四元数 → 欧拉 XYZ 弧度：与 TransformGizmo 的分解同源（绕 Y 转 90°）", () => {
    const result = placementFromBodyPose(
      { position: [0, 0, 0], quaternion: quat([0, Math.PI / 2, 0]) },
      [1, 1, 1],
    );
    expect(result.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(result.rotation[0]).toBeCloseTo(0, 6);
    expect(result.rotation[2]).toBeCloseTo(0, 6);
  });

  test("非单位四元数先归一化（引擎给的不保证是单位长度）", () => {
    const [x, y, z, w] = quat([0, Math.PI / 2, 0]);
    const scaled = placementFromBodyPose(
      { position: [0, 0, 0], quaternion: [x * 3, y * 3, z * 3, w * 3] },
      [1, 1, 1],
    );
    expect(scaled.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("dropPoseMoved", () => {
  test("一动没动：不提交（抓一下又放开不该多一条撤销步骤）", () => {
    const before = placed();
    expect(dropPoseMoved(before, { position: [1, 0, 2], quaternion: quat([0, 0, 0]) })).toBe(false);
  });

  test("同一姿态的**另一种欧拉写法**不算动过（欧拉是多对一的，逐分量比会误判）", () => {
    /*
      (0, π, 0) 与 (π, 0, π) 是同一个朝向，只是万向节那种写法不同。
      逐分量比欧拉 ⇒ 这里会误判成"转过"，于是抓起来立刻放开也会写一条 "Move"。
    */
    const written = placed({ rotation: [0, Math.PI, 0] });
    expect(dropPoseMoved(written, { position: [1, 0, 2], quaternion: quat([Math.PI, 0, Math.PI]) })).toBe(false);
  });

  test("q 与 −q 是同一姿态：也不算动过", () => {
    const before = placed({ rotation: [0, Math.PI / 2, 0] });
    const [x, y, z, w] = quat([0, Math.PI / 2, 0]);
    expect(dropPoseMoved(before, { position: [1, 0, 2], quaternion: [-x, -y, -z, -w] })).toBe(false);
  });

  test("位置挪过 1 cm：算动过（阈值是毫米级，不是「肉眼看不出来」）", () => {
    expect(dropPoseMoved(placed(), { position: [1.01, 0, 2], quaternion: quat([0, 0, 0]) })).toBe(true);
  });

  test("只转过 1 弧度：算动过（位置没变也要提交）", () => {
    expect(dropPoseMoved(placed(), { position: [1, 0, 2], quaternion: quat([0, 1, 0]) })).toBe(true);
  });

  test("只转过 0.0001 弧度（物理解算的抖动）：不算动过", () => {
    expect(dropPoseMoved(placed(), { position: [1, 0, 2], quaternion: quat([0, 0.0001, 0]) })).toBe(false);
  });
});
