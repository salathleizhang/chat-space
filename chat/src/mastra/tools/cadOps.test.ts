import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, readJson } from "../../services/assetStorage";
import {
  CAD_PROVIDER,
  buildFlatShadedGlb,
  parseBinaryStl,
  readLatestCadSource,
  runCadGeneration,
} from "./cadOps";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-cad-test-"));
const storage = new LocalFileStorage(root);

/** 10mm 立方体：体积与包围盒可精确断言 */
const CUBE_SCAD = "size = 10; // [1:1:100]\ncube([size, size, size], center = true);";

beforeAll(async () => {
  await createProject(storage, { name: "CAD 演示", slug: "cad-demo" });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runCadGeneration", () => {
  test("编译 SCAD 落盘 GLB + 源码 + 侧写，几何统计正确", async () => {
    const result = await runCadGeneration(storage, {
      projectSlug: "cad-demo",
      assetSlug: "cube",
      name: "测试立方体",
      scadCode: CUBE_SCAD,
    });

    expect(result.stats.triangles).toBe(12);
    expect(result.stats.volumeMm3).toBeCloseTo(1000, 3);
    expect(result.stats.bboxMm.min).toEqual([-5, -5, -5]);
    expect(result.stats.bboxMm.max).toEqual([5, 5, 5]);

    // 磁盘不齐不算成功：GLB 魔数 + 源码原样 + 侧写 succeeded
    const glb = await storage.readBytes(result.glbPath);
    expect(new DataView(glb.buffer, glb.byteOffset).getUint32(0, true)).toBe(0x46546c67);
    expect(await storage.readText(result.scadPath)).toBe(CUBE_SCAD);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.provider).toBe(CAD_PROVIDER);
    expect(sidecar.params.scadCode).toBe(CUBE_SCAD);
    expect(sidecar.outputs.map((o) => o.path)).toEqual([result.glbPath, result.scadPath]);
  }, 30_000);

  test("同 assetSlug 重生成走新索引，源码读回最新代", async () => {
    const regenerated = await runCadGeneration(storage, {
      projectSlug: "cad-demo",
      assetSlug: "cube",
      scadCode: CUBE_SCAD.replace("size = 10", "size = 20"),
    });
    expect(regenerated.glbPath).toContain("/1-cube.glb");
    expect(regenerated.stats.volumeMm3).toBeCloseTo(8000, 2);

    const source = await readLatestCadSource(storage, "cad-demo", "cube");
    expect(source.index).toBe(1);
    expect(source.status).toBe("succeeded");
    expect(source.scadCode).toContain("size = 20");
  }, 30_000);

  test("语法错误：侧写记 failed 并抛出含 OpenSCAD 报错的错误", async () => {
    await expect(
      runCadGeneration(storage, {
        projectSlug: "cad-demo",
        assetSlug: "broken",
        scadCode: "cube([10, 10, 10;",
      }),
    ).rejects.toThrow(/OpenSCAD compilation failed/);

    const files = await storage.list(assetDir("cad-demo", "broken"));
    const sidecarName = files.find((f) => f.endsWith("-request.json"));
    expect(sidecarName).toBeDefined();
    const sidecar = await readJson(
      storage,
      `${assetDir("cad-demo", "broken")}/${sidecarName}`,
      RequestSidecarSchema,
    );
    expect(sidecar.status).toBe("failed");
    expect(sidecar.error).toMatch(/ERROR|compilation failed/);
    expect(await storage.exists(assetIdentityFile("cad-demo", "broken"))).toBe(false);
  }, 30_000);

  test("布尔减空几何：明确报 cad_empty_geometry", async () => {
    await expect(
      runCadGeneration(storage, {
        projectSlug: "cad-demo",
        assetSlug: "empty",
        scadCode: "difference() { cube(5); cube(20, center = true); }",
      }),
    ).rejects.toThrow(/empty geometry/);
    expect(await storage.exists(assetIdentityFile("cad-demo", "empty"))).toBe(false);
  }, 30_000);
});

describe("readLatestCadSource", () => {
  test("无 CAD 记录的资产报 404", async () => {
    await expect(readLatestCadSource(storage, "cad-demo", "no-cad")).rejects.toThrow(
      /has no CAD generation record/,
    );
  });
});

describe("STL/GLB 纯函数", () => {
  test("parseBinaryStl 拒绝截断文件", () => {
    expect(() => parseBinaryStl(new Uint8Array(10))).toThrow(/is incomplete/);
  });

  test("buildFlatShadedGlb 输出 4 字节对齐的合法 GLB 容器", () => {
    // 单三角形（毫米）
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    const glb = buildFlatShadedGlb(positions, "tri");
    const view = new DataView(glb.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.length);
    expect(glb.length % 4).toBe(0);
    // JSON chunk 可解析且坐标已折算成米
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    expect(json.accessors[0].max).toEqual([0.01, 0.01, 0]);
  });
});
