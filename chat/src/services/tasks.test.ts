import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectCandidatesFile,
  projectSourceDir,
  projectTaskFile,
} from "../common/libraryPaths";
import {
  AssetIdentitySchema,
  CandidateRegistrySchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
} from "../dto/library";
import { GenerationTaskSchema } from "../dto/tasks";
import { createProject, requireProject } from "../mastra/tools/projectTools";
import {
  composeEmptyWorldPrompt,
  runProjectWorldGeneration,
} from "../mastra/tools/worldGen";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
  writeJson,
} from "./assetStorage";
import {
  STALLED_TASK_TIMEOUT_MS,
  clearTasks,
  listTasks,
  resolve3dObjects,
  startCustomTask,
} from "./tasks";

const root = await mkdtemp(join(tmpdir(), "chatspace-generation-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 World Labs API + 假 CDN */
function makeFakeFetch(onWorldRequest?: (body: Record<string, unknown>) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    // CDN 产物
    if (url === "https://cdn.fake/model.glb") {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }

    // World Labs（提交即完成）
    if (url.endsWith("/worlds:generate")) {
      onWorldRequest?.(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({
        operation_id: "op-1",
        done: true,
        response: {
          assets: {
            mesh: { collider_mesh_url: "https://cdn.fake/world.glb" },
            imagery: { pano_url: "https://cdn.fake/pano.png" },
            thumbnail_url: "https://cdn.fake/thumb.webp",
            splats: { spz_urls: { full_res: "https://cdn.fake/full.spz" } },
          },
        },
      });
    }

    return jsonResponse({}, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  setAssetStorage(storage);
  globalThis.fetch = makeFakeFetch();

  await createProject(storage, { name: "生成演示", slug: "gen" });
  const sourceDir = projectSourceDir("gen");
  await storage.writeBytes(`${sourceDir}/0-photo.png`, PNG_BYTES);
  await storage.writeBytes(`${sourceDir}/1-plate.png`, PNG_BYTES);
  await writeJson(storage, projectAnalysisFile("gen"), SceneAnalysisSchema, {
    schemaVersion: 1,
    sceneName: "黄昏码头",
    sceneDescription: "木质码头延伸入海",
    environment: { lighting: "golden hour", mood: "calm" },
    objects: [
      { slug: "wooden-crate", name: "木箱", description: "旧木箱" },
      { slug: "rope-coil", name: "缆绳卷", description: "粗麻缆绳" },
    ],
    sources: [`${sourceDir}/0-photo.png`],
    analyzedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAssetStorage(undefined);
  clearTasks();
  await rm(root, { recursive: true, force: true });
});

describe("composeEmptyWorldPrompt", () => {
  test("保留环境要素并显式排除已确认对象", () => {
    const prompt = composeEmptyWorldPrompt({
      schemaVersion: 1,
      sceneName: "码头",
      sceneDescription: "木质码头延伸入海",
      environment: { lighting: "golden hour", mood: "calm" },
      objects: [
        { slug: "a", name: "木箱", description: "d" },
        { slug: "b", name: "缆绳卷", description: "d" },
      ],
      sources: [],
      analyzedAt: new Date().toISOString(),
    });
    expect(prompt).toContain("木质码头延伸入海");
    expect(prompt).toContain("golden hour");
    expect(prompt).toContain("木箱, 缆绳卷");
    expect(prompt).toContain("must not appear");
  });
});

describe("runProjectWorldGeneration", () => {
  test("全链路：空环境 prompt → World Labs → 全资产落盘", async () => {
    const result = await runProjectWorldGeneration(
      storage,
      { projectSlug: "gen", mode: "empty-environment" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch(), pollIntervalMs: 1 },
    );

    const dir = assetDir("gen", "world");
    expect(result.worldJson).toBe(`${dir}/0-world.json`);
    // glb + pano + thumbnail + spz 全部落盘
    expect(result.files).toHaveLength(4);
    for (const file of result.files) {
      expect(await storage.exists(file)).toBe(true);
    }
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.provider).toBe("world-labs");
    expect(sidecar.providerTaskId).toBe("op-1");

    // 世界资产身份 kind = world
    const identity = await readJson(
      storage,
      assetIdentityFile("gen", "world"),
      AssetIdentitySchema,
    );
    expect(identity.kind).toBe("world");
    expect((await requireProject(storage, "gen")).currentWorld).toBe("world");

    // 再生成一次不会覆盖 world，而是创建独立资产并切换当前指针
    const next = await runProjectWorldGeneration(
      storage,
      { projectSlug: "gen", mode: "empty-environment" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch(), pollIntervalMs: 1 },
    );
    expect(next.worldJson).toContain("/assets/world-2/");
    expect((await requireProject(storage, "gen")).currentWorld).toBe("world-2");
    expect(await storage.exists(dir)).toBe(true);
  });

  test("直接模式无需场景分析，使用源图和原始提示词", async () => {
    await createProject(storage, { name: "直接生成", slug: "direct-world" });
    const sourceImage = `${projectSourceDir("direct-world")}/0-photo.png`;
    await storage.writeBytes(sourceImage, PNG_BYTES);
    let request: Record<string, unknown> | undefined;

    const result = await runProjectWorldGeneration(
      storage,
      { projectSlug: "direct-world", mode: "direct", prompt: "保留图中的家具" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch((body) => { request = body; }) },
    );

    expect(result.worldJson).toContain("/assets/world/");
    expect(request?.world_prompt).toMatchObject({
      type: "image",
      text_prompt: "保留图中的家具",
    });
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params).toMatchObject({ image: sourceImage, prompt: "保留图中的家具" });
  });

  test("直接模式可指定只用文字，即使项目有源图", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await runProjectWorldGeneration(
      storage,
      { projectSlug: "direct-world", mode: "direct", sourceImage: null, prompt: "海边小镇" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch((body) => { request = body; }) },
    );
    expect(request?.world_prompt).toEqual({ type: "text", text_prompt: "海边小镇" });
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params.image).toBeUndefined();
  });

  test("空环境模式仍要求场景分析；直接模式缺少图和文字时拒绝提交", async () => {
    await createProject(storage, { name: "空项目", slug: "empty-world" });
    await expect(runProjectWorldGeneration(
      storage,
      { projectSlug: "empty-world", mode: "empty-environment" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch() },
    )).rejects.toThrow("还没有场景分析");
    await expect(runProjectWorldGeneration(
      storage,
      { projectSlug: "empty-world", mode: "direct", sourceImage: null },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch() },
    )).rejects.toThrow("需要源图或文字 prompt");
  });

  test("阶段回调按 generating → downloading 推进：进度可见，不再长时间停在 queued", async () => {
    const phases: string[] = [];
    const result = await runProjectWorldGeneration(
      storage,
      { projectSlug: "gen", mode: "empty-environment" },
      { apiKey: "wlt-key", fetchFn: makeFakeFetch(), pollIntervalMs: 1 },
      undefined,
      (phase) => {
        phases.push(phase);
      },
    );

    expect(phases).toEqual(["generating", "downloading"]);
    expect(result.files).toHaveLength(4);
  });
});

