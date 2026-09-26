import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile, projectSourceDir } from "../../common/libraryPaths";
import { AssetIdentitySchema, RequestSidecarSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
} from "../../services/assetStorage";
import { createProject, getProjectState } from "./projectTools";
import {
  runTripoAnimationRetarget,
  runTripoCharacter,
  runTripoImageTo3d,
  runTripoRetopology,
  runTripoRig,
  runTripoSegmentation,
  runTripoTexture,
} from "./tripoOps";

const root = await mkdtemp(join(tmpdir(), "chatspace-tripo-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 Tripo：v3 上传 → file_token；STS + S3 直传；v3 能力端点 → task_id → success + CDN */
function makeFakeTripoFetch() {
  const calls: { url: string; body?: unknown }[] = [];
  let uploadCount = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/files/upload-credentials")) {
      calls.push({ url });
      return jsonResponse({
        code: 0,
        data: {
          s3_host: "s3.fake",
          sts_ak: "ak",
          sts_sk: "sk",
          session_token: "st",
          resource_bucket: "tripo-data",
          resource_uri: "up/model.glb",
          file_token: "ft-2",
        },
      });
    }
    if (url.endsWith("/files")) {
      uploadCount += 1;
      const uploaded = init?.body instanceof FormData ? init.body.get("file") : null;
      calls.push({
        url,
        body: uploaded instanceof File
          ? { name: uploaded.name, bytes: [...new Uint8Array(await uploaded.arrayBuffer())] }
          : undefined,
      });
      return jsonResponse({ code: 0, data: { file_token: `ft-${uploadCount}` } });
    }
    if (url.startsWith("https://s3.fake/") && init?.method === "PUT") {
      calls.push({ url });
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/generation/image-to-model")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "gen-1" } });
    }
    if (url.endsWith("/generation/multiview-to-model")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "gen-multi-1" } });
    }
    if (url.endsWith("/models/import")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "imp-1" } });
    }
    if (url.endsWith("/mesh/segment")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "seg-1" } });
    }
    if (url.endsWith("/models/texture")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "tex-1" } });
    }
    if (url.endsWith("/mesh/decimate")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "retopo-1" } });
    }
    if (url.endsWith("/animations/rig")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "rig-1" } });
    }
    if (url.endsWith("/animations/retarget")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ code: 0, data: { task_id: "anim-1" } });
    }
    if (url.includes("/v3/tasks/seg-1")) {
      return jsonResponse({
        code: 0,
        data: {
          status: "success",
          output: {
            parts: [
              { model: "https://cdn.fake/part1.glb" },
              { model: "https://cdn.fake/part2.glb" },
            ],
          },
        },
      });
    }
    if (url.includes("/v3/tasks/")) {
      return jsonResponse({
        code: 0,
        data: {
          status: "success",
          output: {
            pbr_model: "https://cdn.fake/model.glb",
            rendered_image: "https://cdn.fake/render.webp",
          },
        },
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

beforeAll(async () => {
  await createProject(storage, { name: "Tripo 演示", slug: "tp" });
  await storage.writeBytes(`${projectSourceDir("tp")}/0-photo.png`, PNG_BYTES);
});

describe("runTripoTexture", () => {
  test("上传当前模型并只用 v3 texture 端点生成新模型", async () => {
    const dir = assetDir("tp", "painted-crate");
    await writeJson(storage, assetIdentityFile("tp", "painted-crate"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "painted-crate",
      kind: "model",
      name: "Painted crate",
      intent: "A painted crate",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${dir}/0-painted-crate.glb`, GLB_BYTES);
    const latestBytes = new Uint8Array([...GLB_BYTES, 1]);
    await storage.writeBytes(`${dir}/1-painted-crate.glb`, latestBytes);
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoTexture(
      storage,
      { projectSlug: "tp", assetSlug: "painted-crate", prompt: "worn red paint", pbr: true },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    const textureCall = calls.find((call) => call.url.endsWith("/models/texture"));
    expect(textureCall?.body).toEqual({
      input: "ft-1",
      texture_prompt: { text: "worn red paint" },
      pbr: true,
    });
    expect(calls.find((call) => call.url.endsWith("/files"))?.body).toEqual({
      name: "1-painted-crate.glb",
      bytes: [...latestBytes],
    });
    expect(calls.some((call) => call.url.endsWith("/models/import"))).toBe(false);
    expect(result.files[0]).toBe(`${dir}/2-painted-crate.glb`);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params.input_model).toBe(`${dir}/1-painted-crate.glb`);
    expect(sidecar.model).toBe("/models/texture");
    expect(sidecar.status).toBe("succeeded");
  });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("runTripoImageTo3d", () => {
  test("上传参考图 → 建任务 → 产物落盘 + 侧写存 tripo task id", async () => {
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoImageTo3d(
      storage,
      { projectSlug: "tp", assetSlug: "crate" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    // 上传走 v3 POST /files（旧的 /upload/file 已下线）
    const uploadCall = calls.find((c) => c.url.endsWith("/v3/files"));
    expect(uploadCall).toBeDefined();
    expect(calls.some((c) => c.url.includes("/upload/file"))).toBe(false);

    const createCall = calls.find((c) => c.url.endsWith("/generation/image-to-model"));
    expect((createCall?.body as { input: string }).input).toBe("ft-1");
    expect((createCall?.body as { model: string }).model).toBe("v3.1-20260211");

    const dir = assetDir("tp", "crate");
    expect(result.tripoTaskId).toBe("gen-1");
    expect(result.files[0]).toBe(`${dir}/0-crate.glb`);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.provider).toBe("tripo");
    expect(sidecar.providerTaskId).toBe("gen-1");
    expect(sidecar.status).toBe("succeeded");
  });

  test("有已标注的前后视图时 auto 使用 multiview-to-model", async () => {
    const front = `${projectSourceDir("tp")}/1-crate-front.png`;
    const back = `${projectSourceDir("tp")}/1-crate-back.png`;
    await storage.writeBytes(front, PNG_BYTES);
    await storage.writeBytes(back, new Uint8Array([...PNG_BYTES, 1]));
    const { fetchFn, calls } = makeFakeTripoFetch();

    const result = await runTripoImageTo3d(
      storage,
      {
        projectSlug: "tp",
        assetSlug: "crate-multiview",
        referenceViews: { front, back },
        generationMode: "auto",
      },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    expect(calls.some((call) => call.url.endsWith("/generation/image-to-model"))).toBe(false);
    const createCall = calls.find((call) => call.url.endsWith("/generation/multiview-to-model"));
    const body = createCall?.body as { inputs: Array<Record<string, string>>; model: string };
    expect(body.model).toBe("v3.1-20260211");
    expect(body.inputs.map((entry) => Object.keys(entry)[0])).toEqual(["front", "back"]);
    expect(body.inputs.flatMap((entry) => Object.values(entry)).sort()).toEqual(["ft-1", "ft-2"]);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.model).toBe("v3/generation/multiview-to-model");
    expect(sidecar.params.generation_mode).toBe("multiview");
  });
});

describe("runTripoSegmentation", () => {
  test("链最近一次 Tripo 任务 → v3 分割 → 部件落盘", async () => {
    await writeJson(storage, assetIdentityFile("tp", "crate"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "crate",
      kind: "model",
      name: "Crate",
      intent: "A wooden crate",
      sourceImages: [`${projectSourceDir("tp")}/0-photo.png`],
      createdAt: new Date().toISOString(),
    });
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoSegmentation(
      storage,
      { projectSlug: "tp", assetSlug: "crate" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    const segCall = calls.find((c) => c.url.endsWith("/v3/mesh/segment"));    expect((segCall?.body as { input: string }).input).toBe("gen-1");
    expect(result.files).toHaveLength(2);
    for (const file of result.files) {
      expect(await storage.exists(file)).toBe(true);
    }
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params.original_model_task_id).toBe("gen-1");
    const asset = (await getProjectState(storage, "tp")).assets.find(
      (entry) => entry.slug === "crate",
    );
    expect(asset?.latestModelOperation).toBe("v3/mesh/segment");
  });

  test("非 Tripo 生成但有模型文件的资产：自动 STS 导入后分割", async () => {
    const dir = assetDir("tp", "imported");
    await storage.writeBytes(`${dir}/0-imported.glb`, GLB_BYTES);

    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoSegmentation(
      storage,
      { projectSlug: "tp", assetSlug: "imported" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );
    // 走了 v3 STS 换发 + S3 直传 + /models/import
    expect(calls.some((c) => c.url.endsWith("/files/upload-credentials"))).toBe(true);
    expect(calls.some((c) => c.url.startsWith("https://s3.fake/"))).toBe(true);
    const importCall = calls.find((c) => c.url.endsWith("/models/import"));
    expect((importCall?.body as { input: string }).input).toBe("ft-2");
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("既无 Tripo 记录也无模型文件：明确报错", async () => {
    const { fetchFn } = makeFakeTripoFetch();
    expect(
      runTripoSegmentation(
        storage,
        { projectSlug: "tp", assetSlug: "no-tripo" },
        { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("没有模型文件");
  });
});

describe("Tripo v3 mesh and animation capabilities", () => {
  test("智能重拓扑使用 /mesh/decimate 并校验 quad 面数上限", async () => {
    const dir = assetDir("tp", "retopo-crate");
    await storage.writeBytes(`${dir}/0-retopo-crate.glb`, GLB_BYTES);
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoRetopology(
      storage,
      {
        projectSlug: "tp",
        assetSlug: "retopo-crate",
        faceLimit: 8_000,
        quad: true,
      },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    const call = calls.find((entry) => entry.url.endsWith("/mesh/decimate"));
    expect(call?.body).toEqual({
      input: "imp-1",
      model: "v2.0",
      face_limit: 8_000,
      quad: true,
      bake: true,
    });
    expect(result.files.length).toBeGreaterThan(0);
    expect(
      runTripoRetopology(
        storage,
        { projectSlug: "tp", assetSlug: "retopo-crate", faceLimit: 10_001, quad: true },
        { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("500–10000");
  });

  test("非人形绑骨自动选 v2.5，动作只引用最近的 Tripo 绑骨任务", async () => {
    const dir = assetDir("tp", "bird");
    await storage.writeBytes(`${dir}/0-bird.glb`, GLB_BYTES);
    const { fetchFn, calls } = makeFakeTripoFetch();
    await runTripoRig(
      storage,
      { projectSlug: "tp", assetSlug: "bird", rigType: "avian", spec: "tripo" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );
    const rigCall = calls.find((entry) => entry.url.endsWith("/animations/rig"));
    expect(rigCall?.body).toEqual({
      input: "imp-1",
      model: "v2.5-20260210",
      out_format: "glb",
      rig_type: "avian",
      spec: "tripo",
    });

    await runTripoAnimationRetarget(
      storage,
      {
        projectSlug: "tp",
        assetSlug: "bird",
        animation: "preset:walk",
        animateInPlace: true,
      },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );
    const animationCall = calls.find((entry) => entry.url.endsWith("/animations/retarget"));
    expect(animationCall?.body).toEqual({
      input: "rig-1",
      animation: "preset:walk",
      out_format: "glb",
      bake_animation: true,
      export_with_geometry: true,
      animate_in_place: true,
    });
  });

  test("人物生成组合 image-to-model 与 biped rig，并发布正式资产", async () => {
    const image = `${projectSourceDir("tp")}/0-photo.png`;
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoCharacter(
      storage,
      { projectSlug: "tp", assetSlug: "tripo-hero", image, spec: "mixamo" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    expect(calls.some((entry) => entry.url.endsWith("/generation/image-to-model"))).toBe(true);
    const rigCall = calls.find((entry) => entry.url.endsWith("/animations/rig"));
    expect(rigCall?.body).toEqual({
      input: "gen-1",
      model: "v1.0-20240301",
      out_format: "glb",
      rig_type: "biped",
      spec: "mixamo",
    });
    expect(result.tripoTaskId).toBe("rig-1");
    const identity = await readJson(
      storage,
      assetIdentityFile("tp", "tripo-hero"),
      AssetIdentitySchema,
    );
    expect(identity.sourceImages).toEqual([image]);
  });
});
