import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir } from "../../common/libraryPaths";
import { LocalFileStorage } from "../../services/assetStorage";
import { HIGH_POLY_FACE_THRESHOLD, runWithGeneratedModelInfo } from "./modelInfo";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-model-info-test-"));
const storage = new LocalFileStorage(root);

/** 造一个"面数已知"的 GLB：判据只读 JSON chunk，几何本体不需要。 */
function glbWithTriangles(triangles: number): Uint8Array {
  const gltf = {
    meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }] }],
    accessors: [{ count: triangles * 3 }, { count: triangles * 3 }],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);
  const bytes = new Uint8Array(20 + padded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(padded, 20);
  return bytes;
}

function infoOf(result: unknown): { path: string | null; faces: number | null; highPoly: boolean } {
  return (result as { modelInfo: never }).modelInfo;
}

beforeAll(async () => {
  await createProject(storage, { name: "模型重量", slug: "mi" });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("生成的模型有多重（modelInfo）", () => {
  test("Tripo 3.1 那种百万面：报实测面数并标成高模", async () => {
    const dir = assetDir("mi", "heavy-sofa");
    await storage.writeBytes(`${dir}/0-heavy-sofa.glb`, glbWithTriangles(1_483_936));
    const result = await runWithGeneratedModelInfo(storage, "mi", "heavy-sofa", async () => ({
      files: [`${dir}/0-heavy-sofa.glb`],
      tripoTaskId: "gen-1",
    }));

    expect(infoOf(result)).toEqual({
      path: `${dir}/0-heavy-sofa.glb`,
      faces: 1_483_936,
      highPoly: true,
    });
    // 生成结果本身不能被吃掉：app 的结算与发布都读 files
    expect((result as { files: string[] }).files).toEqual([`${dir}/0-heavy-sofa.glb`]);
    expect((result as { tripoTaskId: string }).tripoTaskId).toBe("gen-1");
  });

  test("Tripo P 系列那种约 5 千面：不是高模，不该去打扰用户", async () => {
    const dir = assetDir("mi", "light-chair");
    await storage.writeBytes(`${dir}/0-light-chair.glb`, glbWithTriangles(4_780));
    const result = await runWithGeneratedModelInfo(storage, "mi", "light-chair", async () => ({
      files: [`${dir}/0-light-chair.glb`],
    }));
    expect(infoOf(result)).toEqual({
      path: `${dir}/0-light-chair.glb`,
      faces: 4_780,
      highPoly: false,
    });
  });

  test("阈值边界：正好 10 万面算高模，差一面不算", async () => {
    const at = assetDir("mi", "at-threshold");
    const below = assetDir("mi", "below-threshold");
    await storage.writeBytes(`${at}/0-at-threshold.glb`, glbWithTriangles(HIGH_POLY_FACE_THRESHOLD));
    await storage.writeBytes(
      `${below}/0-below-threshold.glb`,
      glbWithTriangles(HIGH_POLY_FACE_THRESHOLD - 1),
    );
    const high = await runWithGeneratedModelInfo(storage, "mi", "at-threshold", async () => ({}));
    const low = await runWithGeneratedModelInfo(storage, "mi", "below-threshold", async () => ({}));
    expect(infoOf(high).highPoly).toBe(true);
    expect(infoOf(low).highPoly).toBe(false);
  });

  test("面数读不出来（截断的 GLB / 非 GLB）按高模处理：问一次是免费的，漏问才是缺陷", async () => {
    const dir = assetDir("mi", "opaque-blob");
    await storage.writeBytes(`${dir}/0-opaque-blob.glb`, new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    const glb = await runWithGeneratedModelInfo(storage, "mi", "opaque-blob", async () => ({}));
    expect(infoOf(glb)).toEqual({ path: `${dir}/0-opaque-blob.glb`, faces: null, highPoly: true });

    const obj = assetDir("mi", "legacy-obj");
    await storage.writeBytes(`${obj}/0-legacy-obj.obj`, new TextEncoder().encode("v 0 0 0\n"));
    const asObj = await runWithGeneratedModelInfo(storage, "mi", "legacy-obj", async () => ({}));
    expect(infoOf(asObj)).toEqual({ path: `${obj}/0-legacy-obj.obj`, faces: null, highPoly: true });
  });

  test("连模型文件都没有（异常落盘）也不抛：退化成「不知道 + 按高模处理」", async () => {
    const result = await runWithGeneratedModelInfo(storage, "mi", "never-landed", async () => ({
      files: [],
    }));
    expect(infoOf(result)).toEqual({ path: null, faces: null, highPoly: true });
  });
});