describe("并行任务服务", () => {
  test("单物体参考图登记的目标可直接解析给 3D，无需 analysis.json", async () => {
    await createProject(storage, { name: "直达模型", slug: "direct-model" });
    const image = `${projectSourceDir("direct-model")}/0-table-ref.png`;
    await storage.writeBytes(image, PNG_BYTES);
    await writeJson(
      storage,
      projectCandidatesFile("direct-model"),
      CandidateRegistrySchema,
      {
        schemaVersion: 1,
        objects: [
          {
            slug: "table",
            name: "胡桃木餐桌",
            description: "圆角胡桃木餐桌",
            sourceImages: [image],
          },
        ],
        updatedAt: new Date().toISOString(),
      },
    );

    expect(await storage.exists(projectAnalysisFile("direct-model"))).toBe(false);
    expect(await resolve3dObjects("direct-model", ["table"])).toEqual([
      {
        slug: "table",
        name: "胡桃木餐桌",
        intent: "圆角胡桃木餐桌",
        sourceImages: [image],
      },
    ]);
  });

  test("analysis 与 candidates 同时存在时合并，不会因单物体目标丢掉场景对象", async () => {
    await createProject(storage, { name: "混合目标", slug: "mixed-targets" });
    await writeJson(storage, projectAnalysisFile("mixed-targets"), SceneAnalysisSchema, {
      schemaVersion: 1,
      sceneName: "客厅",
      sceneDescription: "带沙发的客厅",
      environment: {},
      objects: [{ slug: "sofa", name: "沙发", description: "灰色沙发" }],
      sources: [],
      analyzedAt: new Date().toISOString(),
    });
    await writeJson(
      storage,
      projectCandidatesFile("mixed-targets"),
      CandidateRegistrySchema,
      {
        schemaVersion: 1,
        objects: [{ slug: "table", name: "桌子", description: "木桌" }],
        updatedAt: new Date().toISOString(),
      },
    );

    expect((await resolve3dObjects("mixed-targets")).map((object) => object.slug)).toEqual([
      "sofa",
      "table",
    ]);
  });

  test("正式资产与陈旧 analysis 同 slug 时，正式资产的参考图优先", async () => {
    await createProject(storage, { name: "编辑参考图", slug: "edited-ref" });
    const newRef = `${projectSourceDir("edited-ref")}/9-chair-new.png`;
    await storage.writeBytes(newRef, PNG_BYTES);
    // 已发布且有可见模型产物的正式资产，identity.sourceImages 已被 edit 更新为新图
    await storage.writeBytes(`${assetDir("edited-ref", "chair")}/0-chair.glb`, GLB_BYTES);
    await writeJson(storage, assetIdentityFile("edited-ref", "chair"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "chair",
      kind: "model",
      name: "椅子",
      intent: "chair",
      sourceImages: [newRef],
      createdAt: new Date().toISOString(),
    });
    // 发布后从不清理的 analysis.json 仍残留旧的场景原图
    await writeJson(storage, projectAnalysisFile("edited-ref"), SceneAnalysisSchema, {
      schemaVersion: 1,
      sceneName: "客厅",
      sceneDescription: "带椅子的客厅",
      environment: {},
      objects: [{ slug: "chair", name: "椅子", description: "旧场景图" }],
      sources: ["projects/edited-ref/source/0-scene.png"],
      analyzedAt: new Date().toISOString(),
    });

    expect(await resolve3dObjects("edited-ref", ["chair"])).toEqual([
      { slug: "chair", name: "椅子", intent: "chair", sourceImages: [newRef] },
    ]);
  });

});

