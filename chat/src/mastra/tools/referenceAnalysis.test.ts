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
import { CandidateRegistrySchema, RequestSidecarSchema, SlugSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
} from "../../services/assetStorage";
import { clearTasks, getTask } from "../../services/tasks";
import { buildRequestContext } from "../../services/workflowRuns";
import { oneShotSceneWorkflow, runOneShotWorkflow } from "../workflows/oneShot";
import { createProject } from "./projectTools";
import {
  analyzeReferenceTool,
  runAnalyzeReference,
  runConfirmReferenceAssets,
} from "./referenceAnalysis";

const root = await mkdtemp(join(tmpdir(), "chatspace-oneshot-tool-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const realFetch = globalThis.fetch;
const requests: { world: Record<string, unknown>[]; seed3d: Record<string, unknown>[] } = {
  world: [], seed3d: [],
};
const events: string[] = [];
let failNextSeed3d = false;
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

/** 假 World Labs 和 Seed3D 接口及 CDN */
function installFakeFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cdn.fake/model.glb") {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/contents/generations/tasks") && init?.method === "POST") {
      events.push("seed3d");
      requests.seed3d.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      if (failNextSeed3d) {
        failNextSeed3d = false;
        return jsonResponse({ error: "temporary failure" }, 503);
      }
      return jsonResponse({ id: `seed-${requests.seed3d.length}` });
    }
    if (url.includes("/contents/generations/tasks/")) {
      return jsonResponse({ status: "succeeded", file_url: "https://cdn.fake/model.glb" });
    }
    if (url.endsWith("/images/generations")) {
      events.push("image-edit");
      return jsonResponse({ data: [{ url: "https://cdn.fake/out.png" }] });
    }
    if (url.endsWith("/worlds:generate")) {
      events.push("world");
      requests.world.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({
        operation_id: "op-tool",
        done: true,
        response: {
          assets: { mesh: { collider_mesh_url: "https://cdn.fake/world.glb" } },
        },
      });
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

async function startSceneWorkflow(
  projectSlug: string,
  input: { runId: string; selectedSlugs?: string[] },
) {
  const run = await oneShotSceneWorkflow.createRun();
  const result = await run.start({
    inputData: input,
    requestContext: buildRequestContext({ projectSlug, ...KEYS }),
  });
  if (result.status !== "success") throw new Error(`启动 Workflow 失败：${result.status}`);
  return result.result;
}

describe("analyze-reference / 场景确认服务", () => {
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

  test("跨轮次确认：只有一份待确认分析时可省略 runId", async () => {
    await createProject(storage, { name: "跨轮次项目", slug: "follow-up" });
    const image = `${projectSourceDir("follow-up")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    await runAnalyzeReference("follow-up", { image, analysis: GARAGE_ANALYSIS });

    const confirmed = await runConfirmReferenceAssets("follow-up", {});
    expect(confirmed.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    expect(await storage.exists(`${projectDir("follow-up")}/analysis.json`)).toBe(true);
  });

  test("跨轮次确认：多份待确认分析时必须指定 runId", async () => {
    await createProject(storage, { name: "多图项目", slug: "multiple-pending" });
    const image = `${projectSourceDir("multiple-pending")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const first = await runAnalyzeReference("multiple-pending", { image, analysis: GARAGE_ANALYSIS });
    const second = await runAnalyzeReference("multiple-pending", { image, analysis: GARAGE_ANALYSIS });

    await expect(runConfirmReferenceAssets("multiple-pending", {})).rejects.toThrow("请指定 runId");
    await runConfirmReferenceAssets("multiple-pending", { runId: second.runId });
    expect(await storage.exists(`${projectDir("multiple-pending")}/.analyze-reference-${first.runId}.json`)).toBe(true);
  });

  test("同一 runId 重复确认时复用结果，支持 Workflow 失败后重跑", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    const first = await runConfirmReferenceAssets("ost", { runId: started.runId });
    const repeated = await runConfirmReferenceAssets("ost", { runId: started.runId });
    expect(repeated).toEqual(first);
  });

  test("找不到 run 时报错", () => {
    expect(
      runConfirmReferenceAssets("ost", { runId: "gone" }),
    ).rejects.toThrow("重新调用 analyze-reference");
  });
});

describe("one-shot-scene Workflow（确认后逐阶段完成并落盘）", () => {
  test("没有参考图分析时报错，指引先跑 analyze-reference", () => {
    expect(runOneShotWorkflow("no-analysis-yet", KEYS)).rejects.toThrow(
      "先用 analyze-reference",
    );
  });

  test("确认对象后：独立参考图 → 底板 → 世界 → 单物体模型", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    await runConfirmReferenceAssets("ost", { runId: started.runId });

    events.length = 0;
    const completed = await runOneShotWorkflow("ost", KEYS);
    expect(completed.references).toHaveLength(1);
    expect(completed.references[0]?.image).toContain(`${completed.references[0]?.slug}-ref`);
    expect(completed.plate).toContain("plate.png");
    expect(completed.worldJson).toContain("world.json");
    expect(completed.models[0]?.slug).toBe(completed.references[0]?.slug);
    expect(await storage.exists(completed.models[0]!.files[0]!)).toBe(true);
    expect(events).toEqual(["image-edit", "image-edit", "world", "seed3d"]);
    const worldPrompt = requests.world.at(-1)?.world_prompt as Record<string, unknown>;
    expect(worldPrompt.type).toBe("image");
    const worldDir = completed.worldJson.slice(0, completed.worldJson.lastIndexOf("/"));
    const worldSidecarName = (await storage.list(worldDir)).find((name) => name.endsWith("request.json"))!;
    const worldSidecar = await readJson(storage, `${worldDir}/${worldSidecarName}`, RequestSidecarSchema);
    expect(worldSidecar.params.image).toBe(completed.plate);
    const modelDir = assetDir("ost", completed.models[0]!.slug);
    const modelSidecarName = (await storage.list(modelDir)).find((name) => name.endsWith("request.json"))!;
    const modelSidecar = await readJson(storage, `${modelDir}/${modelSidecarName}`, RequestSidecarSchema);
    expect(modelSidecar.params.image).toBe(completed.references[0]?.image);
    expect(requests.seed3d).toHaveLength(1);

    const repeated = await runOneShotWorkflow("ost", KEYS);
    expect(repeated).toEqual(completed);
    expect(events).toEqual(["image-edit", "image-edit", "world", "seed3d"]);
  }, 20000);

  test("缺少生成 key 时在任何付费步骤前失败", async () => {
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

    await expect(runOneShotWorkflow("no-keys", { llm: { apiKey: "sk-llm" } })).rejects.toThrow("VOLC_KEY");
    expect(await storage.exists(`${projectSourceDir("no-keys")}/1-plate.png`)).toBe(false);
  });

  test("模型阶段失败后重跑，只重试失败阶段", async () => {
    await createProject(storage, { name: "模型重试", slug: "model-retry" });
    const image = `${projectSourceDir("model-retry")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const analyzed = await runAnalyzeReference("model-retry", { image, analysis: GARAGE_ANALYSIS });
    await runConfirmReferenceAssets("model-retry", { runId: analyzed.runId });

    events.length = 0;
    failNextSeed3d = true;
    await expect(runOneShotWorkflow("model-retry", KEYS)).rejects.toThrow("generate-object-models");
    expect(events).toEqual(["image-edit", "image-edit", "world", "seed3d"]);

    const completed = await runOneShotWorkflow("model-retry", KEYS);
    expect(completed.models).toHaveLength(1);
    expect(events).toEqual(["image-edit", "image-edit", "world", "seed3d", "seed3d"]);
  }, 20000);

  test("Agent Workflow 首步确认对象并返回后台任务，重复调用复用确认和运行中任务", async () => {
    await createProject(storage, { name: "完整任务", slug: "one-shot-task" });
    const image = `${projectSourceDir("one-shot-task")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const analyzed = await runAnalyzeReference("one-shot-task", {
      image,
      analysis: GARAGE_ANALYSIS,
    });
    const first = await startSceneWorkflow("one-shot-task", { runId: analyzed.runId });
    const second = await startSceneWorkflow("one-shot-task", { runId: analyzed.runId });
    expect(first.task.id).toBe(second.task.id);
    expect(first.task.status).toBe("running");
    expect(await storage.exists(`${projectDir("one-shot-task")}/analysis.json`)).toBe(true);
    expect(
      await storage.exists(`${projectDir("one-shot-task")}/.analyze-reference-${analyzed.runId}.json`),
    ).toBe(false);

    for (let attempt = 0; attempt < 30; attempt++) {
      const task = await getTask("one-shot-task", first.task.id);
      if (task?.status !== "running") {
        expect(task?.status).toBe("succeeded");
        expect((task?.result as { models?: unknown[] })?.models).toHaveLength(1);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("完整场景后台任务未完成");
  }, 20000);
});
