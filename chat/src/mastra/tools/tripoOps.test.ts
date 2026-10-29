import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCloudContext, type CloudOperation } from "../../cloud/context";
import { executeCloudOperation } from "../../cloud/operations";
import { assetDir, assetIdentityFile, projectSourceDir } from "../../common/libraryPaths";
import { AssetIdentitySchema, RequestSidecarSchema } from "../../dto/library";
import type { GenerationTask } from "../../dto/tasks";
import { TRIPO_P2_MODEL } from "../../models/tripo";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
  writeJson,
} from "../../services/assetStorage";
import { clearTasks, listTasks } from "../../services/tasks";
import { generateAnimationTool } from "./meshOps";
import { createProject, getProjectState } from "./projectTools";
import {
  runTripoAnimationRetarget,
  runTripoCharacter,
  runTripoImageTo3d,
  runTripoRetopology,
  runTripoRig,
  runTripoSegmentation,
  runTripoTexture,
  tripoStatusPhase,
} from "./tripoOps";

const root = await mkdtemp(join(tmpdir(), "chatspace-tripo-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * 假 Tripo：v3 上传 → file_token；STS + S3 直传；v3 能力端点 → task_id → success + CDN。
 * `pendingPolls` 让前 N 次状态查询先回 `running`（用来验证任务阶段随轮询推进）。
 */
function makeFakeTripoFetch(options: { pendingPolls?: number } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  let uploadCount = 0;
  let pendingPolls = options.pendingPolls ?? 0;
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
    if (url.endsWith("/v3/tasks/list")) {
      // 批量查询：一次请求回答一批 task_id（官方 POST /tasks/list 的形状）
      const ids = (JSON.parse(String(init?.body)) as { task_ids: string[] }).task_ids;
      calls.push({ url, body: { task_ids: ids } });
      if (pendingPolls > 0) {
        pendingPolls -= 1;
        return jsonResponse({
          code: 0,
          data: {
            tasks: Object.fromEntries(ids.map((id) => [id, { status: "running", progress: 40 }])),
            missed: [],
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          tasks: Object.fromEntries(
            ids.map((id) => [
              id,
              id === "seg-1"
                ? {
                    status: "success",
                    output: {
                      parts: [
                        { model: "https://cdn.fake/part1.glb" },
                        { model: "https://cdn.fake/part2.glb" },
                      ],
                    },
                  }
                : {
                    status: "success",
                    output: {
                      pbr_model: "https://cdn.fake/model.glb",
                      rendered_image: "https://cdn.fake/render.webp",
                    },
                  },
            ]),
          ),
          missed: [],
        },
      });
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
      model: "v3.5-20260815",
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

  test("textureQuality 与 delight 原样提交，并写进请求侧写", async () => {
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoTexture(
      storage,
      {
        projectSlug: "tp",
        assetSlug: "painted-crate",
        textureQuality: "fast",
        delight: false,
      },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 },
    );

    const textureCall = calls.find((call) => call.url.endsWith("/models/texture"));
    expect(textureCall?.body).toMatchObject({
      model: "v3.5-20260815",
      texture_quality: "fast",
      delight: false,
    });
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params).toMatchObject({
      texture_model: "v3.5-20260815",
      texture_quality: "fast",
      delight: false,
    });
  });
});

describe("Tripo 任务的阶段推进", () => {
  test("状态映射：终态之前都算生成，拿到产物才是下载", () => {
    expect(tripoStatusPhase("queued")).toBe("generating");
    expect(tripoStatusPhase("running")).toBe("generating");
    expect(tripoStatusPhase("processing")).toBe("generating");
    expect(tripoStatusPhase("success")).toBe("downloading");
  });

  test("runTripoTexture 全程报阶段：提交后 generating、每次轮询再刷、产物落地前 downloading", async () => {
    const dir = assetDir("tp", "phase-crate");
    await writeJson(storage, assetIdentityFile("tp", "phase-crate"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "phase-crate",
      kind: "model",
      name: "Phase crate",
      intent: "A crate for the phase test",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${dir}/0-phase-crate.glb`, GLB_BYTES);

    // 两次 running 之后才 success：阶段必须被反复推进，任务时间戳才跟着走
    const { fetchFn } = makeFakeTripoFetch({ pendingPolls: 2 });
    const phases: string[] = [];
    const result = await runTripoTexture(
      storage,
      { projectSlug: "tp", assetSlug: "phase-crate", prompt: "green fabric" },
      {
        apiKey: "tsk-1",
        fetchFn,
        pollIntervalMs: 1,
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
    );

    expect(phases[0]).toBe("generating");
    // 提交 1 次 + 两次 running 轮询：世界里"卡死"和"在动"的区别就靠这个
    expect(phases.filter((phase) => phase === "generating").length).toBeGreaterThanOrEqual(3);
    expect(phases.at(-1)).toBe("downloading");
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
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

  test("显式 imageModel 覆盖默认几何模型，请求体与侧写都按它提交", async () => {
    const { fetchFn, calls } = makeFakeTripoFetch();
    const result = await runTripoImageTo3d(
      storage,
      { projectSlug: "tp", assetSlug: "crate-pinned" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1, imageModel: "v2.5-20250123" },
    );

    const createCall = calls.find((c) => c.url.endsWith("/generation/image-to-model"));
    expect((createCall?.body as { model: string }).model).toBe("v2.5-20250123");
    /** v2.5 几何仍配 v2.5 贴图，不会被升到 v3.5。 */
    expect((createCall?.body as { texture_version: string }).texture_version)
      .toBe("v2.5-20250123");
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params.image_model).toBe("v2.5-20250123");
    expect(sidecar.params.texture_model).toBe("v2.5-20250123");
  });

  test("P 系列几何模型走同一端点，贴图版本取最新的 v3.5", async () => {
    const { fetchFn, calls } = makeFakeTripoFetch();
    await runTripoImageTo3d(
      storage,
      { projectSlug: "tp", assetSlug: "crate-p2" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1, imageModel: TRIPO_P2_MODEL },
    );

    const createCall = calls.find((c) => c.url.endsWith("/generation/image-to-model"));
    expect(createCall?.body).toMatchObject({
      model: "P2-20260801",
      texture_version: "v3.5-20260815",
    });
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
    ).rejects.toThrow("no model file");
  });
});

describe("Tripo v3 mesh and animation capabilities", () => {
  test("没有成功绑骨记录时不提交动画或自动绑骨", async () => {
    const { fetchFn, calls } = makeFakeTripoFetch();
    await expect(runTripoAnimationRetarget(storage,
      { projectSlug: "tp", assetSlug: "unrigged", animation: "preset:biped:walk" },
      { apiKey: "tsk-1", fetchFn },
    )).rejects.toThrow("run rig-model first");
    expect(calls).toEqual([]);
  });

  test("动画工具任务完成并落盘含几何的烘焙 GLB", async () => {
    const dir = assetDir("tp", "animated-hero");
    await storage.writeBytes(`${dir}/0-animated-hero.glb`, GLB_BYTES);
    const { fetchFn, calls } = makeFakeTripoFetch();
    await runTripoRig(storage, { projectSlug: "tp", assetSlug: "animated-hero" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 });
    const originalFetch = globalThis.fetch;
    setAssetStorage(storage);
    globalThis.fetch = fetchFn;
    try {
      const started = await generateAnimationTool.execute!(
        { assetSlug: "animated-hero", animation: "preset:biped:run", animateInPlace: true },
        { requestContext: new Map([["projectSlug", "tp"], ["tripo3dApiKey", "tsk-1"]]) } as never,
      ) as { task: { id: string } };
      let task: GenerationTask | undefined;
      const deadline = Date.now() + 5_000;
      do {
        task = (await listTasks("tp")).find(entry => entry.id === started.task.id);
        if (task?.status !== "running") break;
        if (Date.now() > deadline) throw new Error("动画任务未完成");
        await Bun.sleep(10);
      } while (true);
      expect(task?.workflowId).toBe("animation");
      expect(task?.assetSlug).toBe("animated-hero");
      expect(task?.status).toBe("succeeded");
      expect(task?.phase).toBe("completed");
      const result = task?.result as { files: string[]; sidecar: string };
      expect(result.files.some(path => path.endsWith(".glb"))).toBe(true);
      expect(await storage.exists(result.files[0]!)).toBe(true);
      expect((await readJson(storage, result.sidecar, RequestSidecarSchema)).providerTaskId).toBe("anim-1");
      expect(calls.find(entry => entry.url.endsWith("/animations/retarget"))?.body).toEqual({
        input: "rig-1", animation: "preset:biped:run", out_format: "glb",
        bake_animation: true, export_with_geometry: true, animate_in_place: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      clearTasks();
      setAssetStorage(undefined);
    }
  });

  test("浏览器任务排队后可通过动画操作执行，入队不提交供应商请求", async () => {
    const dir = assetDir("tp", "cloud-hero");
    await storage.writeBytes(`${dir}/0-cloud-hero.glb`, GLB_BYTES);
    const { fetchFn, calls } = makeFakeTripoFetch();
    await runTripoRig(storage, { projectSlug: "tp", assetSlug: "cloud-hero" },
      { apiKey: "tsk-1", fetchFn, pollIntervalMs: 1 });
    const originalFetch = globalThis.fetch;
    setAssetStorage(storage);
    globalThis.fetch = fetchFn;
    try {
      const queued: { task: GenerationTask; operation: CloudOperation }[] = [];
      const scope = { workspace: "browser", pending: [] as Promise<unknown>[],
        enqueue: async (task: GenerationTask, operation: CloudOperation) => { queued.push({ task, operation }); } };
      const input = { assetSlug: "cloud-hero", animation: "preset:biped:walk", animateInPlace: true };
      const before = calls.length;
      await withCloudContext(scope, () => generateAnimationTool.execute!(input,
        { requestContext: new Map([["projectSlug", "tp"], ["tripo3dApiKey", "tsk-1"]]) } as never));
      await Promise.all(scope.pending);
      expect(calls.length).toBe(before);
      expect(queued[0]?.operation).toEqual({ operation: "animation", input });
      const phases: string[] = [];
      const job = queued[0]!;
      const result = await executeCloudOperation(job.task, job.operation, {
        id: job.task.id, setPhase: async phase => { phases.push(phase); }, setAssetSlug: async () => {},
      }) as { files: string[] };
      expect(result.files.some(path => path.endsWith(".glb"))).toBe(true);
      expect(phases).toContain("generating");
      expect(phases).toContain("downloading");
      expect(calls.find(entry => entry.url.endsWith("/animations/retarget"))?.body).toMatchObject({
        input: "rig-1", animation: "preset:biped:walk", animate_in_place: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      setAssetStorage(undefined);
    }
  });

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