describe("卡死看门狗", () => {
  /** startCustomTask 的首次落盘是异步的；读磁盘前先等文件出现 */
  async function waitForTaskFile(projectSlug: string, id: string): Promise<string> {
    const path = projectTaskFile(projectSlug, id);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await storage.exists(path)) return path;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`任务文件未落盘：${path}`);
  }

  test("静默超过预算的运行中任务被判失败，不再永远停在 running", async () => {
    await createProject(storage, { name: "卡死项目", slug: "stalled" });
    // 永不返回的 executor：任务会一直留在内存表里，模拟出网请求挂住的那个窗口
    const task = startCustomTask("3d", "stalled", "卡死的 3D 任务", () => new Promise(() => {}), {
      assetSlug: "stuck-cat",
    });
    expect(task.status).toBe("running");

    setSystemTime(new Date(Date.now() + STALLED_TASK_TIMEOUT_MS + 60_000));
    try {
      const listed = (await listTasks("stalled")).find((entry) => entry.id === task.id);
      expect(listed?.status).toBe("failed");
      expect(listed?.phase).toBe("failed");
      expect(listed?.error).toContain("没有任何进展");
      // 续跑提示必须留在错误里：否则用户会直接点重试，为同一个模型重复付费
      expect(listed?.error).toContain("resume-generation");
      // 落盘的失败状态要能被下一次读取看到
      const persisted = await readJson(
        storage,
        projectTaskFile("stalled", task.id),
        GenerationTaskSchema,
      );
      expect(persisted.status).toBe("failed");
    } finally {
      setSystemTime();
    }
  });

  test("仍在预算内的运行中任务保持 running", async () => {
    await createProject(storage, { name: "正常项目", slug: "healthy" });
    const task = startCustomTask("3d", "healthy", "正常任务", () => new Promise(() => {}));
    const listed = (await listTasks("healthy")).find((entry) => entry.id === task.id);
    expect(listed?.status).toBe("running");
  });

  test("同进程热重载（内存表被清空）不误判为服务中断", async () => {
    await createProject(storage, { name: "热重载项目", slug: "hot-reload" });
    const task = startCustomTask("3d", "hot-reload", "重载中的任务", () => new Promise(() => {}));
    await waitForTaskFile("hot-reload", task.id);

    // clearTasks 等价于 bun --hot 重建内存表：磁盘记录还在，executor 也还活着
    clearTasks();
    const listed = (await listTasks("hot-reload")).find((entry) => entry.id === task.id);
    expect(listed?.status).toBe("running");
    expect(listed?.error).toBeUndefined();
  });

  test("换了进程身份（真的重启过）才判服务中断，并提示先续跑", async () => {
    await createProject(storage, { name: "重启项目", slug: "restarted" });
    const task = startCustomTask("3d", "restarted", "重启前的任务", () => new Promise(() => {}));
    // 磁盘记录保持 running，但把进程身份改成本次之外的旧值 = 服务确实重启过
    const path = await waitForTaskFile("restarted", task.id);
    const record = await readJson(storage, path, GenerationTaskSchema);
    await writeJson(storage, path, GenerationTaskSchema, { ...record, bootId: "previous-boot" });
    clearTasks();

    const listed = (await listTasks("restarted")).find((entry) => entry.id === task.id);
    expect(listed?.status).toBe("failed");
    expect(listed?.error).toContain("resume-generation");
  });

  /**
   * 2026-10-06 本机事故的形状：`bun --hot` 重建模块后，老实例里的 executor 把终态写进了
   * 磁盘（succeeded），新实例的内存表却还停在 running——接口于是永远报"生成中"，还配上
   * `pumpActive=false`（没有任何执行者在照看它）。改之前内存表无条件盖掉磁盘，这条会红。
   */
  test("磁盘上更新的终态不会被内存里的旧快照盖住", async () => {
    await createProject(storage, { name: "旧快照项目", slug: "stale-memory" });
    const task = startCustomTask("world", "stale-memory", "世界生成", () => new Promise(() => {}), {
      assetSlug: "world",
    });
    const path = await waitForTaskFile("stale-memory", task.id);

    // 另一个模块实例写下的终态：状态是完成的，updatedAt 比内存里那份新
    const record = await readJson(storage, path, GenerationTaskSchema);
    await writeJson(storage, path, GenerationTaskSchema, {
      ...record,
      status: "succeeded",
      phase: "completed",
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const listed = (await listTasks("stale-memory")).find((entry) => entry.id === task.id);
    expect(listed?.status).toBe("succeeded");
    expect(listed?.phase).toBe("completed");

    // 内存表也要一并修好：紧接着再读一次不能又退回 running（否则只有第一次读是对的）
    const again = (await listTasks("stale-memory")).find((entry) => entry.id === task.id);
    expect(again?.status).toBe("succeeded");
  });
});
