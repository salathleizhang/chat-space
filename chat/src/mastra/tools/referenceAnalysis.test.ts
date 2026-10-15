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
import { clearTasks, getTask } from "../../services/tasks";
import { readSceneJob, readSceneSpec } from "../../services/sceneJobs";
import { createAndStartSceneJob } from "../../services/sceneJobRunner";
import { buildRequestContext } from "../../services/workflowRuns";
import { createProject } from "./projectTools";
import {
  analyzeReferenceTool,
  runAnalyzeReference,
  runConfirmReferenceAssets,
} from "./referenceAnalysis";
import { startSceneJobTool } from "./sceneJobOps";

const root = await mkdtemp(join(tmpdir(), "chatspace-oneshot-tool-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const realFetch = globalThis.fetch;
const requests: { world: Record<string, unknown>[]; tripo: Record<string, unknown>[] } = {
  world: [], tripo: [],
};
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

/** 假 World Labs 和 Tripo3D 接口及 CDN */
function installFakeFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cdn.fake/model.glb") {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/files")) return jsonResponse({ code: 0, data: { file_token: "ft-test" } });
    if (url.endsWith("/generation/image-to-model")) {
      requests.tripo.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ code: 0, data: { task_id: `tripo-${requests.tripo.length}` } });
    }
    if (url.endsWith("/v3/tasks/list")) {
      const ids = JSON.parse(String(init?.body)).task_ids as string[];
      return jsonResponse({ code: 0, data: { tasks: Object.fromEntries(ids.map(id => [id, {
        status: "success", output: { pbr_model: "https://cdn.fake/model.glb" },
      }])), missed: [] } });
    }
    if (url.includes("/contents/generations/tasks")) throw new Error("Hidden 3D provider called");
    if (url.endsWith("/images/generations")) {
      return jsonResponse({ data: [{ url: "https://cdn.fake/out.png" }] });
    }
    if (url.endsWith("/worlds:generate")) {
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
  tripo3dApiKey: "tripo-fixture",
  threeDModel: "tripo-p2" as const,
  worldLabsApiKey: "wlt-key",
};

const OST_IMAGE = `${projectSourceDir("ost")}/0-photo.png`;

