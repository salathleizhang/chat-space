import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, writeJson } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { resolveModelPublicUrl } from "./modelPublicUrl";

const root = await mkdtemp(join(tmpdir(), "chatspace-relay-test-"));
const storage = new LocalFileStorage(root);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

async function writeSidecar(
  slug: string,
  index: number,
  outputPath: string,
  providerUrl: string | undefined,
  updatedAt: string,
) {
  const dir = assetDir("relay", slug);
  await writeJson(storage, `${dir}/.${index}-${slug}-request.json`, RequestSidecarSchema, {
    schemaVersion: 1,
    index,
    slug,
    provider: "volcengine",
    model: "x/y",
    params: {},
    status: "succeeded",
    outputs: [providerUrl ? { path: outputPath, providerUrl } : { path: outputPath }],
    createdAt: updatedAt,
    updatedAt,
  });
}

beforeAll(async () => {
  await createProject(storage, { name: "模型链接演示", slug: "relay" });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("resolveModelPublicUrl 策略链", () => {
  test("未过期 providerUrl 直接复用，不上传", async () => {
    const dir = assetDir("relay", "fresh");
    await storage.writeBytes(`${dir}/0-fresh.glb`, GLB_BYTES);
    await writeSidecar("fresh", 0, `${dir}/0-fresh.glb`, "https://cdn.vendor/a.glb", new Date().toISOString());
    const ref = await resolveModelPublicUrl(storage, "relay", "fresh");
    expect(ref).toEqual({ url: "https://cdn.vendor/a.glb", type: "GLB" });
  });


  test("链接过期时使用原供应商 URL 兜底", async () => {
    const dir = assetDir("relay", "stale");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await storage.writeBytes(`${dir}/0-stale.glb`, GLB_BYTES);
    await writeSidecar("stale", 0, `${dir}/0-stale.glb`, "https://cdn.vendor/old.glb", stale);
    const ref = await resolveModelPublicUrl(storage, "relay", "stale");
    expect(ref).toEqual({ url: "https://cdn.vendor/old.glb", type: "GLB" });
  });


  test("本地导入且没有公网 URL 时明确报错", async () => {
    const dir = assetDir("relay", "imported");
    await storage.writeBytes(`${dir}/0-imported.fbx`, GLB_BYTES);
    expect(resolveModelPublicUrl(storage, "relay", "imported")).rejects.toThrow(
      "public URL",
    );
  });

  test("没有任何模型文件 → 报错要求先生成", () => {
    expect(resolveModelPublicUrl(storage, "relay", "nothing")).rejects.toThrow(
      "no model file",
    );
  });
});
