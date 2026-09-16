import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { assetDir, projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
} from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { listResumableSidecars, resumeGeneration } from "./resumeGeneration";

const root = await mkdtemp(join(tmpdir(), "gabo-resume-test-"));
const storage = new LocalFileStorage(root);
const BYTES = new Uint8Array([1, 2, 3, 4]);
const SEED_GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假供应商：FAL 状态直接 COMPLETED；World Labs operation 直接 done */
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
  if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
  if (url.includes("/requests/")) {
    return jsonResponse({
      model_mesh: { url: "https://cdn.fake/crate.glb" },
      textures: [{ url: "https://cdn.fake/tex.png", content_type: "image/png" }],
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
    `${assetDir("rz", "crate")}/.0-crate-request.json`,
    RequestSidecarSchema,
    {
      schemaVersion: 1,
      index: 0,
      slug: "crate",
      provider: "fal",
      model: "fal-ai/hunyuan3d-v3/image-to-3d",
      providerTaskId: "req-crashed",
      params: { image: "projects/rz/source/0-a.png" },
      status: "running",
      outputs: [],
      createdAt: now,
      updatedAt: now,
    },
  );
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
  // 无 providerTaskId 的 queued 侧写：不可续跑
  await writeJson(
    storage,
    `${projectSourceDir("rz")}/.0-edit-request.json`,
    RequestSidecarSchema,
    {
      schemaVersion: 1,
      index: 0,
      slug: "edit",
      provider: "fal",
      model: "fal-ai/nano-banana-2/edit",
      params: {},
      status: "queued",
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
    expect(resumable).toHaveLength(3);
    const bySlug = Object.fromEntries(resumable.map((r) => [r.slug, r]));
    expect(bySlug.crate?.hasProviderTaskId).toBe(true);
    expect(bySlug.edit?.hasProviderTaskId).toBe(false);
  });

  test("已停用的 FAL 历史任务不得续跑", async () => {
    await expect(resumeGeneration(
      storage,
      `${assetDir("rz", "crate")}/.0-crate-request.json`,
      { falApiKey: "sk-fal", fetchFn: fakeFetch, pollIntervalMs: 1 },
    )).rejects.toThrow("已停用");
  });

  test("World Labs 任务续跑：只轮询 operation，不重新提交", async () => {
    const result = await resumeGeneration(
      storage,
      `${assetDir("rz", "world")}/.0-world-request.json`,
      { worldLabsApiKey: "wlt", fetchFn: fakeFetch, pollIntervalMs: 1 },
    );
    expect(result.files).toContain(`${assetDir("rz", "world")}/0-world.glb`);
    expect(result.files).toContain(`${assetDir("rz", "world")}/0-world-full-res.spz`);
    expect(await storage.exists(`${assetDir("rz", "world")}/0-world.json`)).toBe(true);
  });

  test("无供应商任务 id 时拒绝续跑并指引重新生成", async () => {
    expect(
      resumeGeneration(storage, `${projectSourceDir("rz")}/.0-edit-request.json`, {
        falApiKey: "sk-fal",
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow("已停用");
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

  test("meshy 侧写：接续轮询任务并落盘（沿用原索引）", async () => {
    const dir = assetDir("rz", "meshy-crate");
    await writeJson(storage, `${dir}/.3-meshy-crate-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 3,
      slug: "meshy-crate",
      provider: "meshy",
      model: "/openapi/v1/retexture",
      providerTaskId: "mt-1",
      params: {},
      status: "running",
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const meshyFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cdn.fake/")) {
        return new Response(BYTES.buffer.slice(0), { status: 200 });
      }
      return jsonResponse({
        status: "SUCCEEDED",
        model_urls: { glb: "https://cdn.fake/re.glb" },
      });
    }) as typeof fetch;

    await expect(resumeGeneration(storage, `${dir}/.3-meshy-crate-request.json`, {
      meshyApiKey: "mk",
      fetchFn: meshyFetch,
      pollIntervalMs: 1,
    })).rejects.toThrow("已停用");
    const sidecar = await readJson(
      storage,
      `${dir}/.3-meshy-crate-request.json`,
      RequestSidecarSchema,
    );
    expect(sidecar.status).toBe("running");
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
