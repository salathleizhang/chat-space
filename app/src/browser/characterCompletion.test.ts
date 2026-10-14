import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetIdentitySchema, RequestSidecarSchema } from "../../../chat/src/dto/library";
import { LocalFileStorage, readJson, writeJson } from "../../../chat/src/services/assetStorage";
import { publishCompletedCharacter } from "./characterCompletion";

test("分段续跑的人物完成后发布资产身份，使用生成回执里的原图，重复修复不换身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "character-publish-"));
  const storage = new LocalFileStorage(root);
  const dir = "projects/audit/assets/hero";
  const image = "projects/audit/source/0-human.png";
  const model = `${dir}/1-hero.glb`;
  const receipts = [`${dir}/.0-hero-request.json`, `${dir}/.1-hero-request.json`];
  const now = new Date().toISOString();
  try {
    await storage.writeBytes(model, new Uint8Array([1, 2, 3]));
    for (const [index, operation] of ["v3/generation/image-to-model", "/animations/rig"].entries()) {
      await writeJson(storage, receipts[index]!, RequestSidecarSchema, {
        schemaVersion: 1, index, slug: "hero", provider: "tripo3d", model: operation,
        params: index === 0 ? { image } : {}, status: "succeeded", outputs: [], createdAt: now, updatedAt: now,
      });
    }
    await expect(publishCompletedCharacter(storage, "audit", "hero", [receipts[0]!], { files: [model] }))
      .rejects.toThrow("both finish");
    expect(await storage.exists(`${dir}/asset.json`)).toBe(false);
    await publishCompletedCharacter(storage, "audit", "hero", receipts, { files: [model] });
    const identity = await readJson(storage, `${dir}/asset.json`, AssetIdentitySchema);
    expect(identity.sourceImages).toEqual([image]);
    expect(identity.kind).toBe("model");
    await publishCompletedCharacter(storage, "audit", "hero", receipts, { files: [model] });
    expect((await readJson(storage, `${dir}/asset.json`, AssetIdentitySchema)).id).toBe(identity.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
