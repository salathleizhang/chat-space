import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetIdentityFile,
  projectCandidatesFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  CandidateRegistrySchema,
  RequestSidecarSchema,
} from "../../dto/library";
import { config } from "../../config";
import { SEED3D_MODEL } from "../../models/seed3d";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
  writeJson,
} from "../../services/assetStorage";
import { clearTasks, getTask } from "../../services/tasks";
import { buildRequestContext } from "../../services/workflowRuns";
import { createProject } from "./projectTools";
import {
  resolveWorldSourceImage,
  start3dBatchTool,
  startWorldTaskTool,
} from "./taskTools";

/**
 * 界面下拉选的是具体模型，服务端必须把它当成硬约束：agent 传的 provider 不能
 * 把它顶掉，模型 ID 也要原样落到供应商请求里。
 */

const root = await mkdtemp(join(tmpdir(), "chatspace-task-tools-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const realFetch = globalThis.fetch;

const tripoBodies: Record<string, unknown>[] = [];
const arkBodies: Record<string, unknown>[] = [];
const worldBodies: Record<string, unknown>[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假方舟：Seed3D 与影眸/数美共用提交路径，按模型 ID 分流记录。 */
function installFakeFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/files/upload-credentials")) return jsonResponse({ code: 0, data: {
      s3_host: "s3.fake", sts_ak: "ak", sts_sk: "sk", session_token: "st",
      resource_bucket: "tripo-data", resource_uri: "up/image.png", file_token: "ft-test",
    } });
    if (url.startsWith("https://s3.fake/")) return new Response(null, { status: 200 });
    if (url.endsWith("/files")) return jsonResponse({ code: 0, data: { file_token: "ft-test" } });
    if (url.endsWith("/generation/image-to-model")) {
      tripoBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ code: 0, data: { task_id: `tripo-${tripoBodies.length}` } });
    }
    if (url.endsWith("/v3/tasks/list")) {
      const ids = JSON.parse(String(init?.body)).task_ids as string[];
      return jsonResponse({ code: 0, data: { tasks: Object.fromEntries(ids.map(id => [id, {
        status: "success", output: { pbr_model: "https://cdn.fake/model.glb" },
      }])), missed: [] } });
    }
    if (url.endsWith("/contents/generations/tasks") && init?.method === "POST") {
      arkBodies.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ id: `ark-${arkBodies.length}` });
    }
    if (url.includes("/contents/generations/tasks/")) {
      return jsonResponse({
        id: "ark-1",
        status: "succeeded",
        content: { file_url: "https://cdn.fake/model.glb" },
      });
    }
    if (url.endsWith("/worlds:generate") && init?.method === "POST") {
      worldBodies.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ operation_id: `world-${worldBodies.length}`, done: true, response: {} });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  setAssetStorage(storage);
  installFakeFetch();
  await createProject(storage, { name: "任务工具", slug: "tt" });
  const image = `${projectSourceDir("tt")}/0-ref.png`;
  await storage.writeBytes(image, PNG_BYTES);
  await writeJson(storage, projectCandidatesFile("tt"), CandidateRegistrySchema, {
    schemaVersion: 1,
    objects: [{ slug: "lamp", name: "台灯", description: "暖光台灯", sourceImages: [image] }],
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAssetStorage(undefined);
  clearTasks();
  await rm(root, { recursive: true, force: true });
});

