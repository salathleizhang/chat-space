import { describe, expect, test } from "bun:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { computeFaceUv, faceUvBasis, parseSkp, type UvPair } from "openskp";
import { ChatServiceError } from "../common/errors";
import { glbToSkp, SKP_MAX_TRIANGLES } from "./skpExport";
import type { Uv, Vec3 } from "./skpUvFrame";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * 米制的 glTF 三角形：三个顶点分别是原点、+X 1 米、+Y 1 米（glTF 是 Y 轴朝上）。
 * 转成 SketchUp 后应当落在 XY 平面上：+Y 的顶点变成 +Z（1 米 = 39.37007874015748 英寸）。
 */
const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const UVS = new Float32Array([0, 0, 1, 0, 0, 1]);
const METRES_TO_INCHES = 39.37007874015748;

async function buildGlb(
  options: {
    texture?: boolean;
    material?: boolean;
    mesh?: boolean;
    collinearUv?: boolean;
    nearCollinearUv?: boolean;
  } = {},
): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType("VEC3").setArray(POSITIONS).setBuffer(buffer);
  // 共线的 UV（三点在一条线上）无法确定仿射映射：openskp 的 solve3x3 会抛异常
  const uvArray = options.collinearUv
    ? new Float32Array([0, 0, 0.5, 0, 1, 0])
    : options.nearCollinearUv
      ? new Float32Array([0, 0, 1, 0, 0.5, 1e-10]) // 面积 1e-10：低于写入器的 1e-9 判据
      : UVS;
  const uv = doc.createAccessor().setType("VEC2").setArray(uvArray).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv);
  if (options.material ?? true) {
    const material = doc.createMaterial("mat");
    if (options.texture ?? true) {
      const texture = doc.createTexture("tex").setImage(new Uint8Array(PNG_1X1)).setMimeType("image/png");
      material.setBaseColorTexture(texture);
    } else {
      material.setBaseColorFactor([1, 0, 0, 1]);
    }
    primitive.setMaterial(material);
  }
  if (options.mesh ?? true) {
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  } else {
    doc.createScene();
  }
  return new NodeIO().writeBinary(doc);
}

/** 一张 cells×cells 的平面网格（2·cells² 个三角面），用来覆盖减面路径 */
async function buildGridGlb(cells: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  for (let y = 0; y <= cells; y++) {
    for (let x = 0; x <= cells; x++) positions.push(x / cells, y / cells, 0);
  }
  const indices: number[] = [];
  const id = (x: number, y: number): number => y * (cells + 1) + x;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      indices.push(id(x, y), id(x + 1, y), id(x + 1, y + 1), id(x, y), id(x + 1, y + 1), id(x, y + 1));
    }
  }
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const index = doc
    .createAccessor()
    .setType("SCALAR")
    .setArray(new Uint32Array(indices))
    .setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute("POSITION", position).setIndices(index);
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  return new NodeIO().writeBinary(doc);
}

function readBack(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const model = parseSkp(buffer);
  const vertices = new Map(model.root.vertices.map((vertex) => [vertex.id, vertex]));
  const faces = model.root.faces.map((face) => {
    const basis = faceUvBasis(face.normal as Vec3);
    const points: Vec3[] = [];
    const uvs: Uv[] = [];
    for (const loop of face.loops) {
      for (const coedge of loop) {
        const edge = model.root.edges.find((candidate) => candidate.id === coedge.edgeId);
        if (!edge) continue;
        const vertex = vertices.get(edge.v1Id);
        if (!vertex) continue;
        const point: Vec3 = [vertex.x, vertex.y, vertex.z];
        if (points.some((existing) => existing.join(",") === point.join(","))) continue;
        points.push(point);
        uvs.push(computeFaceUv(point, basis.xr, basis.yr, face.uvTransform, 1, 1) as Uv);
      }
    }
    return { face, points, uvs };
  });
  return { model, faces };
}

