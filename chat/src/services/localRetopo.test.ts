import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage } from "./assetStorage";
import { defaultRetopoFaces, runLocalRetopology } from "./localRetopo";

/** 造一个带 UV 的球体 GLB：足够多的三角形，但没有外部贴图依赖。 */
async function sphereGlb(segments = 32, rings = 16): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position: number[] = [];
  const uv: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI;
      position.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
      uv.push(u, v);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(new Float32Array(position)).setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer),
    )
    .setIndices(
      doc
        .createAccessor()
        .setType("SCALAR")
        .setArray(new Uint32Array(indices))
        .setBuffer(buffer),
    );
  doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(doc.getRoot().listMeshes()[0]!));
  return new NodeIO().writeBinary(doc);
}

async function triangleCount(bytes: Uint8Array): Promise<number> {
  const doc = await new NodeIO().readBinary(bytes);
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      total += indices
        ? indices.getCount() / 3
        : (primitive.getAttribute("POSITION")?.getCount() ?? 0) / 3;
    }
  }
  return total;
}

describe("runLocalRetopology", () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "local-retopo-"));
    storage = new LocalFileStorage(root);
    await createProject(storage, { name: "Retopo", slug: "retopo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(segments = 32, rings = 16) {
    const path = "projects/retopo/assets/ball/0-ball.glb";
    await storage.writeBytes(path, await sphereGlb(segments, rings));
    return path;
  }

  test("现场减面：产物是新的一代，原模型保留，UV 跟着走", async () => {
    const sourcePath = await seed();
    const sourceFaces = await triangleCount(await storage.readBytes(sourcePath));
    expect(sourceFaces).toBeGreaterThan(900);

    const result = await runLocalRetopology(storage, {
      projectSlug: "retopo",
      assetSlug: "ball",
      targetPolycount: 400,
    });

    expect(result.fromFaces).toBe(sourceFaces);
    expect(result.faces).toBeLessThanOrEqual(600);
    expect(result.model).toBe("projects/retopo/assets/ball/1-ball.glb");
    // 原高模不动
    expect(await triangleCount(await storage.readBytes(sourcePath))).toBe(sourceFaces);

    const produced = await new NodeIO().readBinary(await storage.readBytes(result.model));
    const withUv = produced
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .filter((primitive) => primitive.getAttribute("TEXCOORD_0") !== null);
    expect(withUv.length).toBeGreaterThan(0);
  });

  test("侧写记 local，能被资产目录索引到", async () => {
    await seed();
    await runLocalRetopology(storage, {
      projectSlug: "retopo",
      assetSlug: "ball",
      targetPolycount: 400,
    });
    const names = await storage.list("projects/retopo/assets/ball");
    expect(names).toContain("1-ball.glb");
    expect(names).toContain(".1-ball-request.json");
    const sidecar = JSON.parse(
      await storage.readText("projects/retopo/assets/ball/.1-ball-request.json"),
    );
    expect(sidecar.provider).toBe("local");
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.params.target_faces).toBe(400);
  });

  test("目标不低于现有面数时直接拒绝，不产生空代次", async () => {
    await seed();
    await expect(
      runLocalRetopology(storage, { projectSlug: "retopo", assetSlug: "ball", targetPolycount: 5_000 }),
    ).rejects.toThrow(/nothing to decimate/);
    expect(await storage.list("projects/retopo/assets/ball")).toEqual(["0-ball.glb"]);
  });

  test("第二次减面仍从原始高模起算，可以换成更大的目标", async () => {
    await seed();
    const first = await runLocalRetopology(storage, {
      projectSlug: "retopo",
      assetSlug: "ball",
      targetPolycount: 200,
    });
    const second = await runLocalRetopology(storage, {
      projectSlug: "retopo",
      assetSlug: "ball",
      targetPolycount: 600,
    });
    expect(first.faces).toBeLessThan(second.faces);
    expect(second.fromFaces).toBe(first.fromFaces);
    expect(second.model).toBe("projects/retopo/assets/ball/2-ball.glb");
    // 3 代并存：原始、200 面、600 面
    expect(await storage.list("projects/retopo/assets/ball")).toContain("0-ball.glb");
  });

  test("目标面数越界时拒绝", async () => {
    await seed();
    await expect(
      runLocalRetopology(storage, { projectSlug: "retopo", assetSlug: "ball", targetPolycount: 10 }),
    ).rejects.toThrow(/40–40000/);
  });
});

describe("defaultRetopoFaces", () => {
  test("大模型多给、小模型少给，且落在 300–2000", () => {
    expect(defaultRetopoFaces(1_500_000)).toBe(2_000);
    expect(defaultRetopoFaces(100_000)).toBe(949);
    expect(defaultRetopoFaces(20_000)).toBe(424);
    expect(defaultRetopoFaces(1_000)).toBe(300);
    expect(defaultRetopoFaces(10_000_000)).toBe(2_000);
  });
});
