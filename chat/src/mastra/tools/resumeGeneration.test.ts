import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { assetDir, assetIdentityFile, projectSourceDir } from "../../common/libraryPaths";
import { AssetIdentitySchema, RequestSidecarSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
} from "../../services/assetStorage";
import { createProject, requireProject } from "./projectTools";
import { listResumableSidecars, resumeGeneration } from "./resumeGeneration";

const root = await mkdtemp(join(tmpdir(), "chatspace-resume-test-"));
const storage = new LocalFileStorage(root);
const BYTES = new Uint8Array([1, 2, 3, 4]);
const SEED_GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假供应商：World Labs operation 直接 done */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith("https://cdn.fake/")) {
    return new Response(BYTES.buffer.slice(0), { status: 200 });
  }
  if (url.includes("/operations/")) {
    return jsonResponse({
      operation_id: "op-9",
      done: true,
      response: {
        assets: {
          mesh: { collider_mesh_url: "https://cdn.fake/world.glb" },
          splats: { spz_urls: { full_res: "https://cdn.fake/full.spz" } },
        },
      },
    });
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

const now = new Date().toISOString();

beforeAll(async () => {
  await createProject(storage, { name: "续跑演练", slug: "rz" });
  // 模拟"提交后进程崩溃"留下的 running 侧写：有 providerTaskId、无 outputs
  await writeJson(
    storage,
    `${assetDir("rz", "world")}/.0-world-request.json`,
    RequestSidecarSchema,
    {
      schemaVersion: 1,
      index: 0,
      slug: "world",
      provider: "world-labs",
      model: "marble-1.1",
      providerTaskId: "op-9",
      params: {},
      status: "running",
      outputs: [],
      createdAt: now,
      updatedAt: now,
    },
  );
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("凭侧写续跑", () => {
  test("扫描出全部 queued/running 侧写并标注可续跑性", async () => {
    const resumable = await listResumableSidecars(storage, "rz");
    expect(resumable).toHaveLength(1);
    const bySlug = Object.fromEntries(resumable.map((r) => [r.slug, r]));
    expect(bySlug.world?.hasProviderTaskId).toBe(true);
  });


  test("World Labs 任务续跑：只轮询 operation，不重新提交", async () => {
    const phases: string[] = [];
    const result = await resumeGeneration(
      storage,
      `${assetDir("rz", "world")}/.0-world-request.json`,
      { worldLabsApiKey: "wlt", fetchFn: fakeFetch, pollIntervalMs: 1 },
      (phase) => {
        phases.push(phase);
      },
    );
    expect(result.files).toContain(`${assetDir("rz", "world")}/0-world.glb`);
    expect(result.files).toContain(`${assetDir("rz", "world")}/0-world-full-res.spz`);
    expect(await storage.exists(`${assetDir("rz", "world")}/0-world.json`)).toBe(true);
    // 续跑也要报阶段，否则看板上跟「卡死」长得一样
    expect(phases).toEqual(["downloading"]);
  });

  test("世界续跑成功后登记资产身份与当前世界指针（否则文件在、界面里没有这个世界）", async () => {
    const identity = await readJson(
      storage,
      assetIdentityFile("rz", "world"),
      AssetIdentitySchema,
    );
    expect(identity.kind).toBe("world");
    expect((await requireProject(storage, "rz")).currentWorld).toBe("world");
  });

});

describe("resumeGeneration · 新渠道", () => {
  test("已成功的 Seed3D ZIP 无需 key 或重新请求即可恢复为 GLB", async () => {
    const dir = assetDir("rz", "seed-chair");
    const zip = new JSZip();
    zip.file("pbr/mesh_textured_pbr.glb", SEED_GLB_BYTES);
    await storage.writeBytes(
      `${dir}/0-seed-chair.zip`,
      await zip.generateAsync({ type: "uint8array" }),
    );
    await writeJson(storage, `${dir}/.0-seed-chair-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 0,
      slug: "seed-chair",
      provider: "seed3d",
      model: "doubao-seed3d-2-0-260328",
      providerTaskId: "seed-done",
      params: {},
      status: "succeeded",
      outputs: [
        {
          path: `${dir}/0-seed-chair.zip`,
          providerUrl: "https://cdn.fake/model.zip",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const result = await resumeGeneration(
      storage,
      `${dir}/.0-seed-chair-request.json`,
      {},
    );
    expect(result.files).toEqual([`${dir}/0-seed-chair.glb`]);
    expect(await storage.readBytes(result.files[0]!)).toEqual(SEED_GLB_BYTES);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.outputs[0]?.path).toBe(`${dir}/0-seed-chair.glb`);
  });

  test("缺对应渠道 key 时明确报错", async () => {
    const dir = assetDir("rz", "no-key");
    await writeJson(storage, `${dir}/.0-no-key-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 0,
      slug: "no-key",
      provider: "tripo",
      model: "image_to_model",
      providerTaskId: "t-1",
      params: {},
      status: "running",
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(
      resumeGeneration(storage, `${dir}/.0-no-key-request.json`, {}),
    ).rejects.toThrow("Tripo3D API key");
  });
});
