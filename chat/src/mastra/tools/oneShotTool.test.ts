import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDir,
  projectCandidatesFile,
  projectDir,
  projectSourceDir,
} from "../../common/libraryPaths";
import { CandidateRegistrySchema, SlugSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
} from "../../services/assetStorage";
import { clearTasks } from "../../services/tasks";
import { buildRequestContext } from "../../services/workflowRuns";
import { createProject } from "./projectTools";
import {
  analyzeReferenceTool,
  runAnalyzeReference,
  runConfirmReferenceAssets,
  runRunOneShot,
} from "./oneShotTool";

const root = await mkdtemp(join(tmpdir(), "gabo-oneshot-tool-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const realFetch = globalThis.fetch;
const GARAGE_ANALYSIS = {
  sceneName: "车库",
  sceneDescription: "老旧车库内部",
  environment: { lighting: "dim" },
  observations: "有一个工具箱",
  objects: [{ slug: "toolbox", name: "工具箱", description: "红色铁皮工具箱" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 FAL（编辑 + 3D）+ 假 World Labs + 假 CDN */
function installFakeFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/images/generations")) {
      return jsonResponse({ data: [{ url: "https://cdn.fake/out.png" }] });
    }
    if (url.endsWith("/worlds:generate")) {
      return jsonResponse({
        operation_id: "op-tool",
        done: true,
        response: {
          assets: { mesh: { collider_mesh_url: "https://cdn.fake/world.glb" } },
        },
      });
    }
    if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
    if (url.includes("/requests/")) {
      return jsonResponse({
        images: [{ url: "https://cdn.fake/out.png", content_type: "image/png" }],
        model_mesh: { url: "https://cdn.fake/model.glb" },
      });
    }
    if (url.startsWith("https://queue.fal.run/")) {
      return jsonResponse({ request_id: "req-tool" });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  setAssetStorage(storage);
  installFakeFetch();
  await createProject(storage, { name: "OneShotTool", slug: "ost" });
  await storage.writeBytes(`${projectSourceDir("ost")}/0-photo.png`, PNG_BYTES);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAssetStorage(undefined);
  clearTasks();
  await rm(root, { recursive: true, force: true });
});

const KEYS = {
  llm: { apiKey: "sk-llm" },
  volcengineApiKey: "sk-volc",
  seed3dApiKey: "sk-volc",
  worldLabsApiKey: "wlt-key",
};

const OST_IMAGE = `${projectSourceDir("ost")}/0-photo.png`;

describe("analyze-reference / confirm-reference-assets", () => {
  test("真实工具入口直接接收 Creator 的视觉分析，不嵌套调用 LLM/workflow", async () => {
    const result = await analyzeReferenceTool.execute!(
      GARAGE_ANALYSIS,
      {
        requestContext: buildRequestContext({
          projectSlug: "ost",
          currentImagePaths: [OST_IMAGE],
          referenceAnalysisAllowed: true,
          ...KEYS,
        }),
      } as never,
    );

    expect(result).toMatchObject({
      title: expect.stringContaining("车库"),
      objects: [
        { slug: "toolbox", name: "工具箱", description: "红色铁皮工具箱" },
      ],
    });
  });

  test("执行层消毒非法和重复 slug，不信任模型工具参数", async () => {
    const result = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: {
        ...GARAGE_ANALYSIS,
        objects: [
          { slug: "红色 椅子", name: "红色椅子", description: "红色木椅" },
          { slug: "chair", name: "椅子 A", description: "第一把椅子" },
          { slug: "chair", name: "椅子 B", description: "第二把椅子" },
        ],
      },
    });
    expect(result.objects.every((object) => SlugSchema.safeParse(object.slug).success)).toBe(
      true,
    );
    expect(result.objects.slice(1).map((object) => object.slug)).toEqual([
      "chair",
      "chair-2",
    ]);
  });

  test("本条消息没有图片时硬拒绝，不扫描项目历史源图", () => {
    expect(
      analyzeReferenceTool.execute!(
        GARAGE_ANALYSIS,
        {
          requestContext: buildRequestContext({
            projectSlug: "ost",
            referenceAnalysisAllowed: true,
            ...KEYS,
          }),
        } as never,
      ),
    ).rejects.toThrow("本条消息没有附带图片");
  });

  test("普通附图消息即使有图片也不能启动参考图资产提取", () => {
    expect(
      analyzeReferenceTool.execute!(
        GARAGE_ANALYSIS,
        {
          requestContext: buildRequestContext({
            projectSlug: "ost",
            currentImagePaths: [OST_IMAGE],
            ...KEYS,
          }),
        } as never,
      ),
    ).rejects.toThrow("没有明确要求");
  });

  test("分析停在对象确认站 → 确认后只落候选，不点火或创建空资产", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    expect(started.objects).toEqual([
      { slug: "toolbox", name: "工具箱", description: "红色铁皮工具箱" },
    ]);
    const pendingPath = `${projectDir("ost")}/.analyze-reference-${started.runId}.json`;
    expect(await storage.exists(pendingPath)).toBe(true);

    const confirmed = await runConfirmReferenceAssets("ost", {
      runId: started.runId,
    });
    expect(confirmed.objects.map((o) => o.slug)).toEqual(["toolbox"]);
    expect(await storage.exists(pendingPath)).toBe(false);

    // 只是确认，不应该有任何生成产物落盘
    expect(await storage.exists(`${projectSourceDir("ost")}/1-plate.png`)).toBe(false);
    expect(await storage.exists(assetDir("ost", "toolbox"))).toBe(false);
    const candidates = await readJson(
      storage,
      projectCandidatesFile("ost"),
      CandidateRegistrySchema,
    );
    expect(candidates.objects[0]?.sourceImages).toEqual([OST_IMAGE]);
  });

  test("selectedSlugs 传子集：只保留选中的候选对象", async () => {
    const analysis = {
      sceneName: "客厅",
      sceneDescription: "带沙发和灯的客厅",
      environment: { lighting: "warm" },
      observations: "有沙发和灯",
      objects: [
        { slug: "sofa", name: "沙发", description: "灰色布艺沙发" },
        { slug: "lamp", name: "灯", description: "落地灯" },
      ],
    };
    await createProject(storage, { name: "客厅项目", slug: "living-room" });
    await storage.writeBytes(`${projectSourceDir("living-room")}/0-photo.png`, PNG_BYTES);

    const started = await runAnalyzeReference(
      "living-room",
      {
        image: `${projectSourceDir("living-room")}/0-photo.png`,
        analysis,
      },
    );
    expect(started.objects.map((o) => o.slug)).toEqual(["sofa", "lamp"]);

    const confirmed = await runConfirmReferenceAssets("living-room", {
      runId: started.runId,
      selectedSlugs: ["sofa"],
    });
    expect(confirmed.objects.map((o) => o.slug)).toEqual(["sofa"]);
    expect(await storage.exists(assetDir("living-room", "sofa"))).toBe(false);
    expect(await storage.exists(assetDir("living-room", "lamp"))).toBe(false);
  });

  test("runId 用过一次即失效，重复确认要求重新 analyze-reference", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    await runConfirmReferenceAssets("ost", { runId: started.runId });
    expect(
      runConfirmReferenceAssets("ost", { runId: started.runId }),
    ).rejects.toThrow("重新调用 analyze-reference");
  });

  test("找不到 run 时报错", () => {
    expect(
      runConfirmReferenceAssets("ost", { runId: "gone" }),
    ).rejects.toThrow("重新调用 analyze-reference");
  });
});

