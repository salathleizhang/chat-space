import { describe, expect, test } from "bun:test";
import { Mat4 } from "playcanvas";
import * as THREE from "three";
import {
  createSelectionTransform, eulerXyzFromQuat, freezeRelatives, matrixFromPlacement, placementFromMatrix,
  placementsFromPivot, positionsBounds, quatFromEulerXyz, selectionPivot,
  type Member, type Placement, type Vec3Tuple,
} from "./selectionTransform";

const placement = (over: Partial<Placement> = {}): Placement => ({
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...over,
});
const member = (id: string, over: Partial<Placement> = {}): Member => ({ id, placement: placement(over) });
const worst = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
};

const ANGLES: Vec3Tuple[] = [[0, 0, 0], [0.3, 0, 0], [0, 0.5, 0], [0, 0, -0.9], [0.3, 0.5, 0.9], [-1.2, 0.4, 2.6]];

describe("欧拉约定：**以 three 为真值**（这一步错了会静默转错朝向）", () => {
  test("quatFromEulerXyz == three.setFromEuler(Euler(x,y,z,'XYZ'))（弧度）", () => {
    for (const [x, y, z] of ANGLES) {
      const mine = quatFromEulerXyz([x, y, z]);
      const oracle = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
      expect(worst([mine.x, mine.y, mine.z, mine.w], [oracle.x, oracle.y, oracle.z, oracle.w])).toBeLessThan(1e-12);
    }
  });

  test("matrixFromPlacement == three 的 Object3D 矩阵（同一位姿两套引擎必须同矩阵）", () => {
    for (const rotation of ANGLES) {
      const p = placement({ position: [1.5, -2, 3.25], rotation, scale: [2, 0.5, 1.5] });
      const mine = matrixFromPlacement(p);
      const oracle = new THREE.Matrix4().compose(
        new THREE.Vector3(...p.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation, "XYZ")),
        new THREE.Vector3(...p.scale),
      );
      expect(worst(mine.data, oracle.elements)).toBeLessThan(1e-6);
    }
  });

  test("placementFromMatrix 与 three 的 decompose + Euler XYZ 一致（可往返）", () => {
    for (const rotation of ANGLES) {
      const p = placement({ position: [-0.75, 4, 0.5], rotation, scale: [1.25, 3, 0.8] });
      const back = placementFromMatrix(matrixFromPlacement(p));
      const oracleMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(...p.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation, "XYZ")),
        new THREE.Vector3(...p.scale),
      );
      const oraclePosition = new THREE.Vector3();
      const oracleQuat = new THREE.Quaternion();
      const oracleScale = new THREE.Vector3();
      oracleMatrix.decompose(oraclePosition, oracleQuat, oracleScale);
      const oracleEuler = new THREE.Euler().setFromQuaternion(oracleQuat, "XYZ");
      expect(worst(back.position, [oraclePosition.x, oraclePosition.y, oraclePosition.z])).toBeLessThan(1e-6);
      expect(worst(back.scale, [oracleScale.x, oracleScale.y, oracleScale.z])).toBeLessThan(1e-6);
      // 欧拉三元组在正常区间内应与 three 输出逐项一致
      if (Math.abs(Math.cos(rotation[1])) > 1e-3) {
        expect(worst(back.rotation, [oracleEuler.x, oracleEuler.y, oracleEuler.z])).toBeLessThan(1e-6);
      }
      // 再组合回去必须回到同一个矩阵
      expect(worst(matrixFromPlacement(back).data, oracleMatrix.elements)).toBeLessThan(1e-6);
    }
  });

  test("eulerXyzFromQuat 与 three 一致，含万向锁（y = ±π/2）", () => {
    for (const [x, y, z] of [...ANGLES, [0.4, Math.PI / 2, 0.7], [-1, -Math.PI / 2, 2]] as Vec3Tuple[]) {
      const mine = eulerXyzFromQuat(quatFromEulerXyz([x, y, z]));
      const oracle = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ")), "XYZ",
      );
      // 万向锁时 x/z 不唯一，比矩阵而不是比三元组
      expect(worst(matrixFromPlacement(placement({ rotation: mine })).data,
        new THREE.Matrix4().makeRotationFromEuler(oracle).elements)).toBeLessThan(1e-6);
    }
  });

  test("引擎自带的欧拉 API 是**度数 + ZYX**——所以不能直接喂摆放三元组（记录这条实测）", () => {
    const radians: Vec3Tuple = [0.3, 0.5, 0.9];
    const DEG = 180 / Math.PI;
    const engineMatrix = new Mat4().setFromEulerAngles(radians[0] * DEG, radians[1] * DEG, radians[2] * DEG);
    const threeXyz = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...radians, "XYZ"));
    const threeZyx = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...radians, "ZYX"));
    expect(worst(engineMatrix.data, threeXyz.elements)).toBeGreaterThan(0.4); // 不是 three 的 XYZ
    expect(worst(engineMatrix.data, threeZyx.elements)).toBeLessThan(1e-6); // 是 three 的 ZYX
    // 而本模块的换算与 three 的 XYZ 一致
    expect(worst(matrixFromPlacement(placement({ rotation: radians })).data, threeXyz.elements)).toBeLessThan(1e-6);
  });
});

