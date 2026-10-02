import { describe, expect, test } from "bun:test";
import { Quat, Vec3 } from "playcanvas";
import * as THREE from "three";
import { applyEntityPlacement, readEntityPlacement, type PlacementEntityLike } from "./panePlacement";
import { eulerXyzFromQuat, matrixFromPlacement, quatFromEulerXyz, type Placement, type Vec3Tuple } from "./selectionTransform";

/** 假实体：内部只存四元数（与引擎一样），**没有**"欧拉三元组"这个成员。 */
function fakeEntity(): PlacementEntityLike & { quat: Quat } {
  const quat = new Quat();
  const position = { x: 0, y: 0, z: 0 };
  const scale = { x: 1, y: 1, z: 1 };
  return {
    quat,
    getPosition: () => ({ ...position }),
    getRotation: () => ({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
    getLocalScale: () => ({ ...scale }),
    setPosition: (x, y, z) => { position.x = x; position.y = y; position.z = z; },
    setRotation: (rotation) => { quat.set(rotation.x, rotation.y, rotation.z, rotation.w); },
    setLocalScale: (x, y, z) => { scale.x = x; scale.y = y; scale.z = z; },
  };
}

const ANGLES: Vec3Tuple[] = [[0, 0, 0], [0.3, 0, 0], [0, 0.5, 0], [0, 0, -0.9], [0.3, 0.5, 0.9], [-1.2, 0.4, 2.6]];

describe("实体 ↔ 摆放适配层", () => {
  test("写进去再读出来是同一份摆放（弧度 XYZ，不是度数）", () => {
    for (const rotation of ANGLES) {
      const entity = fakeEntity();
      const placement: Placement = { position: [1, -2, 3], rotation, scale: [2, 0.5, 1.5] };
      applyEntityPlacement(entity, placement);
      const back = readEntityPlacement(entity);
      expect(back.position).toEqual(placement.position);
      expect(back.scale).toEqual(placement.scale);
      // 欧拉三元组可能有等价表示（如 x+π），比矩阵更可靠
      expect(Math.max(...matrixFromPlacement(back).data.map((v, i) => Math.abs(v - matrixFromPlacement(placement).data[i]!))))
        .toBeLessThan(1e-6);
    }
  });

  test("写出的朝向与 three 一致（同一摆放两套引擎同朝向）", () => {
    for (const rotation of ANGLES) {
      const entity = fakeEntity();
      applyEntityPlacement(entity, { position: [0, 0, 0], rotation, scale: [1, 1, 1] });
      const mine = matrixFromPlacement(readEntityPlacement(entity));
      const oracle = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation, "XYZ"));
      expect(Math.max(...mine.data.map((v, i) => Math.abs(v - oracle.elements[i]!)))).toBeLessThan(1e-6);
    }
  });

  test("读旋转若误用引擎的 getEulerAngles（度数+ZYX）就会错——这条记录这个坑", () => {
    const rotation: Vec3Tuple = [0.3, 0.5, 0.9];
    const entity = fakeEntity();
    applyEntityPlacement(entity, { position: [0, 0, 0], rotation, scale: [1, 1, 1] });
    // 模拟"误用"：拿引擎的 Quat.getEulerAngles（度数、ZYX）当弧度直接当摆放
    const wrong = new Quat().copy(entity.quat).getEulerAngles(new Vec3());
    const wrongMatrix = matrixFromPlacement({ position: [0, 0, 0], rotation: [wrong.x, wrong.y, wrong.z], scale: [1, 1, 1] });
    const rightMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation, "XYZ"));
    const wrongDiff = Math.max(...wrongMatrix.data.map((v, i) => Math.abs(v - rightMatrix.elements[i]!)));
    expect(wrongDiff).toBeGreaterThan(0.1); // 确实错了，而且错得不小
    // 正确路径
    const rightMatrixMine = matrixFromPlacement({ position: [0, 0, 0], rotation: eulerXyzFromQuat(entity.quat), scale: [1, 1, 1] });
    expect(Math.max(...rightMatrixMine.data.map((v, i) => Math.abs(v - rightMatrix.elements[i]!)))).toBeLessThan(1e-6);
    // 顺带钉住"引擎欧拉是度数"：90 度才等于 three 的 π/2
    const engineQuatAt90 = new Quat().setFromEulerAngles(90, 0, 0);
    expect(engineQuatAt90.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(quatFromEulerXyz([Math.PI / 2, 0, 0]).x).toBeCloseTo(Math.SQRT1_2, 6);
  });
});