describe("run-one-shot（读已落盘的场景分析，点火 plate/world/3d，不阻塞）", () => {
  test("没有参考图分析时报错，指引先跑 analyze-reference", () => {
    expect(runRunOneShot("no-analysis-yet", KEYS)).rejects.toThrow(
      "先用 analyze-reference",
    );
  });

  test("确认对象后调用：点火底板+世界+3D，立即返回不等待收尾", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    await runConfirmReferenceAssets("ost", { runId: started.runId });

    const launched = await runRunOneShot("ost", KEYS);
    expect(launched.worldStarted).toBe(true);
    expect(launched.tasksStarted).toBe(1);
    expect(launched.plate?.output).toBe(`${projectSourceDir("ost")}/1-plate.png`);
    expect(launched.message).toContain("已启动生成");

    // 立即返回：不像 HTTP 一次性 one-shot 那样轮询到任务收尾，产物落盘是异步的
    expect(await storage.exists(`${projectSourceDir("ost")}/1-plate.png`)).toBe(true);
  }, 20000);

  test("没有配置任何生成 key 时不启动任何任务", async () => {
    const analysis = {
      sceneName: "书房",
      sceneDescription: "安静的书房",
      environment: {},
      observations: "有一本书",
      objects: [{ slug: "book", name: "书", description: "精装书" }],
    };
    await createProject(storage, { name: "无 key 项目", slug: "no-keys" });
    await storage.writeBytes(`${projectSourceDir("no-keys")}/0-photo.png`, PNG_BYTES);

    const noKeysImage = `${projectSourceDir("no-keys")}/0-photo.png`;
    const started = await runAnalyzeReference(
      "no-keys",
      { image: noKeysImage, analysis },
    );
    await runConfirmReferenceAssets("no-keys", { runId: started.runId });

    const launched = await runRunOneShot("no-keys", { llm: { apiKey: "sk-llm" } });
    expect(launched.worldStarted).toBe(false);
    expect(launched.tasksStarted).toBe(0);
    expect(launched.plateSkippedReason).toContain("未配置");
    expect(launched.message).toContain("没有启动任何任务");
  });
});