describe("轴心口径", () => {
  test("单选：pivot 就是该成员自身的摆放（gizmo 落在物体原点上）", () => {
    const only = member("a", { position: [3, -1, 2], rotation: [0.2, 0.4, 0.6], scale: [2, 2, 2] });
    expect(selectionPivot([only])).toEqual(only.placement);
  });

  test("多选：位置包围盒中心 + 姿态归零 + 缩放归一", () => {
    const pivot = selectionPivot([
      member("a", { position: [-2, 0, 4], rotation: [1, 1, 1], scale: [3, 3, 3] }),
      member("b", { position: [4, 6, -2] }),
      member("c", { position: [0, 3, 1] }),
    ]);
    expect(pivot!.position).toEqual([1, 3, 1]);
    expect(pivot!.rotation).toEqual([0, 0, 0]);
    expect(pivot!.scale).toEqual([1, 1, 1]);
  });

  test("顺序无关；空集合没有轴心", () => {
    const a = member("a", { position: [-2, 0, 4] });
    const b = member("b", { position: [4, 6, -2] });
    expect(selectionPivot([a, b])).toEqual(selectionPivot([b, a]));
    expect(selectionPivot([])).toBeNull();
    expect(positionsBounds([])).toBeNull();
  });

  test("positionsBounds 给线框用：中心/尺寸/极值", () => {
    const bounds = positionsBounds([member("a", { position: [-1, 2, 3] }), member("b", { position: [5, -2, 3] })])!;
    expect(bounds.min).toEqual([-1, -2, 3]);
    expect(bounds.max).toEqual([5, 2, 3]);
    expect(bounds.center).toEqual([2, 0, 3]);
    expect(bounds.size).toEqual([6, 4, 0]);
  });
});

describe("冻结相对矩阵 → 由 pivot 还原各成员", () => {
  test("单选：相对矩阵是单位阵；平移 pivot 等于平移成员", () => {
    const only = member("a", { position: [1, 2, 3], rotation: [0.3, 0, 0], scale: [2, 2, 2] });
    const pivot = selectionPivot([only])!;
    const frozen = freezeRelatives(pivot, [only]);
    expect(worst(frozen[0]!.relative.data, new Mat4().data)).toBeLessThan(1e-7);
    const moved = placementsFromPivot({ ...pivot, position: [4, 6, 8] }, frozen);
    expect(moved.a!.position[0]).toBeCloseTo(4, 6);
    expect(moved.a!.position[1]).toBeCloseTo(6, 6);
    expect(moved.a!.position[2]).toBeCloseTo(8, 6);
    // 旋转/缩放原样保留
    expect(moved.a!.rotation[0]).toBeCloseTo(0.3, 6);
    // 引擎 Mat4/Quat 是 Float32：缩放读回来是 1.9999999 这类值，别用 toEqual
    for (const [i, expected] of [2, 2, 2].entries()) expect(moved.a!.scale[i]!).toBeCloseTo(expected, 6);
  });

  test("多选：绕轴心整体旋转 90°（Y 轴）——成员绕中心转，间距不变", () => {
    const members = [member("a", { position: [-1, 0, 0] }), member("b", { position: [1, 0, 0] })];
    const pivot = selectionPivot(members)!; // (0,0,0)
    const frozen = freezeRelatives(pivot, members);
    const rotated = placementsFromPivot({ ...pivot, rotation: [0, Math.PI / 2, 0] }, frozen);
    // +X 方向绕 Y 转 +90° ⇒ -Z 方向（three 右手系）
    expect(rotated.b!.position[0]).toBeCloseTo(0, 6);
    expect(rotated.b!.position[2]).toBeCloseTo(-1, 6);
    expect(rotated.a!.position[2]).toBeCloseTo(1, 6);
    // 到轴心的距离不变
    const distance = (p: Vec3Tuple) => Math.hypot(p[0], p[1], p[2]);
    expect(distance(rotated.a!.position)).toBeCloseTo(1, 6);
    expect(distance(rotated.b!.position)).toBeCloseTo(1, 6);
  });

  test("多选：绕轴心整体缩放 2 倍——偏移加倍、成员自身缩放也加倍", () => {
    const members = [member("a", { position: [-1, 1, 0] }), member("b", { position: [3, 1, 0] })];
    const pivot = selectionPivot(members)!; // (1,1,0)
    const frozen = freezeRelatives(pivot, members);
    const scaled = placementsFromPivot({ ...pivot, scale: [2, 2, 2] }, frozen);
    expect(scaled.a!.position[0]).toBeCloseTo(-3, 6);
    expect(scaled.b!.position[0]).toBeCloseTo(5, 6);
    expect(scaled.a!.scale[0]).toBeCloseTo(2, 6);
  });

  test("pivot 姿态不变时成员一个像素都不动（避免拖拽起始抖动）", () => {
    const members = [
      member("a", { position: [-2, 1, 0.5], rotation: [0.1, 0.2, 0.3], scale: [1.5, 1, 2] }),
      member("b", { position: [2, 3, -1], rotation: [-0.4, 0, 0.9], scale: [1, 2, 1] }),
    ];
    const pivot = selectionPivot(members)!;
    const frozen = freezeRelatives(pivot, members);
    const same = placementsFromPivot(pivot, frozen);
    for (const m of members) {
      expect(worst(same[m.id]!.position, m.placement.position)).toBeLessThan(1e-6);
      expect(worst(same[m.id]!.scale, m.placement.scale)).toBeLessThan(1e-6);
      expect(worst(matrixFromPlacement(same[m.id]!).data, matrixFromPlacement(m.placement).data)).toBeLessThan(1e-6);
    }
  });
});

