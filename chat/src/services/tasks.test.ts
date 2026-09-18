import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectCandidatesFile,
  projectSourceDir,
} from "../common/libraryPaths";
import {
  AssetIdentitySchema,
  CandidateRegistrySchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
} from "../dto/library";
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
import { clearTasks, listTasks, resolve3dObjects } from "./tasks";

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