describe("glbToSkp", () => {
  test("产出 legacy 版 SketchUp 文件（v17 头 + 容器签名）", async () => {
    const result = await glbToSkp(await buildGlb());
    expect([...result.bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0xff, 0x0e]);
    const signature = String.fromCharCode(...result.bytes.subarray(4, 20).filter((_, index) => index % 2 === 0));
    expect(signature).toBe("SketchUp");
    expect(result.facesWritten).toBe(1);
    expect(result.decimatedFrom).toBeUndefined();
    expect(readBack(result.bytes).model.version.startsWith("{17")).toBe(true);
  });

  test("米 → 英寸，Y-up → Z-up", async () => {
    const { faces } = readBack((await glbToSkp(await buildGlb())).bytes);
    expect(faces.length).toBe(1);
    // 归一化 -0（坐标换算里 -z 在 z=0 时会得到 -0，数值上是 0，但 toContainEqual 用 Object.is 判不等）
    const round = (value: number): number => {
      const rounded = Math.round(value * 1e6) / 1e6;
      return rounded === 0 ? 0 : rounded;
    };
    const points = faces[0]!.points.map((point) => point.map(round));
    // 原点不动；+X 1 米 = 39.37007874015748 英寸；glTF 的 +Y 变成 SketchUp 的 +Z
    expect(points).toContainEqual([0, 0, 0]);
    expect(points).toContainEqual([Math.round(METRES_TO_INCHES * 1e6) / 1e6, 0, 0]);
    expect(points).toContainEqual([0, 0, Math.round(METRES_TO_INCHES * 1e6) / 1e6]);
  });

  test("base color 贴图内嵌进材质，且每个面都带 UV 钉住（v 轴翻转）", async () => {
    const { model, faces } = readBack((await glbToSkp(await buildGlb())).bytes);
    expect(model.materials.length).toBe(1);
    const texture = model.materials[0]!.texture;
    expect(texture?.data?.length).toBe(PNG_1X1.length);
    expect(faces[0]!.face.uvTransform).not.toBeNull();
    expect((await glbToSkp(await buildGlb())).facesWithUv).toBe(1);

    // glTF 的 (0,0)/(1,0)/(0,1) 在 SketchUp 侧是 v 翻转后的 (0,1)/(1,1)/(0,0)
    const expected: [number, number][] = [
      [0, 1],
      [1, 1],
      [0, 0],
    ];
    const source: Vec3[] = [
      [0, 0, 0],
      [METRES_TO_INCHES, 0, 0],
      [0, 0, METRES_TO_INCHES],
    ];
    for (const [index, point] of faces[0]!.points.entries()) {
      const slot = source.findIndex(
        (candidate) =>
          Math.abs(candidate[0] - point[0]) < 1e-6 &&
          Math.abs(candidate[1] - point[1]) < 1e-6 &&
          Math.abs(candidate[2] - point[2]) < 1e-6,
      );
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(faces[0]!.uvs[index]![0]).toBeCloseTo(expected[slot]![0], 3);
      expect(faces[0]!.uvs[index]![1]).toBeCloseTo(expected[slot]![1], 3);
    }
  });

  test("UV 共线的面不钉映射，也不会让整份导出失败", async () => {
    const result = await glbToSkp(await buildGlb({ collinearUv: true }));
    expect(result.facesWritten).toBe(1);
    expect(result.facesWithUv).toBe(0);
    expect(result.facesWithoutUv).toBe(1);
    expect(result.notices.join()).toContain("UV 退化");
    // 面还在，只是退回 SketchUp 的默认投影
    expect(readBack(result.bytes).faces[0]!.face.uvTransform).toBeNull();
  });

  test("UV 近共线（面积低于写入器判据）的面同样不钉映射", async () => {
    // 阈值必须与 openskp 的 solve3x3 判据同量级，宽一点点就会让整份导出失败
    const result = await glbToSkp(await buildGlb({ nearCollinearUv: true }));
    expect(result.facesWritten).toBe(1);
    expect(result.facesWithUv).toBe(0);
    expect(result.facesWithoutUv).toBe(1);
    expect(readBack(result.bytes).faces[0]!.face.uvTransform).toBeNull();
  });

  test("没有贴图时退化为底色材质，且不写 UV 钉住", async () => {
    const { model, faces } = readBack((await glbToSkp(await buildGlb({ texture: false }))).bytes);
    expect(model.materials.length).toBe(1);
    expect(model.materials[0]!.texture).toBeNull();
    expect(model.materials[0]!.color.r).toBe(255);
    expect(faces[0]!.face.uvTransform).toBeNull();
  });

  test("超过准入时自动减面到上限，而不是直接失败", async () => {
    const glb = await buildGridGlb(20); // 800 个三角面
    const result = await glbToSkp(glb, { maxTriangles: 200 });
    expect(result.decimatedFrom).toBe(800);
    expect(result.triangles).toBeLessThanOrEqual(200);
    expect(result.facesWritten).toBe(result.triangles);
    expect(result.notices.join()).toContain("已自动减面");
    // 减面后的几何仍然是可读回的合法文件
    expect(readBack(result.bytes).model.root.faces.length).toBeGreaterThan(0);
  });

  test("没有超过准入时不减面", async () => {
    const result = await glbToSkp(await buildGridGlb(4), { maxTriangles: 10_000 });
    expect(result.decimatedFrom).toBeUndefined();
    expect(result.triangles).toBe(32);
    expect(result.notices).toEqual([]);
  });

  test("减面也降不下来时明确失败（不产出半成品）", async () => {
    await expect(glbToSkp(await buildGridGlb(2), { maxTriangles: 0 })).rejects.toBeInstanceOf(ChatServiceError);
    // 默认准入是个明确的量级（20 万面 ≈ 2.5 GB 内存）
    expect(SKP_MAX_TRIANGLES).toBe(200_000);
  });

  test("没有几何的场景明确报错，不产出空文件", async () => {
    await expect(glbToSkp(await buildGlb({ mesh: false }))).rejects.toMatchObject({
      code: "skp_empty_scene",
      status: 422,
    });
  });

  test("材质必须先于几何写入：面的材质句柄可读回", async () => {
    const { model, faces } = readBack((await glbToSkp(await buildGlb())).bytes);
    expect(faces.length).toBe(1);
    expect(faces[0]!.face.materialId).toBe(model.materials[0]!.id);
  });

  test("frontUv 传的是 3 组点↔UV，形状与 openskp 的 UvPair 一致", () => {
    const pair: UvPair = [
      [0, 0, 0],
      [0, 1],
    ];
    expect(pair[0].length).toBe(3);
    expect(pair[1].length).toBe(2);
  });
});