describe("拖拽生命周期（对应 three 侧三个 handler）", () => {
  function fixture(members: Member[]) {
    const live = new Map<string, Placement>();
    const commits: { updates: Record<string, Placement>; mode: string }[] = [];
    const handle = createSelectionTransform({
      writeLive: (updates) => { for (const [id, p] of Object.entries(updates)) live.set(id, p); },
      clearLive: () => live.clear(),
      onCommit: (updates, mode) => commits.push({ updates, mode }),
    });
    let current = members;
    return {
      handle, live, commits,
      // 走控制器的正式入口：它同时换成员并重算轴心（只 handle.reset() 的话没人把成员交进去）
      setMembers: (next: Member[]) => { current = next; handle.setMembers(next); },
      current: () => current,
    };
  }

  test("begin → update 写实时表 → end 提交一次并清表", () => {
    const f = fixture([member("a", { position: [-1, 0, 0] }), member("b", { position: [1, 0, 0] })]);
    f.setMembers(f.current());
    expect(f.handle.active()).toBe(false);
    expect(f.handle.begin()).toBe(true);
    expect(f.handle.active()).toBe(true);
    const moved = f.handle.update({ ...f.handle.pivot()!, position: [0, 5, 0] });
    expect(Object.keys(moved!).sort()).toEqual(["a", "b"]);
    expect(f.live.size).toBe(2);
    const committed = f.handle.end("translate");
    expect(f.commits.length).toBe(1);
    expect(f.commits[0]!.mode).toBe("translate");
    expect(f.live.size).toBe(0); // 先清表再提交
    expect(committed!.updates.a!.position[1]).toBeCloseTo(5, 6);
    expect(f.handle.active()).toBe(false);
  });

  test("没 begin 就 update/end 都返回 null（不会误提交）", () => {
    const f = fixture([member("a")]);
    f.setMembers(f.current());
    expect(f.handle.update(f.handle.pivot()!)).toBeNull();
    expect(f.handle.end("translate")).toBeNull();
    expect(f.commits).toEqual([]);
  });

  test("abort 只清表不提交（切布局/卸载兜底）", () => {
    const f = fixture([member("a")]);
    f.setMembers(f.current());
    f.handle.begin();
    f.handle.update({ ...f.handle.pivot()!, position: [9, 9, 9] });
    f.handle.abort();
    expect(f.commits).toEqual([]);
    expect(f.live.size).toBe(0);
    expect(f.handle.active()).toBe(false);
    // 幂等
    f.handle.abort();
  });

  test("空选中：没有轴心、begin 返回 false", () => {
    const f = fixture([]);
    f.setMembers([]);
    expect(f.handle.pivot()).toBeNull();
    expect(f.handle.begin()).toBe(false);
  });
});
