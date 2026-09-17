import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { MESHY_PATHS, extractMeshyFileUrls } from "../../models/meshy";
import {
  LocalFileStorage,
  readJson,
  writeJson,
} from "../../services/assetStorage";
import { runMeshOperation } from "./meshOps";
import { latestAssetModel } from "./projectTools";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-meshops-test-"));
const storage = new LocalFileStorage(root);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 Meshy：POST 建任务 → GET 轮询 SUCCEEDED（带多格式产物 URL）+ 假 CDN */
function makeFakeMeshyFetch(options?: { failTask?: boolean }) {
  const submits: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (init?.method === "POST") {
      submits.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return jsonResponse({ result: "meshy-task-1" });
    }
    if (options?.failTask) {
      return jsonResponse({
        status: "FAILED",
        task_error: { message: "insufficient credits" },
      });
    }
    return jsonResponse({
      status: "SUCCEEDED",
      model_urls: {
        glb: "https://cdn.fake/out.glb",
        fbx: "https://cdn.fake/out.fbx",
      },
      thumbnail_url: "https://cdn.fake/thumb.png",
    });
  }) as typeof fetch;
  return { fetchFn, submits };
}

beforeAll(async () => {
  await createProject(storage, { name: "后处理演示", slug: "ops" });
  const dir = assetDir("ops", "crate");
  await storage.writeBytes(`${dir}/0-crate.glb`, GLB_BYTES);
  await storage.writeBytes(`${dir}/1-crate.glb`, GLB_BYTES);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("latestAssetModel / extractMeshyFileUrls", () => {
  test("取最高索引模型；无模型时 409", async () => {
    expect(await latestAssetModel(storage, "ops", "crate")).toBe(
      `${assetDir("ops", "crate")}/1-crate.glb`,
    );
    expect(latestAssetModel(storage, "ops", "nothing")).rejects.toThrow("没有模型文件");
  });

  test("按扩展名递归扫产物 URL", () => {
    const refs = extractMeshyFileUrls({
      model_urls: { glb: "https://a/x.glb" },
      result: { animation_fbx_url: "https://a/y.fbx" },
      note: "https://a/page.html",
    });
    expect(refs.map((r) => r.url)).toEqual(["https://a/x.glb", "https://a/y.fbx"]);
  });
});

describe("runMeshOperation", () => {
  test("贴图重生成全链路：data URI 注入 → 任务 → 多产物共享新索引 + 侧写", async () => {
    const { fetchFn, submits } = makeFakeMeshyFetch();
    const result = await runMeshOperation(
      storage,
      {
        projectSlug: "ops",
        assetSlug: "crate",
        path: MESHY_PATHS.retexture,
        modelField: "model_url",
        body: { text_style_prompt: "rusty metal", enable_pbr: true },
        sidecarParams: { text_style_prompt: "rusty metal", enable_pbr: true },
      },
      { apiKey: "msy-key", fetchFn, pollIntervalMs: 1 },
    );

    // 模型以 data URI 注入请求体
    expect(String(submits[0]?.body.model_url)).toStartWith("data:");
    expect(submits[0]?.url).toContain("/openapi/v1/retexture");

    const dir = assetDir("ops", "crate");
    expect(result.files).toEqual([
      `${dir}/2-crate.glb`,
      `${dir}/2-crate-f2.fbx`,
      `${dir}/2-crate-f3.png`,
    ]);
    for (const file of result.files) {
      expect(await storage.exists(file)).toBe(true);
    }
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.provider).toBe("meshy");
    expect(sidecar.providerTaskId).toBe("meshy-task-1");
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.params.input_model).toBe(`${dir}/1-crate.glb`);
  });

  test("Meshy 任务失败：侧写记 failed 并携带原因", async () => {
    const { fetchFn } = makeFakeMeshyFetch({ failTask: true });
    expect(
      runMeshOperation(
        storage,
        {
          projectSlug: "ops",
          assetSlug: "crate",
          path: MESHY_PATHS.remesh,
          modelField: "model_url",
          body: { target_polycount: 5000 },
          sidecarParams: { target_polycount: 5000 },
        },
        { apiKey: "msy-key", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("insufficient credits");
  });

  test("动作生成链式：读取该资产成功绑骨侧写的任务 id", async () => {
    // 预写一条成功的绑骨侧写
    const dir = assetDir("ops", "hero");
    await storage.writeBytes(`${dir}/0-hero.glb`, GLB_BYTES);
    await writeJson(storage, `${dir}/.1-hero-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 1,
      slug: "hero",
      provider: "meshy",
      model: MESHY_PATHS.rigging,
      providerTaskId: "rig-42",
      params: {},
      status: "succeeded",
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const { fetchFn, submits } = makeFakeMeshyFetch();
    const result = await runMeshOperation(
      storage,
      {
        projectSlug: "ops",
        assetSlug: "hero",
        path: MESHY_PATHS.animations,
        body: { rig_task_id: "rig-42", action_id: 7 },
        sidecarParams: { rig_task_id: "rig-42", action_id: 7 },
      },
      { apiKey: "msy-key", fetchFn, pollIntervalMs: 1 },
    );
    expect(submits[0]?.body.rig_task_id).toBe("rig-42");
    expect(result.files.length).toBeGreaterThan(0);
  });
});
