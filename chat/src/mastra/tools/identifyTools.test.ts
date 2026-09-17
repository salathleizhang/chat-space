import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import { AssetIdentitySchema } from "../../dto/library";
import { LocalFileStorage, writeJson } from "../../services/assetStorage";
import { resolveIdentifyCandidates } from "./identifyTools";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-identify-test-"));
const storage = new LocalFileStorage(root);

beforeAll(async () => {
  await createProject(storage, { name: "身份识别演示", slug: "identify-demo" });

  await writeJson(storage, assetIdentityFile("identify-demo", "dog-01"), AssetIdentitySchema, {
    schemaVersion: 1,
    slug: "dog-01",
    kind: "model",
    name: "红色的狗",
    intent: "一只红色的卡通狗",
    sourceImages: ["projects/identify-demo/source/0-dog.png"],
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  await storage.writeBytes(`${assetDir("identify-demo", "dog-01")}/0-dog-01.glb`, new Uint8Array([1]));

  // CAD 资产：无参考图（schema 允许空数组）
  await writeJson(storage, assetIdentityFile("identify-demo", "bracket-01"), AssetIdentitySchema, {
    schemaVersion: 1,
    slug: "bracket-01",
    kind: "model",
    name: "支架",
    intent: "L 型支架",
    sourceImages: [],
    createdAt: "2026-07-02T00:00:00.000Z",
  });
  await storage.writeBytes(
    `${assetDir("identify-demo", "bracket-01")}/0-bracket-01.glb`,
    new Uint8Array([1]),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveIdentifyCandidates", () => {
  test("候选存在且有参考图 → 原样返回", async () => {
    const result = await resolveIdentifyCandidates(storage, "identify-demo", ["dog-01"]);
    expect(result).toEqual({ assetSlugs: ["dog-01"] });
  });

  test("候选混有无参考图的资产 → 跳过并记入 skipped", async () => {
    const result = await resolveIdentifyCandidates(storage, "identify-demo", [
      "dog-01",
      "bracket-01",
    ]);
    expect(result.assetSlugs).toEqual(["dog-01"]);
    expect(result.skipped).toEqual(["bracket-01"]);
  });

  test("候选全部没有参考图 → 报 no_reference_image", async () => {
    await expect(
      resolveIdentifyCandidates(storage, "identify-demo", ["bracket-01"]),
    ).rejects.toThrow("没有参考图");
  });

  test("候选 slug 不存在 → 报 asset_not_found", async () => {
    await expect(
      resolveIdentifyCandidates(storage, "identify-demo", ["ghost-99"]),
    ).rejects.toThrow("不存在");
  });
});
