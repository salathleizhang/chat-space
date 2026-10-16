import { describe, expect, test } from "bun:test";
import { computeFaceUv, create, faceUvBasis, parseSkp, type UvPair } from "openskp";
import { canonicalBasis, compensateUv, newellNormal, writerBasis, type Uv, type Vec3 } from "./skpUvFrame";

/**
 * 这里用 openskp 自己的读回端当**真值来源**：写入器把 UV 钉进文件，读回端按
 * `Face.uvTransform` + `faceUvBasis`/`computeFaceUv` 的公式算回来。两者对得上，
 * 才说明这个面的贴图映射是自洽的。
 */
function roundTrip(points: [Vec3, Vec3, Vec3], uvs: [Uv, Uv, Uv], frame: "canonical" | "writer"): Uv[] {
  const builder = create();
  const material = builder.addMaterial("M", [255, 0, 0]);
  const fed = frame === "canonical" ? compensateUv(points, newellNormal(points), uvs) : uvs;
  builder.addFace(points, {
    material,
    frontUv: [
      [points[0], fed[0]],
      [points[1], fed[1]],
      [points[2], fed[2]],
    ] as UvPair[],
  });
  const bytes = builder.toBytes();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const model = parseSkp(buffer);
  const face = model.root.faces[0]!;
  const basis = faceUvBasis(face.normal as Vec3);
  const vertices = new Map(model.root.vertices.map((vertex) => [vertex.id, vertex]));
  const byPoint = new Map<string, Uv>();
  for (const loop of face.loops) {
    for (const coedge of loop) {
      const edge = model.root.edges.find((candidate) => candidate.id === coedge.edgeId);
      if (!edge) continue;
      const vertex = vertices.get(edge.v1Id);
      if (!vertex) continue;
      const point: Vec3 = [vertex.x, vertex.y, vertex.z];
      byPoint.set(point.join(","), computeFaceUv(point, basis.xr, basis.yr, face.uvTransform, 1, 1) as Uv);
    }
  }
  return points.map((point) => byPoint.get(point.join(","))!);
}

const AXIS_FIRST_EDGE: [Vec3, Vec3, Vec3] = [
  [0, 0, 0],
  [10, 0, 0],
  [5, 10, 0],
];
const DIAGONAL_FIRST_EDGE: [Vec3, Vec3, Vec3] = [
  [16, 0, 0],
  [26, 10, 0],
  [16, 10, 0],
];
const UVS: [Uv, Uv, Uv] = [
  [0, 0],
  [1, 0],
  [0.5, 1],
];

describe("skpUvFrame", () => {
  test("规范基：+Z 法线的水平面就是 XY 平面", () => {
    const { xr, yr } = canonicalBasis([0, 0, 1]);
    expect(xr).toEqual([1, 0, 0]);
    expect(yr).toEqual([0, 1, 0]);
    // 立起来的法线也取一个确定的基，不退化成 0
    const vertical = canonicalBasis([1, 0, 0]);
    expect(Math.hypot(...vertical.xr)).toBeCloseTo(1, 9);
    expect(Math.hypot(...vertical.yr)).toBeCloseTo(1, 9);
  });

  test("写入端的基取的是面的第一条边方向", () => {
    const axis = writerBasis(AXIS_FIRST_EDGE, [0, 0, 1]);
    expect(axis.u[0]).toBeCloseTo(1, 9);
    const diagonal = writerBasis(DIAGONAL_FIRST_EDGE, [0, 0, 1]);
    expect(diagonal.u[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(diagonal.u[1]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  test("第一条边沿规范轴时，补偿是恒等变换（不会把本来就对的面弄坏）", () => {
    const compensated = compensateUv(AXIS_FIRST_EDGE, newellNormal(AXIS_FIRST_EDGE), UVS);
    for (const [index, uv] of compensated.entries()) {
      expect(uv[0]).toBeCloseTo(UVS[index]![0], 9);
      expect(uv[1]).toBeCloseTo(UVS[index]![1], 9);
    }
  });

  test("第一条边沿规范轴时，两种口径都能读回原 UV", () => {
    for (const frame of ["canonical", "writer"] as const) {
      const read = roundTrip(AXIS_FIRST_EDGE, UVS, frame);
      for (const [index, uv] of read.entries()) {
        expect(uv[0]).toBeCloseTo(UVS[index]![0], 3);
        expect(uv[1]).toBeCloseTo(UVS[index]![1], 3);
      }
    }
  });

  test("第一条边是斜的：直接交给写入器会读回错的值，补偿后才对", () => {
    // 这正是 openskp 1.3.0 写入端/读回端两个基不一致的表现
    const naive = roundTrip(DIAGONAL_FIRST_EDGE, UVS, "writer");
    const naiveMatches = naive.every(
      (uv, index) => Math.abs(uv[0] - UVS[index]![0]) < 1e-3 && Math.abs(uv[1] - UVS[index]![1]) < 1e-3,
    );
    expect(naiveMatches).toBe(false);

    const compensated = roundTrip(DIAGONAL_FIRST_EDGE, UVS, "canonical");
    for (const [index, uv] of compensated.entries()) {
      expect(uv[0]).toBeCloseTo(UVS[index]![0], 3);
      expect(uv[1]).toBeCloseTo(UVS[index]![1], 3);
    }
  });
});