/** 后台任务是 fire-and-forget，等它结算，避免断言跑在提交之前。 */
async function waitForSettle(taskId: string, projectSlug = "tt") {
  for (let i = 0; i < 200; i++) {
    const task = await getTask(projectSlug, taskId);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未在预期时间内结算：${taskId}`);
}

async function runBatch(threeDModel: string | undefined, provider: string) {
  const result = await start3dBatchTool.execute!(
    { provider, tripoGenerationMode: "auto" } as never,
    {
      requestContext: buildRequestContext({
        projectSlug: "tt",
        ...(threeDModel ? { threeDModel: threeDModel as never } : {}),
        volcengineApiKey: "sk-volc",
        tripo3dApiKey: "tsk-1",
      }),
    } as never,
  );
  const taskId = (result as { tasks: { id: string }[] }).tasks[0]!.id;
  return waitForSettle(taskId);
}

describe("start-3d-batch 的 3D 模型选择", () => {
  test("Auto 走 Seed3D 2.0：模型 ID 与细分档都进请求体", async () => {
    tripoBodies.length = 0; arkBodies.length = 0;
    const task = await runBatch(undefined, "seed3d-direct");
    expect(task.status).toBe("succeeded");
    expect(arkBodies[0]).toMatchObject({ model: SEED3D_MODEL });
    expect(JSON.stringify(arkBodies[0]!.content)).toContain("--subdivisionlevel medium");
    expect(tripoBodies).toHaveLength(0);
  });

  test("选中 Hyper3D 时提交它自己的模型 ID", async () => {
    tripoBodies.length = 0; arkBodies.length = 0;
    const task = await runBatch("hyper3d-gen2", "hyper3d-volc");
    expect(task.status).toBe("succeeded");
    expect(arkBodies[0]).toMatchObject({ model: config.ark3d.hyper3dModel });
    expect(tripoBodies).toHaveLength(0);
  });

  test("界面上残留的 Tripo 选择回退到 Seed3D，不再打 Tripo", async () => {
    tripoBodies.length = 0; arkBodies.length = 0;
    const task = await runBatch("tripo-p1", "tripo-direct");
    expect(task.status).toBe("succeeded");
    expect(tripoBodies).toHaveLength(0);
    expect(arkBodies[0]).toMatchObject({ model: SEED3D_MODEL });
  });

  test("缺 VOLC_KEY 时在提交前就拒绝", async () => {
    arkBodies.length = 0;
    await expect(
      start3dBatchTool.execute!(
        { provider: "seed3d-direct", tripoGenerationMode: "auto" } as never,
        { requestContext: buildRequestContext({ projectSlug: "tt" }) } as never,
      ),
    ).rejects.toThrow(/VOLC_KEY/);
    expect(arkBodies).toHaveLength(0);
  });
});

describe("start-world-task 的图片来源", () => {
  test("兼容旧模型的 __OMIT__ 占位符，并按最新源图生成", async () => {
    worldBodies.length = 0;
    const result = await startWorldTaskTool.execute!(
      { mode: "direct", sourceImage: "__OMIT__", prompt: "森林空地" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "tt",
          worldLabsApiKey: "wlt-test",
        }),
      } as never,
    );
    const taskId = (result as { task: { id: string } }).task.id;
    const task = await waitForSettle(taskId);

    expect(task.status).toBe("succeeded");
    expect(worldBodies[0]?.world_prompt).toMatchObject({
      type: "image",
      text_prompt: "森林空地",
    });
    const sidecar = await readJson(
      storage,
      "projects/tt/assets/world/.0-world-request.json",
      RequestSidecarSchema,
    );
    expect(sidecar.params.image).toBe("projects/tt/source/0-ref.png");
  });

  test("三种来源模式会归一化成明确的服务层参数", () => {
    expect(resolveWorldSourceImage({ sourceMode: "latest", sourceImage: "__OMIT__" })).toBeUndefined();
    expect(resolveWorldSourceImage({ sourceMode: "text-only", sourceImage: "__OMIT__" })).toBeNull();
    expect(resolveWorldSourceImage({
      sourceMode: "explicit-path",
      sourceImage: "projects/tt/source/0-ref.png",
    })).toBe("projects/tt/source/0-ref.png");
    expect(() => resolveWorldSourceImage({
      sourceMode: "explicit-path",
      sourceImage: "__OMIT__",
    })).toThrow("requires a real sourceImage logical path");
  });
});

/**
 * 用户口径（2026-10-02）：**上一轮会话生成的参考图不许自动复用，但看得见；想复用
 * 必须先问过用户。** 这条闸门必须在 Agent 工具入口就拦下来：任务一旦启动就返回 id，
 * 失败只会沉在任务列表里，Agent 当场看不到、也就不会去问用户。
 */
describe("参考图跨会话复用的闸门", () => {
  const SESSION_START = Date.parse("2026-10-02T12:00:00.000Z");

  /** 造一个"待生成对象引用的图是上一轮生成的"现场。 */
  async function legacyReferenceProject(slug: string) {
    await createProject(storage, { name: slug, slug });
    const sourceDir = projectSourceDir(slug);
    const image = `${sourceDir}/0-old-ref.png`;
    await storage.writeBytes(image, PNG_BYTES);
    await writeJson(storage, `${sourceDir}/.0-old-ref-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 0,
      slug: "old-ref",
      provider: "volcengine",
      model: "seedream",
      params: { prompt: "旧参考图", count: 1 },
      status: "succeeded",
      outputs: [{ path: image }],
      createdAt: new Date(SESSION_START - 3_600_000).toISOString(),
      updatedAt: new Date(SESSION_START - 3_600_000).toISOString(),
    });
    await writeJson(storage, projectCandidatesFile(slug), CandidateRegistrySchema, {
      schemaVersion: 1,
      objects: [
        {
          slug: "chair",
          name: "椅子",
          description: "上一轮的椅子",
          sourceImages: [],
          createdAt: new Date(SESSION_START - 3_600_000).toISOString(),
        },
      ],
      updatedAt: new Date(SESSION_START - 3_600_000).toISOString(),
    });
    return image;
  }

  test("没有显式传图、兜底会拿到旧参考图：当场报错，并让 Agent 去征求同意", async () => {
    const image = await legacyReferenceProject("gate-block");
    tripoBodies.length = 0;

    const error = await start3dBatchTool.execute!(
      { provider: "tripo-direct", tripoGenerationMode: "auto" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-block",
          sessionStartedAt: SESSION_START,
          volcengineApiKey: "sk-volc",
          tripo3dApiKey: "tsk-1",
        }),
      } as never,
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "reference_reuse_needs_consent", status: 409 });
    // 一次付费请求都不许发出去
    expect(tripoBodies).toHaveLength(0);
    // 报错必须可执行：说清是哪张图、并明确要求先用 ask-user 征求同意
    expect((error as Error).message).toContain(image);
    expect((error as Error).message).toContain("ask-user");
  });

  test("图是本会话刚落盘的：照旧直接开工，不打扰用户", async () => {
    const image = await legacyReferenceProject("gate-pass");
    tripoBodies.length = 0;

    const result = await start3dBatchTool.execute!(
      { provider: "tripo-direct", tripoGenerationMode: "auto" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-pass",
          // 会话开始得比这张图更早 → 图是本会话的产物
          sessionStartedAt: SESSION_START - 7_200_000,
          volcengineApiKey: "sk-volc",
          tripo3dApiKey: "tsk-1",
        }),
      } as never,
    );
    const taskId = (result as { tasks: { id: string }[] }).tasks[0]!.id;
    expect((await waitForSettle(taskId, "gate-pass")).status).toBe("succeeded");
    expect(arkBodies[0]).toBeDefined();
    expect(image).toBe("projects/gate-pass/source/0-old-ref.png");
  });

  test("客户端没带会话时间：不做本轮判断，保持原行为", async () => {
    await legacyReferenceProject("gate-legacy");
    tripoBodies.length = 0;

    const result = await start3dBatchTool.execute!(
      { provider: "tripo-direct", tripoGenerationMode: "auto" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-legacy",
          volcengineApiKey: "sk-volc",
          tripo3dApiKey: "tsk-1",
        }),
      } as never,
    );
    const taskId = (result as { tasks: { id: string }[] }).tasks[0]!.id;
    expect((await waitForSettle(taskId, "gate-legacy")).status).toBe("succeeded");
  });

  /** `sourceMode=latest` 是另一条真兜底：它按"项目最新源图"取，与具体资产无关。 */
  test("start-world-task 的 latest 兜底同样要过闸门", async () => {
    const image = await legacyReferenceProject("gate-world");
    worldBodies.length = 0;

    const error = await startWorldTaskTool.execute!(
      { mode: "direct", sourceMode: "latest", prompt: "森林空地" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-world",
          sessionStartedAt: SESSION_START,
          worldLabsApiKey: "wlt-test",
        }),
      } as never,
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "reference_reuse_needs_consent", status: 409 });
    expect(worldBodies).toHaveLength(0);
    expect((error as Error).message).toContain(image);
  });

  /**
   * 这条是补测出来的缺口：`resolve3dObjects` 会把资产绑定的 sourceImages 填进
   * `object.sourceImages`，那张图**同样可能是上一轮生成的**。早期版本按"有没有
   * sourceImages"判断，于是这种存档里的旧图被当成"已点名"直接放行了。
   */
  test("资产绑定的旧参考图（走 object.sourceImages 那条）也拦得住", async () => {
    const image = await legacyReferenceProject("gate-bound");
    // 正式资产必须真有可渲染产物，否则项目状态会把它当成"模型还没生成完"跳过
    await storage.writeBytes("projects/gate-bound/assets/bound-chair/0-bound-chair.glb", GLB_BYTES);
    // 建一个正式资产，其身份绑定上一轮生成的那张参考图
    await writeJson(
      storage,
      assetIdentityFile("gate-bound", "bound-chair"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "bound-chair",
        kind: "model",
        name: "绑旧图的椅子",
        intent: "上一轮生成过参考图但模型还没出来的椅子",
        sourceImages: [image],
        createdAt: new Date(SESSION_START - 3_600_000).toISOString(),
      },
    );
    tripoBodies.length = 0;

    const error = await start3dBatchTool.execute!(
      { provider: "tripo-direct", tripoGenerationMode: "auto", assetSlugs: ["bound-chair"] } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-bound",
          sessionStartedAt: SESSION_START,
          volcengineApiKey: "sk-volc",
          tripo3dApiKey: "tsk-1",
        }),
      } as never,
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "reference_reuse_needs_consent" });
    expect(tripoBodies).toHaveLength(0);
    expect((error as Error).message).toContain(image);
  });

  test("text-only 不用图，不受闸门影响", async () => {
    await legacyReferenceProject("gate-world-text");
    worldBodies.length = 0;

    const result = await startWorldTaskTool.execute!(
      { mode: "direct", sourceMode: "text-only", prompt: "森林空地" } as never,
      {
        requestContext: buildRequestContext({
          projectSlug: "gate-world-text",
          sessionStartedAt: SESSION_START,
          worldLabsApiKey: "wlt-test",
        }),
      } as never,
    );
    const taskId = (result as { task: { id: string } }).task.id;
    expect((await waitForSettle(taskId, "gate-world-text")).status).toBe("succeeded");
  });
});