describe("analyze-reference / 场景确认服务", () => {
  test("真实工具入口直接接收 Creator 的视觉分析，不嵌套调用 LLM/workflow", async () => {
    const result = await analyzeReferenceTool.execute!(
      GARAGE_ANALYSIS,
      {
        requestContext: buildRequestContext({
          projectSlug: "ost",
          currentImagePaths: [OST_IMAGE],
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

  test("本条消息没有图时用本场对话里用户附过的那张（2026-10-15 事故：整条完整场景通路卡死）", async () => {
    /*
      用户先发图、下一句才说「将这个场景生成出来」时，本条消息没有图。以前
      analyze-reference 既被措辞正则裁掉、又要求"本条消息恰好一张图"，于是模型拿到
      Unknown tool，退而调 start-scene-job 又拿到 404。这里钉住可恢复的形状。
    */
    const projectSlug = "conversation-image";
    await createProject(storage, { name: "对话附图", slug: projectSlug });
    const image = `${projectSourceDir(projectSlug)}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);

    const result = await analyzeReferenceTool.execute!(
      GARAGE_ANALYSIS,
      {
        requestContext: buildRequestContext({
          projectSlug,
          conversationImagePaths: [image],
          ...KEYS,
        }),
      } as never,
    ) as { objects: { slug: string }[] };
    expect(result.objects.map((object) => object.slug)).toEqual(["toolbox"]);
  });

  test("整场对话里有多张图时要求指认，按 image 指认后照常分析", async () => {
    const projectSlug = "two-conversation-images";
    await createProject(storage, { name: "两张对话附图", slug: projectSlug });
    const first = `${projectSourceDir(projectSlug)}/0-a.png`;
    const second = `${projectSourceDir(projectSlug)}/1-b.png`;
    await storage.writeBytes(first, PNG_BYTES);
    await storage.writeBytes(second, PNG_BYTES);
    const requestContext = buildRequestContext({
      projectSlug,
      conversationImagePaths: [first, second],
      ...KEYS,
    });

    // 不指认：报错必须是"下一步该做什么"，而且列出候选，不能是死路。
    await expect(
      analyzeReferenceTool.execute!(GARAGE_ANALYSIS, { requestContext } as never),
    ).rejects.toThrow(/more than one image.*ask-user card/);

    const result = await analyzeReferenceTool.execute!(
      { ...GARAGE_ANALYSIS, image: second },
      { requestContext } as never,
    ) as { objects: { slug: string }[] };
    expect(result.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    // 指认的那张才是这次分析的依据。
    expect(await storage.exists(`${projectSourceDir(projectSlug)}/1-b.png.json`)).toBe(true);
  });

  test("一张图都没有时拒绝，且绝不扫描项目 source/ 里的旧图", async () => {
    /*
      边界是"用户在本场对话里带来的图"，不是"项目里存在的图"：source/ 里可能躺着
      上一场会话生成的参考图，归属不明，静默复用等于拿旧图开工。
    */
    const projectSlug = "stale-source-only";
    await createProject(storage, { name: "只有旧源图", slug: projectSlug });
    await storage.writeBytes(`${projectSourceDir(projectSlug)}/0-old.png`, PNG_BYTES);

    await expect(
      analyzeReferenceTool.execute!(
        GARAGE_ANALYSIS,
        {
          requestContext: buildRequestContext({ projectSlug, ...KEYS }),
        } as never,
      ),
    ).rejects.toThrow(/no image to use as a reference image.*Ask the user to attach/);
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

    await expect(runConfirmReferenceAssets("multiple-pending", {})).rejects.toThrow("specify a runId");
    await runConfirmReferenceAssets("multiple-pending", { runId: second.runId });
    expect(await storage.exists(`${projectDir("multiple-pending")}/.analyze-reference-${first.runId}.json`)).toBe(true);
  });

  test("同一 runId 重复确认时复用结果，支持 SceneJob 中断后恢复", async () => {
    const started = await runAnalyzeReference("ost", {
      image: OST_IMAGE,
      analysis: GARAGE_ANALYSIS,
    });
    const first = await runConfirmReferenceAssets("ost", { runId: started.runId });
    const repeated = await runConfirmReferenceAssets("ost", { runId: started.runId });
    expect(repeated.objects).toEqual(first.objects);
    expect(repeated.projectSlug).toBe(first.projectSlug);
    // 第二次走的是"复用已确认分析"这条路（临时 run 已被消费）：必须显式可辨，
    // 而不是伪装成一次新的确认——start-scene-job 会把它回报给 Agent。
    expect(first.reused).toBeUndefined();
    expect(repeated.reused?.runId).toBe(started.runId);
  });

  test("模型编造占位 runId 时仍能确认到唯一待确认分析（事故回归）", async () => {
    await createProject(storage, { name: "占位符项目", slug: "placeholder-run" });
    const image = `${projectSourceDir("placeholder-run")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const started = await runAnalyzeReference("placeholder-run", {
      image,
      analysis: GARAGE_ANALYSIS,
    });

    // 上下文压缩/会话重开后模型最典型的动作：补一个全零 UUID 当 runId。
    // zod 的 uuid 校验按设计接受它，所以它必须在这里被当成"没给"，而不是一次假失败。
    const confirmed = await runConfirmReferenceAssets("placeholder-run", {
      runId: "00000000-0000-0000-0000-000000000000",
    });
    expect(confirmed.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    expect(confirmed.reused).toBeUndefined();
    expect(
      await storage.exists(`${projectDir("placeholder-run")}/.analyze-reference-${started.runId}.json`),
    ).toBe(false);
  });

  test("项目已确认过场景时，完全不带 runId 也幂等复用而不是报错", async () => {
    await createProject(storage, { name: "丢号项目", slug: "lost-run-id" });
    const image = `${projectSourceDir("lost-run-id")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const started = await runAnalyzeReference("lost-run-id", {
      image,
      analysis: GARAGE_ANALYSIS,
    });
    await runConfirmReferenceAssets("lost-run-id", { runId: started.runId });

    // 新会话里模型手上什么都没有：磁盘上的 analysis.json 才是事实来源。
    const again = await runConfirmReferenceAssets("lost-run-id", {});
    expect(again.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    expect(again.reused?.runId).toBe(started.runId);

    // 编出来的（连 UUID 都不是的）runId 同样不能把这条路堵死。
    const withBogusId = await runConfirmReferenceAssets("lost-run-id", {
      runId: "not-a-uuid-at-all",
    });
    expect(withBogusId.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    expect(withBogusId.reused?.runId).toBe(started.runId);
  });

  test("多份待确认分析时按本场对话的图片解析，而不是要求模型记住 runId", async () => {
    await createProject(storage, { name: "按图消歧", slug: "by-image" });
    const imageA = `${projectSourceDir("by-image")}/0-a.png`;
    const imageB = `${projectSourceDir("by-image")}/1-b.png`;
    await storage.writeBytes(imageA, PNG_BYTES);
    await storage.writeBytes(imageB, PNG_BYTES);
    await runAnalyzeReference("by-image", { image: imageA, analysis: GARAGE_ANALYSIS });
    const second = await runAnalyzeReference("by-image", { image: imageB, analysis: GARAGE_ANALYSIS });

    // 两份都待确认、两个不同来源图：不带任何图片时必须报歧义（不许静默挑一份）。
    await expect(runConfirmReferenceAssets("by-image", {})).rejects.toThrow("specify a runId");

    // 用户在本场对话里看过哪张图，服务端自己就知道——这是可确定的信号。
    const confirmed = await runConfirmReferenceAssets(
      "by-image",
      {},
      { conversationImagePaths: [imageB] },
    );
    expect(confirmed.reused).toBeUndefined();
    expect(
      await storage.exists(`${projectDir("by-image")}/.analyze-reference-${second.runId}.json`),
    ).toBe(false);
  });

  test("上一会话遗留的待确认分析不会被本会话自动捡起来", async () => {
    await createProject(storage, { name: "跨会话遗留", slug: "stale-pending" });
    const image = `${projectSourceDir("stale-pending")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const started = await runAnalyzeReference("stale-pending", {
      image,
      analysis: GARAGE_ANALYSIS,
    });

    // 会话起点远晚于这份分析 → 它是上一会话的遗留，不能当成"本次确认"
    // （那会直接触发一轮付费生成）。没有已确认分析可复用，只能重新 analyze-reference。
    await expect(
      runConfirmReferenceAssets("stale-pending", {}, { sessionStartedAt: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow("call analyze-reference with the reference image");
    expect(
      await storage.exists(`${projectDir("stale-pending")}/.analyze-reference-${started.runId}.json`),
    ).toBe(true);

    // 会话判断只是"能不能自动捡"，不是权限：显式指定 runId 仍然放行。
    const explicit = await runConfirmReferenceAssets(
      "stale-pending",
      { runId: started.runId },
      { sessionStartedAt: Number.MAX_SAFE_INTEGER },
    );
    expect(explicit.objects.map((object) => object.slug)).toEqual(["toolbox"]);
  });

  test("有会话起点时，本会话新分析出来的那一份可以直接确认（epoch 0 也是合法值）", async () => {
    await createProject(storage, { name: "本会话分析", slug: "same-session" });
    const image = `${projectSourceDir("same-session")}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    await runAnalyzeReference("same-session", { image, analysis: GARAGE_ANALYSIS });

    const confirmed = await runConfirmReferenceAssets(
      "same-session",
      {},
      { sessionStartedAt: 0 },
    );
    expect(confirmed.objects.map((object) => object.slug)).toEqual(["toolbox"]);
    expect(confirmed.reused).toBeUndefined();
  });

  test("没有任何待确认分析、也没有已确认场景时，给出可执行的报错", () => {
    expect(
      runConfirmReferenceAssets("no-analysis-at-all", { runId: "gone" }),
    ).rejects.toThrow("call analyze-reference with the reference image");
  });
});

describe("SceneJob（可修订 DAG 调度）", () => {
  test("参考图/模型与底板/world 按依赖节点完成", async () => {
    const projectSlug = "scene-job-runner";
    await createProject(storage, { name: "Scene Job Runner", slug: projectSlug });
    const image = `${projectSourceDir(projectSlug)}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    const analyzed = await runAnalyzeReference(projectSlug, { image, analysis: GARAGE_ANALYSIS });
    await runConfirmReferenceAssets(projectSlug, { runId: analyzed.runId });

    const started = await createAndStartSceneJob(projectSlug, KEYS);
    for (let attempt = 0; attempt < 50; attempt++) {
      const task = await getTask(projectSlug, started.task.id);
      if (task?.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      expect(task?.status).toBe("succeeded");
      const job = await readSceneJob(storage, projectSlug, started.job.id);
      expect(job.status).toBe("succeeded");
      expect(job.tripoImageModel).toBe("P2-20260801");
      expect(requests.tripo.at(-1)?.model).toBe("P2-20260801");
      expect(job.nodes["reference:toolbox"]?.status).toBe("succeeded");
      expect(job.nodes["model:toolbox"]?.status).toBe("succeeded");
      expect(job.nodes.plate?.status).toBe("succeeded");
      expect(job.nodes.world?.status).toBe("succeeded");
      expect(job.nodes["final-review"]?.outputs.length).toBeGreaterThan(0);
      const repeated = await createAndStartSceneJob(projectSlug, KEYS);
      expect(repeated.job.id).toBe(job.id);
      expect(repeated.task.id).toBe(started.task.id);
      return;
    }
    throw new Error("SceneJob 后台任务未完成");
  }, 20000);
});

describe("start-scene-job（runId 只是消歧参数，不是钥匙）", () => {
  test("模型传全零占位 runId 时，照常按唯一待确认分析启动（事故端到端回归）", async () => {
    const projectSlug = "tool-placeholder";
    await createProject(storage, { name: "工具占位符", slug: projectSlug });
    const image = `${projectSourceDir(projectSlug)}/0-photo.png`;
    await storage.writeBytes(image, PNG_BYTES);
    await runAnalyzeReference(projectSlug, { image, analysis: GARAGE_ANALYSIS });

    const result = (await startSceneJobTool.execute!(
      { runId: "00000000-0000-0000-0000-000000000000", selectedSlugs: ["toolbox"] },
      {
        requestContext: buildRequestContext({
          projectSlug,
          currentImagePaths: [image],
          ...KEYS,
        }),
      } as never,
    )) as { job: { id: string }; reusedPreviousAnalysis?: unknown };

    expect(result.job.id).toBeTruthy();
    // 走的是新确认这条路，不是"复用已确认分析"。
    expect(result.reusedPreviousAnalysis).toBeUndefined();
    const spec = await readSceneSpec(storage, projectSlug);
    expect(spec?.objects.map((object) => object.slug)).toEqual(["toolbox"]);

    // 等后台任务收尾，别把负载留给别的测试。
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = await readSceneJob(storage, projectSlug, result.job.id);
      if (job.status === "running" || job.status === "paused" || job.status === "waiting_for_user") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      break;
    }
  }, 20000);
});
