import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, writeJson } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { resolveModelPublicUrl } from "./storageRelay";

const root = await mkdtemp(join(tmpdir(), "chatspace-relay-test-"));
const storage = new LocalFileStorage(root);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

/** 假·fal 存储：initiate → { upload_url, file_url }，PUT 记录字节数 */
function makeFakeFalStorageFetch() {
  const calls: { url: string; method: string; bodyBytes?: number }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      bodyBytes: init?.body instanceof Uint8Array ? init.body.byteLength : undefined,
    });
    if (url.includes("/storage/upload/initiate")) {
      return new Response(
        JSON.stringify({ upload_url: "https://up.fake/x", file_url: "https://cdn.fake/relayed.glb" }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://up.fake/")) {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

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
    provider: "fal",
    model: "x/y",
    params: {},
    status: "succeeded",
    outputs: [providerUrl ? { path: outputPath, providerUrl } : { path: outputPath }],
    createdAt: updatedAt,
    updatedAt,
  });
}

beforeAll(async () => {
  await createProject(storage, { name: "中转演示", slug: "relay" });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("resolveModelPublicUrl 策略链", () => {
  test("未过期 providerUrl 直接复用，不上传", async () => {
    const dir = assetDir("relay", "fresh");
    await storage.writeBytes(`${dir}/0-fresh.glb`, GLB_BYTES);
    await writeSidecar("fresh", 0, `${dir}/0-fresh.glb`, "https://cdn.vendor/a.glb", new Date().toISOString());
    const { fetchFn, calls } = makeFakeFalStorageFetch();
    const ref = await resolveModelPublicUrl(storage, "relay", "fresh", {
      falApiKey: "fk",
      fetchFn,
    });
    expect(ref).toEqual({ url: "https://cdn.vendor/a.glb", type: "GLB", relayed: false });
    expect(calls).toHaveLength(0);
  });

  test("链接过期 + fal key → 上传本地文件换新 URL", async () => {
    const dir = assetDir("relay", "stale");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await storage.writeBytes(`${dir}/0-stale.glb`, GLB_BYTES);
    await writeSidecar("stale", 0, `${dir}/0-stale.glb`, "https://cdn.vendor/old.glb", stale);
    const { fetchFn, calls } = makeFakeFalStorageFetch();
    const ref = await resolveModelPublicUrl(storage, "relay", "stale", {
      falApiKey: "fk",
      fetchFn,
    });
    expect(ref).toEqual({ url: "https://cdn.fake/relayed.glb", type: "GLB", relayed: true });
    expect(calls[0]?.url).toContain("/storage/upload/initiate");
    expect(calls[1]).toMatchObject({ url: "https://up.fake/x", method: "PUT", bodyBytes: GLB_BYTES.byteLength });
  });

  test("链接过期 + 无 fal key → 过期 URL 兜底", async () => {
    const ref = await resolveModelPublicUrl(storage, "relay", "stale", {});
    expect(ref).toEqual({ url: "https://cdn.vendor/old.glb", type: "GLB", relayed: false });
  });

  test("本地导入（无侧写 URL）+ fal key → 上传", async () => {
    const dir = assetDir("relay", "imported");
    await storage.writeBytes(`${dir}/0-imported.fbx`, GLB_BYTES);
    const { fetchFn } = makeFakeFalStorageFetch();
    const ref = await resolveModelPublicUrl(storage, "relay", "imported", {
      falApiKey: "fk",
      fetchFn,
    });
    expect(ref).toEqual({ url: "https://cdn.fake/relayed.glb", type: "FBX", relayed: true });
  });

  test("本地导入 + 无 fal key → 报错并指引激活中转存储", () => {
    expect(resolveModelPublicUrl(storage, "relay", "imported", {})).rejects.toThrow(
      "公网 URL",
    );
  });

  test("没有任何模型文件 → 报错要求先生成", () => {
    expect(resolveModelPublicUrl(storage, "relay", "nothing", {})).rejects.toThrow(
      "没有模型文件",
    );
  });
});
