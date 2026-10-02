import { describe, expect, test } from "bun:test";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { semanticPlacement, worldPlacement, type WorldSemanticsLike } from "./worldPlacement";
import type { Placement } from "./selectionTransform";

/**
 * 世界的语义变换与 three 侧**同一份契约**（`widgets/Viewport/worldTransform.ts`：
 * +Y 朝下 ⇒ 绕 X 转 π）。合成那部分用 **three 当真值**逐项比——同一位姿在两套引擎里
 * 必须得到同一个矩阵（`selectionTransform.test.ts` 立的规矩）。
 */

const DEFAULT: WorldSemanticsLike = { flipY: true, metricScaleFactor: 1, groundPlaneOffset: 0 };

/** three 侧的参照实现：外层语义变换 × 里层用户摆放，再分解回 TRS。 */
function threeCompose(semantics: WorldSemanticsLike | null, user: Placement | null): Placement {
  const base = user ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as Placement;
  const matrixOf = (placement: Placement) => new Matrix4().compose(
    new Vector3(...placement.position),
    new Quaternion().setFromEuler(new Euler(placement.rotation[0], placement.rotation[1], placement.rotation[2], "XYZ")),
    new Vector3(...placement.scale),
  );
  const matrix = semantics ? matrixOf(semanticPlacement(semantics)).multiply(matrixOf(base)) : matrixOf(base);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation, "XYZ");
  return { position: position.toArray(), rotation: [euler.x, euler.y, euler.z], scale: scale.toArray() };
}

function close(actual: Placement, expected: Placement, digits = 6): void {
  expect(actual.position[0]).toBeCloseTo(expected.position[0], digits);
  expect(actual.position[1]).toBeCloseTo(expected.position[1], digits);
  expect(actual.position[2]).toBeCloseTo(expected.position[2], digits);
  expect(actual.rotation[0]).toBeCloseTo(expected.rotation[0], digits);
  expect(actual.rotation[1]).toBeCloseTo(expected.rotation[1], digits);
  expect(actual.rotation[2]).toBeCloseTo(expected.rotation[2], digits);
  expect(actual.scale[0]).toBeCloseTo(expected.scale[0], digits);
  expect(actual.scale[1]).toBeCloseTo(expected.scale[1], digits);
  expect(actual.scale[2]).toBeCloseTo(expected.scale[2], digits);
}

describe("语义变换", () => {
  test("默认语义：绕 X 转 π、不缩放不平移（World Labs 的 +Y 朝下）", () => {
    expect(semanticPlacement(DEFAULT)).toEqual({ position: [0, 0, 0], rotation: [Math.PI, 0, 0], scale: [1, 1, 1] });
  });

  test("flipY 关掉就不转（三个值各自独立生效）", () => {
    expect(semanticPlacement({ flipY: false, metricScaleFactor: 2, groundPlaneOffset: 0.5 })).toEqual({
      position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [2, 2, 2],
    });
  });
});

describe("语义 ∘ 用户摆放", () => {
  test("没有语义字段时**不猜**：原样返回用户摆放", () => {
    const user: Placement = { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] };
    expect(worldPlacement(null, user)).toBe(user);
    expect(worldPlacement(undefined, undefined)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  });

  test("单位摆放时结果就是语义变换本身", () => {
    close(worldPlacement(DEFAULT, null), semanticPlacement(DEFAULT));
  });

  test("被 gizmo 挪过的世界：位置先被外层缩放、再被外层旋转（转 π 之后 y/z 反号）", () => {
    const user: Placement = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
    close(worldPlacement(DEFAULT, user), threeCompose(DEFAULT, user));
    // 解析式：绕 X 转 π ⇒ (x, y, z) → (x, −y, −z)
    close(worldPlacement(DEFAULT, user), { position: [1, -2, -3], rotation: [Math.PI, 0, 0], scale: [1, 1, 1] });
  });

  test("缩放与非零朝向一起给：与 three 的矩阵分解逐项一致", () => {
    // 用户缩放也取**等比**：非等比缩放 × 朝向会退化成剪切，单一 TRS 表示不出来
    // （three 侧是两级 group 所以能表示；见 worldPlacement 文件头那条边界）
    const semantics: WorldSemanticsLike = { flipY: true, metricScaleFactor: 2, groundPlaneOffset: 0.5 };
    const user: Placement = { position: [0.5, -1, 2], rotation: [0.3, -0.4, 0.7], scale: [0.5, 0.5, 0.5] };
    close(worldPlacement(semantics, user), threeCompose(semantics, user), 5);
  });

  test("不翻转时合成仍然正确（缩放/平移那条路）", () => {
    const semantics: WorldSemanticsLike = { flipY: false, metricScaleFactor: 3, groundPlaneOffset: -1 };
    const user: Placement = { position: [1, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] };
    close(worldPlacement(semantics, user), threeCompose(semantics, user), 5);
    // 位置的解析式：外层缩放 3、外层不旋转 ⇒ (1,0,0)·3 + (0,−1,0)
    close(worldPlacement(semantics, user), { position: [3, -1, 0], rotation: [0, 0.5, 0], scale: [3, 3, 3] });
  });
});
