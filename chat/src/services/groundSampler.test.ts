import { describe, expect, test } from "bun:test";
import {
  alignGroundMesh,
  buildGroundSampler,
  groundMeshFromTriangles,
  sampleGroundHeight,
  type GroundTriangle,
} from "./groundSampler";

/** 一个铺在 y 高度上的 2×2 正方形（两个三角形），覆盖 x,z ∈ [−1, 1]。 */
function plane(y: number): GroundTriangle[] {
  return [
    [[-1, y, -1], [1, y, -1], [1, y, 1]],
    [[-1, y, -1], [1, y, 1], [-1, y, 1]],
  ];
}

/** 竖直墙面：x = 0 平面，z ∈ [−1, 1]，y ∈ [0, 2]。它在 XZ 上退化。 */
const WALL: GroundTriangle = [[0, 0, -1], [0, 2, -1], [0, 2, 1]];

describe("sampleGroundHeight", () => {
  test("平面内取到高度，平面外给 null", () => {
    const mesh = groundMeshFromTriangles(plane(1.2));
    expect(sampleGroundHeight(mesh, 0, 0)).toBeCloseTo(1.2, 6);
    expect(sampleGroundHeight(mesh, 0.9, -0.9)).toBeCloseTo(1.2, 6);
    expect(sampleGroundHeight(mesh, 5, 5)).toBeNull();
  });

  test("倾斜地面按三角形插值，不是取顶点近似", () => {
    // 四角 (−1,0,−1)(1,0,−1)(1,2,1)(−1,2,1) 组成的斜面恰好是平面 y = z + 1：
    // z=0 处应有 1，而四个顶点的高度只有 0 和 2——插值错了这个点最藏不住。
    const slope: GroundTriangle[] = [
      [[-1, 0, -1], [1, 0, -1], [1, 2, 1]],
      [[-1, 0, -1], [1, 2, 1], [-1, 2, 1]],
    ];
    const mesh = groundMeshFromTriangles(slope);
    expect(sampleGroundHeight(mesh, 0, -1)).toBeCloseTo(0, 6);
    expect(sampleGroundHeight(mesh, 0, 0)).toBeCloseTo(1, 6);
    expect(sampleGroundHeight(mesh, 0, 1)).toBeCloseTo(2, 6);
  });

  test("同一点有多层表面时取最接近参考面的那层：天花板不参与摆放", () => {
    const mesh = groundMeshFromTriangles([...plane(0), ...plane(2.5)]);
    // 参考面是 0（世界对齐后的地面），所以选地板而不是天花板。
    expect(sampleGroundHeight(mesh, 0, 0)).toBeCloseTo(0, 6);
    // 显式把参考面抬到天花板高度时才选天花板——判据是刻度而不是"最高"。
    expect(sampleGroundHeight(mesh, 0, 0, 2.4)).toBeCloseTo(2.5, 6);
  });

  test("竖直墙面不会被当成地面", () => {
    const mesh = groundMeshFromTriangles([WALL]);
    expect(sampleGroundHeight(mesh, 0, 0)).toBeNull();
  });
});

describe("alignGroundMesh", () => {
  test("与 app 的 worldTransform 同一组合顺序：先缩放、再绕 X 翻、最后抬地面", () => {
    const mesh = groundMeshFromTriangles([[[1, 2, 3], [0, 0, 0], [0, 0, 0]]]);
    const aligned = alignGroundMesh(mesh, {
      flipY: true,
      metricScaleFactor: 2,
      groundPlaneOffset: 0.5,
    });
    // (1,2,3) → 缩放 ×2 → (2,4,6) → 绕 X 转 π → (2,−4,−6) → 抬 0.5 → (2,−3.5,−6)
    expect([...aligned.positions.slice(0, 3)]).toEqual([2, -3.5, -6]);
  });

  test("不需要翻转时保持 +Y 朝上", () => {
    const mesh = groundMeshFromTriangles([[[1, 2, 3], [0, 0, 0], [0, 0, 0]]]);
    const aligned = alignGroundMesh(mesh, {
      flipY: false,
      metricScaleFactor: 1,
      groundPlaneOffset: 0.25,
    });
    expect([...aligned.positions.slice(0, 3)]).toEqual([1, 2.25, 3]);
  });
});

describe("buildGroundSampler", () => {
  test("没有网格（collider 读不出来）时一律给 null，由调用方退回平面", () => {
    const sampler = buildGroundSampler(null);
    expect(sampler(0, 0)).toBeNull();
    expect(buildGroundSampler(groundMeshFromTriangles([]))(0, 0)).toBeNull();
  });

  test("有网格时按点查询", () => {
    const sampler = buildGroundSampler(groundMeshFromTriangles(plane(0.4)));
    expect(sampler(0.5, 0.5)).toBeCloseTo(0.4, 6);
    expect(sampler(9, 9)).toBeNull();
  });
});
