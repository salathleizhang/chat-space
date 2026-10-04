import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectCandidatesFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  CandidateRegistrySchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
} from "../../dto/library";
import { routeImageEditChannel, routeImageGenerateChannel, runImageGenerate } from "../../models/images";
import { LocalFileStorage, readJson, setAssetStorage, writeJson } from "../../services/assetStorage";
import { resolve3dObjects } from "../../services/tasks";
import { createProject } from "./projectTools";
import {
  composeReferenceImageEditPrompt,
  composeReferenceImagePrompt,
  GenerateReferenceImagesInputSchema,
  GenerateReferenceImagesToolSchema,
  runAttachSourceImage,
  runGenerateReferenceImages,
  runReferenceImageEdit,
  runReferenceImageGeneration,
  runReferenceImageMultiview,
} from "./referenceImage";

const root = await mkdtemp(join(tmpdir(), "chatspace-refimage-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假·方舟、Gemini、OpenRouter 图片接口及 CDN */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith("https://cdn.fake/")) {
    return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
  }
  if (url.includes("ark.cn-beijing.volces.com")) {
    return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }],
          },
        },
      ],
    });
  }
  if (url.includes("openrouter.ai")) {
    return jsonResponse({
      choices: [
        {
          message: {
            images: [{ image_url: { url: `data:image/png;base64,${PNG_B64}` } }],
          },
        },
      ],
    });
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

beforeAll(async () => {
  // resolve3dObjects 走模块级 storage 单例（start-3d-batch 就是这么取图的），
  // 所以这里把全局指向同一个临时根，让"绑定 → 生成"能在同一个沙箱里端到端跑。
  setAssetStorage(storage);
  await createProject(storage, { name: "参考图演示", slug: "ref-demo" });
  await writeJson(storage, projectAnalysisFile("ref-demo"), SceneAnalysisSchema, {
    schemaVersion: 1,
    sceneName: "参考图对象",
    sceneDescription: "待生成的缆绳卷",
    environment: {},
    objects: [
      {
        slug: "rope-coil",
        name: "缆绳卷",
        description: "粗麻绳卷",
        sourceImages: [],
      },
    ],
    sources: [],
    analyzedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("routeImageGenerateChannel", () => {
  test.each([
    ["seedream", "doubao-seedream-4-5-251128"],
    ["seedream-5", "doubao-seedream-5-0-260128"],
    ["seedream-5-pro", "doubao-seedream-5-0-pro-260628"],
  ] as const)("%s 生成与编辑只能使用火山方舟", (model, volc) => {
    const keys = { volcengineApiKey: "vk", googleApiKey: "gk", openrouterApiKey: "ok" };
    expect(routeImageGenerateChannel(model, keys)).toMatchObject({
      channel: "volcengine",
      entry: { model: volc },
    });
    expect(routeImageEditChannel(model, keys)).toMatchObject({
      channel: "volcengine",
      entry: { model: volc },
    });
    expect(() => routeImageGenerateChannel(model, { googleApiKey: "gk", openrouterApiKey: "ok" }))
      .toThrow("火山方舟");
    expect(() => routeImageGenerateChannel(model, keys, "google")).toThrow("不支持");
    expect(() => routeImageGenerateChannel(model, keys, "openrouter")).toThrow("不支持");
  });

  test("指定渠道但模型不支持 → 400；没 key → 401", () => {
    expect(() =>
      routeImageGenerateChannel("seedream", { googleApiKey: "gk" }, "google"),
    ).toThrow("不支持");
    expect(() =>
      routeImageGenerateChannel("nano-banana", {}, "google"),
    ).toThrow("API key");
    expect(() => routeImageGenerateChannel("gpt-image-2", {})).toThrow(
      "都没有配置",
    );
  });
});

test("Seedream 5.0 Pro 在火山方舟逐张生成，避免发送不支持的组图参数", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse({ data: [{ url: `https://cdn.fake/${bodies.length}.png` }] });
  }) as typeof fetch;
  const route = routeImageGenerateChannel("seedream-5-pro", { volcengineApiKey: "vk" });

  const result = await runImageGenerate(route.channel, route.entry, {
    prompt: "一把木椅",
    count: 2,
    canvas: "landscape",
  }, route.apiKey, { fetchFn });

  expect(result.refs.map((ref) => ref.url)).toEqual([
    "https://cdn.fake/1.png",
    "https://cdn.fake/2.png",
  ]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({
    model: "doubao-seedream-5-0-pro-260628",
    watermark: false,
  });
  for (const body of bodies) {
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("sequential_image_generation");
  }
});

describe("composeReferenceImagePrompt", () => {
  test("保留资产描述并强制完整入镜、留白和禁止裁切", () => {
    const prompt = composeReferenceImagePrompt("a cream upholstered bed", "landscape");
    expect(prompt).toContain("a cream upholstered bed");
    expect(prompt).toContain("entire object must be fully visible");
    expect(prompt).toContain("Nothing may be cut off");
    expect(prompt).toContain("12–18% clear negative space");
    expect(prompt).toContain("landscape 4:3 canvas");
    expect(prompt).toContain("Do not use a close-up");
  });

  test("图生图提示保留用户目标，并强制忠于输入图和隔离单物体", () => {
    const prompt = composeReferenceImageEditPrompt(
      "isolate the orange sofa module on the left",
    );
    expect(prompt).toContain("orange sofa module on the left");
    expect(prompt).toContain("visual source of truth");
    expect(prompt).toContain("Isolate exactly one instance");
    expect(prompt).toContain("Remove every other object");
    expect(prompt).toContain("fully visible asset faithful to the input image");
  });
});

describe("GenerateReferenceImagesInputSchema", () => {
  test("旧调用不传 mode 时仍默认为文生图，edit 和 plate 使用图生图默认模型", () => {
    expect(GenerateReferenceImagesInputSchema.parse({ prompt: "a chair" })).toMatchObject({
      mode: "generate",
      model: "seedream",
    });
    expect(
      GenerateReferenceImagesInputSchema.parse({
        mode: "edit",
        assetSlug: "chair",
        prompt: "isolate the chair",
      }),
    ).toMatchObject({ mode: "edit", model: "seedream" });
    expect(GenerateReferenceImagesInputSchema.parse({ mode: "plate" })).toMatchObject({
      mode: "plate",
      model: "seedream",
    });
    expect(() => GenerateReferenceImagesInputSchema.parse({ mode: "generate" })).toThrow();
    expect(() => GenerateReferenceImagesInputSchema.parse({ mode: "edit", assetSlug: "chair" })).toThrow();
    expect(() => GenerateReferenceImagesInputSchema.parse({ mode: "plate", prompt: "erase chair" })).toThrow();
  });

  test("工具入参是扁平 object，三种模式分支仍由 union 校验", () => {
    const json = z.toJSONSchema(GenerateReferenceImagesToolSchema, { io: "input" }) as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, { type?: string }>;
    };
    expect(json.type).toBe("object");
    expect(json.anyOf).toBeUndefined();
    expect(json.properties?.count?.type).toBe("integer");
    expect(json.properties?.objectSlugs?.type).toBe("array");

    const flat = GenerateReferenceImagesToolSchema.parse({
      mode: "edit",
      assetSlug: "chair",
      prompt: "isolate the chair",
    });
    expect(GenerateReferenceImagesInputSchema.parse(flat)).toMatchObject({
      mode: "edit",
      assetSlug: "chair",
      model: "seedream",
    });
    const plate = GenerateReferenceImagesToolSchema.parse({ mode: "plate" });
    expect(GenerateReferenceImagesInputSchema.parse(plate)).toMatchObject({
      mode: "plate",
      model: "seedream",
    });
  });

  test("只归一化模型常见的数字字符串与字符串化数组", () => {
    expect(
      GenerateReferenceImagesToolSchema.parse({
        mode: "plate",
        count: "1",
        objectSlugs: '["red-sweater"]',
      }),
    ).toMatchObject({
      count: 1,
      objectSlugs: ["red-sweater"],
    });

    expect(() =>
      GenerateReferenceImagesToolSchema.parse({
        mode: "plate",
        count: "one",
      }),
    ).toThrow();
    expect(() =>
      GenerateReferenceImagesToolSchema.parse({
        mode: "plate",
        objectSlugs: '"red-sweater"',
      }),
    ).toThrow();
  });
});

describe("runReferenceImageGeneration", () => {

  test("volcengine 渠道（b64）+ assetSlug：参考图绑定候选但不创建资产", async () => {
    const result = await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "ref-demo",
        prompt: "rope coil, studio light",
        assetSlug: "rope-coil",
        channel: "volcengine",
      },
      { volcengineApiKey: "vk" },
      { fetchFn: fakeFetch },
    );
    expect(result.channel).toBe("volcengine");
    expect(result.images[0]).toContain("rope-coil-ref");
    const analysis = await readJson(
      storage,
      projectAnalysisFile("ref-demo"),
      SceneAnalysisSchema,
    );
    expect(analysis.objects[0]?.sourceImages).toEqual(result.images);
    expect(await storage.exists(assetIdentityFile("ref-demo", "rope-coil"))).toBe(false);
  });

  test("文生单物体参考图可直接登记 3D 目标，无需分析确认", async () => {
    await createProject(storage, { name: "单物体直达", slug: "direct-object" });
    const result = await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "direct-object",
        prompt: "a walnut dining table with rounded corners",
        assetSlug: "table",
        assetName: "胡桃木餐桌",
        assetIntent: "圆角胡桃木四人餐桌",
        channel: "volcengine",
      },
      { volcengineApiKey: "vk" },
      { fetchFn: fakeFetch },
    );

    expect(result.target).toEqual({
      assetSlug: "table",
      name: "胡桃木餐桌",
      intent: "圆角胡桃木四人餐桌",
    });
    expect(await storage.exists(assetIdentityFile("direct-object", "table"))).toBe(false);
    expect(await storage.exists(projectAnalysisFile("direct-object"))).toBe(false);
    const candidates = await readJson(
      storage,
      projectCandidatesFile("direct-object"),
      CandidateRegistrySchema,
    );
    expect(candidates.objects).toEqual([
      {
        slug: "table",
        name: "胡桃木餐桌",
        description: "圆角胡桃木四人餐桌",
        sourceImages: result.images,
        // 登记时刻：新建会话只列本会话登记的目标（旧 candidates.json 允许没有这个字段）
        createdAt: expect.any(String),
      },
    ]);
  });

  test("目标 slug 与非模型资产冲突时在图片供应商调用前失败", async () => {
    await createProject(storage, { name: "冲突预检", slug: "target-conflict" });
    await writeJson(
      storage,
      assetIdentityFile("target-conflict", "world"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "world",
        kind: "world",
        name: "已有世界",
        intent: "existing world",
        sourceImages: [],
        createdAt: new Date().toISOString(),
      },
    );
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    await expect(
      runReferenceImageGeneration(
        storage,
        {
          projectSlug: "target-conflict",
          prompt: "a table",
          assetSlug: "world",
          channel: "volcengine",
        },
        { volcengineApiKey: "vk" },
        { fetchFn: countingFetch },
      ),
    ).rejects.toThrow("已被 world 资产占用");
    expect(calls).toBe(0);
  });


  test("volcengine 渠道：张数走组图开关而非 n，且关水印", async () => {
    const bodies: Record<string, unknown>[] = [];
    const recordFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] });
    }) as typeof fetch;

    await runReferenceImageGeneration(
      storage,
      { projectSlug: "ref-demo", prompt: "x", channel: "volcengine", count: 3 },
      { volcengineApiKey: "vk" },
      { fetchFn: recordFetch },
    );
    await runReferenceImageGeneration(
      storage,
      { projectSlug: "ref-demo", prompt: "x", channel: "volcengine" },
      { volcengineApiKey: "vk" },
      { fetchFn: recordFetch },
    );

    // 方舟没有 n；多张靠 sequential_image_generation=auto + max_images 封顶
    expect(bodies[0]).toMatchObject({
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 3 },
      watermark: false,
      size: "2304x1728",
    });
    expect(bodies[0]).not.toHaveProperty("n");
    // 单张不必开组图（默认 disabled），但水印照样要关
    expect(bodies[1]).not.toHaveProperty("sequential_image_generation");
    expect(bodies[1]).toMatchObject({ watermark: false, size: "2304x1728" });
  });

  test("volcengine 组图单张失败（200 + data[].error）报出错误码", async () => {
    const sensitiveFetch = (async () =>
      jsonResponse({
        data: [{ error: { code: "OutputImageSensitiveContentDetected", message: "boom" } }],
      })) as unknown as typeof fetch;
    expect(
      runReferenceImageGeneration(
        storage,
        { projectSlug: "ref-demo", prompt: "x", channel: "volcengine" },
        { volcengineApiKey: "vk" },
        { fetchFn: sensitiveFetch },
      ),
    ).rejects.toThrow("OutputImageSensitiveContentDetected");
  });

  test("openai 渠道：仍用 n 传张数", async () => {
    const bodies: Record<string, unknown>[] = [];
    const recordFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as typeof fetch;

    await runReferenceImageGeneration(
      storage,
      { projectSlug: "ref-demo", prompt: "x", model: "gpt-image-2", channel: "openai", count: 2 },
      { openaiApiKey: "ok" },
      { fetchFn: recordFetch },
    );
    expect(bodies[0]).toMatchObject({ n: 2, size: "1536x1024" });
    expect(bodies[0]).not.toHaveProperty("sequential_image_generation");
  });

  test("google 与 openrouter 渠道：画幅参数透传，inlineData / data URL 都能落盘", async () => {
    const bodies: Record<string, Record<string, unknown>> = {};
    const recordFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (init?.body) {
        if (url.includes("generativelanguage.googleapis.com")) {
          bodies.google = JSON.parse(String(init.body)) as Record<string, unknown>;
        } else if (url.includes("openrouter.ai")) {
          bodies.openrouter = JSON.parse(String(init.body)) as Record<string, unknown>;
        }
      }
      return fakeFetch(input);
    }) as typeof fetch;
    const viaGoogle = await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "ref-demo",
        prompt: "x",
        model: "nano-banana",
        channel: "google",
        canvas: "portrait",
      },
      { googleApiKey: "gk" },
      { fetchFn: recordFetch },
    );
    expect(await storage.exists(viaGoogle.images[0]!)).toBe(true);

    const viaOpenRouter = await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "ref-demo",
        prompt: "x",
        model: "nano-banana",
        channel: "openrouter",
      },
      { openrouterApiKey: "ok" },
      { fetchFn: recordFetch },
    );
    expect(await storage.exists(viaOpenRouter.images[0]!)).toBe(true);
    expect(bodies.google).toMatchObject({
      generationConfig: {
        responseFormat: { image: { aspectRatio: "3:4" } },
      },
    });
    expect(bodies.openrouter).toMatchObject({
      image_config: { aspect_ratio: "4:3" },
    });
  });

  test("失败时侧写记 failed", async () => {
    const failFetch = (async () =>
      jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    expect(
      runReferenceImageGeneration(
        storage,
        { projectSlug: "ref-demo", prompt: "x", channel: "volcengine" },
        { volcengineApiKey: "vk" },
        { fetchFn: failFetch },
      ),
    ).rejects.toThrow("图片生成失败");
  });

  /**
   * 回归：模型会在一轮里并发发起多张参考图，而不指定 assetSlug 时 slug 固定为
   * `ref`。旧实现是"列目录 → 取最大 +1"，三个并发调用算出同一个索引、写同一个
   * 文件，后写的静默盖掉先写的，用户只看到一张图。
   */
  test("并发文生图各自占用独立索引，不再互相覆盖", async () => {
    await createProject(storage, { name: "并发参考图", slug: "parallel-refs" });
    const results = await Promise.all(
      ["橘白猫", "黑猫", "布偶猫"].map((prompt) =>
        runReferenceImageGeneration(
          storage,
          { projectSlug: "parallel-refs", prompt, channel: "volcengine" },
          { volcengineApiKey: "vk" },
          { fetchFn: fakeFetch },
        ),
      ),
    );

    const images = results.map((result) => result.images[0]!);
    expect(new Set(images).size).toBe(3);
    for (const image of images) expect(await storage.exists(image)).toBe(true);
    // 侧写也要各占一份，否则续跑/修复会读到别人的请求参数
    expect(new Set(results.map((result) => result.sidecar)).size).toBe(3);
    for (const result of results) {
      const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
      expect(sidecar.status).toBe("succeeded");
      expect(sidecar.outputs).toEqual([
        { path: result.images[0]!, providerUrl: undefined },
      ]);
    }
  });
});

describe("runReferenceImageEdit", () => {
  test("资产不存在时报错", () => {
    expect(
      runReferenceImageEdit(
        storage,
        { projectSlug: "ref-demo", assetSlug: "nope-asset", prompt: "x" },
        { googleApiKey: "gk" },
      ),
    ).rejects.toThrow("不存在");
  });

  test("资产没有参考图时报错", async () => {
    await writeJson(storage, assetIdentityFile("ref-demo", "no-ref-asset"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "no-ref-asset",
      kind: "model",
      name: "no-ref-asset",
      intent: "x",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    expect(
      runReferenceImageEdit(
        storage,
        { projectSlug: "ref-demo", assetSlug: "no-ref-asset", prompt: "x" },
        { googleApiKey: "gk" },
      ),
    ).rejects.toThrow("还没有参考图");
  });


  test("统一 generate-reference-images 的 edit 模式走图生图并返回 images 数组", async () => {
    const sourceImage = `${projectSourceDir("ref-demo")}/scene-chair.png`;
    await storage.writeBytes(sourceImage, PNG_BYTES);
    await writeJson(
      storage,
      assetIdentityFile("ref-demo", "scene-chair"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "scene-chair",
        kind: "model",
        name: "橙色单人椅",
        intent: "场景左侧的橙色单人椅",
        sourceImages: [sourceImage],
        createdAt: new Date().toISOString(),
      },
    );

    const submittedBodies: Record<string, unknown>[] = [];
    const recordVolcFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).endsWith("/images/generations") && init?.body) {
        submittedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
      }
      return fakeFetch(input);
    }) as typeof fetch;

    const result = await runGenerateReferenceImages(
      storage,
      "ref-demo",
      {
        mode: "edit",
        assetSlug: "scene-chair",
        prompt: "isolate the orange chair on the left",
      },
      { volcengineApiKey: "vk" },
      { fetchFn: recordVolcFetch, pollIntervalMs: 1 },
    );

    expect(result).toMatchObject({ mode: "edit", channel: "volcengine" });
    expect(result.images).toHaveLength(1);
    // 参考图与 3D 是两次同意：工具结果也要带上"先让用户看图、别接着调 start-3d-batch"
    expect(result.note).toContain("不要在同一条回复里调用 start-3d-batch");
    expect(result.note).toContain("贴进对话");
    // 工作台会在图落盘后自动把 Agent 拉起来接着问：这一轮不许用正文要用户手打「继续」
    expect(result.note).toContain("自动把你拉起来继续");
    expect(result.note).toContain("回复继续");
    expect(submittedBodies[0]).toMatchObject({
      model: "doubao-seedream-4-5-251128",
      size: "2K",
      watermark: false,
      image: expect.stringContaining("data:image/png;base64,"),
    });
    expect(submittedBodies[0]).not.toHaveProperty("n");
    expect(String(submittedBodies[0]?.prompt)).toContain("Isolate exactly one instance");
    const identity = await readJson(
      storage,
      assetIdentityFile("ref-demo", "scene-chair"),
      AssetIdentitySchema,
    );
    expect(identity.sourceImages).toEqual(result.images);
  });

  test("统一 generate-reference-images 的 plate 模式读取已确认对象并返回底板图片", async () => {
    const sourceImage = `${projectSourceDir("ref-demo")}/scene-plate-input.png`;
    await storage.writeBytes(sourceImage, PNG_BYTES);
    const submittedBodies: Record<string, unknown>[] = [];
    const recordVolcFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/images/generations") && init?.body) {
        submittedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return fakeFetch(input);
    }) as typeof fetch;

    const result = await runGenerateReferenceImages(
      storage,
      "ref-demo",
      {
        mode: "plate",
        sourceImage,
        objectSlugs: ["rope-coil"],
        extraInstructions: "Keep the floor texture unchanged.",
      },
      { volcengineApiKey: "vk" },
      { fetchFn: recordVolcFetch },
    );

    expect(result.mode).toBe("plate");
    expect(result.images).toHaveLength(1);
    expect(await storage.exists(result.images[0]!)).toBe(true);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.params.role).toBe("plate");
    expect(sidecar.params.input_images).toEqual([sourceImage]);
    expect(String(sidecar.params.prompt)).toContain("缆绳卷");
    expect(String(sidecar.params.prompt)).toContain("Keep the floor texture unchanged.");
    expect(submittedBodies[0]).toMatchObject({
      image: expect.stringContaining("data:image/png;base64,"),
      prompt: expect.stringContaining("Removal only"),
    });
  });
});

describe("runReferenceImageMultiview", () => {
  test("从一张参考图生成并绑定前左后右四视图", async () => {
    await createProject(storage, { name: "多视角参考图", slug: "multiview-ref" });
    const sourceImage = `${projectSourceDir("multiview-ref")}/0-chair.png`;
    await storage.writeBytes(sourceImage, PNG_BYTES);
    await writeJson(
      storage,
      assetIdentityFile("multiview-ref", "chair"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "chair",
        kind: "model",
        name: "Chair",
        intent: "A studio chair",
        sourceImages: [sourceImage],
        createdAt: new Date().toISOString(),
      },
    );

    const calls: string[] = [];
    const tripoFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v3/files")) {
        return jsonResponse({ code: 0, data: { file_token: "file-chair" } });
      }
      if (url.endsWith("/generation/image-to-multiview")) {
        return jsonResponse({ code: 0, data: { task_id: "multi-1" } });
      }
      if (url.endsWith("/v3/tasks/list")) {
        return jsonResponse({
          code: 0,
          data: {
            tasks: {
              "multi-1": {
                status: "success",
                output: {
                  front_view_url: "https://cdn.fake/front.png",
                  left_view_url: "https://cdn.fake/left.png",
                  back_view_url: "https://cdn.fake/back.png",
                  right_view_url: "https://cdn.fake/right.png",
                },
              },
            },
            missed: [],
          },
        });
      }
      if (url.endsWith("/v3/tasks/multi-1")) {
        return jsonResponse({
          code: 0,
          data: {
            status: "success",
            output: {
              front_view_url: "https://cdn.fake/front.png",
              left_view_url: "https://cdn.fake/left.png",
              back_view_url: "https://cdn.fake/back.png",
              right_view_url: "https://cdn.fake/right.png",
            },
          },
        });
      }
      if (url.startsWith("https://cdn.fake/")) {
        return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await runReferenceImageMultiview(
      storage,
      { projectSlug: "multiview-ref", assetSlug: "chair" },
      "tsk-1",
      { fetchFn: tripoFetch, pollIntervalMs: 1 },
    );

    expect(result.images).toHaveLength(4);
    expect(Object.keys(result.referenceViews)).toEqual(["front", "left", "back", "right"]);
    for (const path of result.images) expect(await storage.exists(path)).toBe(true);
    const identity = await readJson(
      storage,
      assetIdentityFile("multiview-ref", "chair"),
      AssetIdentitySchema,
    );
    expect(identity.sourceImages).toEqual(result.images);
    expect(identity.referenceViews).toEqual(result.referenceViews);
    expect(calls.some((url) => url.endsWith("/generation/image-to-multiview"))).toBe(true);
  });
});

/**
 * 上传直连：把用户本条消息带的原图直接登记成参考图。
 *
 * 这条通路存在的理由是"参考图不必非得是生成出来的"——用户上传的照片本身就是参考图。
 * 这里钉住四件事：① 免费（不落请求侧写、不碰供应商）、② 登记后 start-3d-batch 认得出
 * 它、③ 只吃用户原图（AI 产物要回到既有那条需要用户点头的复用路径）、④ 取图来源必须
 * 可证明（默认只肯用本条消息附带的图）。
 */
describe("runAttachSourceImage", () => {
  test("本条消息的原图绑定新目标：登记候选、不产生费用，start-3d-batch 认得出它", async () => {
    await createProject(storage, { name: "上传直连", slug: "attach-demo" });
    const uploaded = `${projectSourceDir("attach-demo")}/0-photo.png`;
    await storage.writeBytes(uploaded, PNG_BYTES);

    const result = await runAttachSourceImage(
      storage,
      {
        projectSlug: "attach-demo",
        assetSlug: "ceramic-vase",
        assetName: "陶罐",
        assetIntent: "米白色陶瓷花瓶",
      },
      [uploaded],
    );

    expect(result.image).toBe(uploaded);
    expect(result.target).toEqual({
      assetSlug: "ceramic-vase",
      name: "陶罐",
      intent: "米白色陶瓷花瓶",
    });
    expect(result.note).toContain("ask-user");
    // 绝不为了绑定参考图提前创建资产身份
    expect(await storage.exists(assetIdentityFile("attach-demo", "ceramic-vase"))).toBe(false);
    // 也不落任何请求侧写：referenceResolution 就是按"有没有成功的侧写"区分
    // 用户原图与 AI 产物的，没有侧写 ⇒ 这张图跨轮次可直接复用（与既有口径一致）
    expect(
      (await storage.list(projectSourceDir("attach-demo"))).filter((name) =>
        name.endsWith("-request.json"),
      ),
    ).toEqual([]);

    const candidates = await readJson(
      storage,
      projectCandidatesFile("attach-demo"),
      CandidateRegistrySchema,
    );
    expect(candidates.objects).toEqual([
      {
        slug: "ceramic-vase",
        name: "陶罐",
        description: "米白色陶瓷花瓶",
        sourceImages: [uploaded],
        createdAt: expect.any(String),
      },
    ]);

    // 端到端：start-3d-batch 取图走的正是这份 sourceImages[0]
    const objects = await resolve3dObjects("attach-demo", ["ceramic-vase"]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.sourceImages).toEqual([uploaded]);
  });

  test("本条消息没有附图且没显式指定 → 报错而不是静默拿项目的旧图", async () => {
    await expect(
      runAttachSourceImage(storage, { projectSlug: "attach-demo", assetSlug: "solo" }, []),
    ).rejects.toThrow("没有附带图片");
  });

  test("本条消息多张图 → 要求指名，不替用户挑", async () => {
    await expect(
      runAttachSourceImage(
        storage,
        { projectSlug: "attach-demo", assetSlug: "solo" },
        ["projects/attach-demo/source/0-a.png", "projects/attach-demo/source/1-b.png"],
      ),
    ).rejects.toThrow("指名");
  });

  test("AI 生成/编辑出来的参考图不能走这条通路", async () => {
    const generated = `${projectSourceDir("attach-demo")}/1-machine-ref.png`;
    await storage.writeBytes(generated, PNG_BYTES);
    await writeJson(
      storage,
      `${projectSourceDir("attach-demo")}/.1-machine-ref-request.json`,
      RequestSidecarSchema,
      {
        schemaVersion: 1,
        index: 1,
        slug: "machine-ref",
        provider: "volcengine",
        model: "doubao-seedream-4-5-251128",
        params: { prompt: "a machine" },
        status: "succeeded",
        outputs: [{ path: generated }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );

    await expect(
      runAttachSourceImage(
        storage,
        { projectSlug: "attach-demo", assetSlug: "machine", image: generated },
        [],
      ),
    ).rejects.toThrow("只能绑定用户上传的原图");
  });

  test("显式路径必须落在本项目 source/ 内（挡住任意历史文件）", async () => {
    const outside = `${assetDir("attach-demo", "probe")}/0-photo.png`;
    await storage.writeBytes(outside, PNG_BYTES);
    await expect(
      runAttachSourceImage(
        storage,
        { projectSlug: "attach-demo", assetSlug: "probe", image: outside },
        [],
      ),
    ).rejects.toThrow("只能绑定本项目 source/");
  });

  test("不给 assetSlug 时只确认可用，并明说没有目标可被 start-3d-batch 找到", async () => {
    await createProject(storage, { name: "只确认可用", slug: "attach-unbound" });
    const uploaded = `${projectSourceDir("attach-unbound")}/0-standalone.png`;
    await storage.writeBytes(uploaded, PNG_BYTES);

    const result = await runAttachSourceImage(
      storage,
      { projectSlug: "attach-unbound" },
      [uploaded],
    );

    expect(result.image).toBe(uploaded);
    expect(result.target).toBeUndefined();
    expect(result.note).toContain("没有绑定到任何生成目标");
    // 没有任何 slug 被登记：start-3d-batch 会报 no_objects，而不是静默拿这张图开工
    expect(await storage.exists(projectCandidatesFile("attach-unbound"))).toBe(false);
  });

  test("目标已是资产：只换参考图，名字与意图照旧，回执报资产真名", async () => {
    await createProject(storage, { name: "绑定已有资产", slug: "attach-existing" });
    const uploaded = `${projectSourceDir("attach-existing")}/0-photo.png`;
    const previous = `${projectSourceDir("attach-existing")}/1-old-ref.png`;
    await storage.writeBytes(uploaded, PNG_BYTES);
    await storage.writeBytes(previous, PNG_BYTES);
    await writeJson(
      storage,
      assetIdentityFile("attach-existing", "playhouse"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        id: "keep-me",
        slug: "playhouse",
        kind: "model",
        name: "维多利亚风玩具小屋",
        intent: "照片级写实的花园玩具小屋单体模型",
        sourceImages: [previous],
        createdAt: new Date().toISOString(),
      },
    );

    const result = await runAttachSourceImage(
      storage,
      { projectSlug: "attach-existing", assetSlug: "playhouse" },
      [uploaded],
    );

    // 回执必须报资产真名，不能报按 slug 编出来的兜底名（Agent 会照着讲给用户听）
    expect(result.target).toEqual({
      assetSlug: "playhouse",
      name: "维多利亚风玩具小屋",
      intent: "照片级写实的花园玩具小屋单体模型",
    });
    const identity = await readJson(
      storage,
      assetIdentityFile("attach-existing", "playhouse"),
      AssetIdentitySchema,
    );
    // 只换参考图：稳定身份、名字、意图都原样保留
    expect(identity.id).toBe("keep-me");
    expect(identity.name).toBe("维多利亚风玩具小屋");
    expect(identity.intent).toBe("照片级写实的花园玩具小屋单体模型");
    expect(identity.sourceImages).toEqual([uploaded]);
    // 旧参考图留在磁盘上，不删（可回退）
    expect(await storage.exists(previous)).toBe(true);
  });

  test("目标 slug 与非模型资产冲突时拒绝，不悄悄改写它", async () => {
    await createProject(storage, { name: "绑定撞名", slug: "attach-conflict" });
    const uploaded = `${projectSourceDir("attach-conflict")}/0-photo.png`;
    await storage.writeBytes(uploaded, PNG_BYTES);
    await writeJson(
      storage,
      assetIdentityFile("attach-conflict", "world"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "world",
        kind: "world",
        name: "已有世界",
        intent: "existing world",
        sourceImages: [],
        createdAt: new Date().toISOString(),
      },
    );

    await expect(
      runAttachSourceImage(
        storage,
        { projectSlug: "attach-conflict", assetSlug: "world" },
        [uploaded],
      ),
    ).rejects.toThrow("已被 world 资产占用");
  });
});

/**
 * mode=edit 的新对象通路：目标还不存在时，用 sourceImage（或本条消息的图）隔离出
 * 单物体参考图，并把目标一并登记。
 */
describe("runReferenceImageEdit 的新对象通路", () => {
  test("新对象 + sourceImage：隔离结果登记为待生成目标", async () => {
    await createProject(storage, { name: "隔离新对象", slug: "edit-new" });
    const photo = `${projectSourceDir("edit-new")}/0-room.png`;
    await storage.writeBytes(photo, PNG_BYTES);

    const result = await runGenerateReferenceImages(
      storage,
      "edit-new",
      {
        mode: "edit",
        assetSlug: "floor-lamp",
        assetName: "落地灯",
        assetIntent: "房间角落的落地灯",
        prompt: "isolate the floor lamp in the corner",
        sourceImage: photo,
      },
      { volcengineApiKey: "vk" },
      { fetchFn: fakeFetch, pollIntervalMs: 1 },
    );

    expect(result).toMatchObject({ mode: "edit", channel: "volcengine" });
    expect(result.images).toHaveLength(1);
    // 新对象不该被提前建成正式资产
    expect(await storage.exists(assetIdentityFile("edit-new", "floor-lamp"))).toBe(false);
    const candidates = await readJson(
      storage,
      projectCandidatesFile("edit-new"),
      CandidateRegistrySchema,
    );
    expect(candidates.objects).toEqual([
      {
        slug: "floor-lamp",
        name: "落地灯",
        description: "房间角落的落地灯",
        sourceImages: result.images,
        createdAt: expect.any(String),
      },
    ]);
  });

  test("省略 sourceImage 时用本条消息附带的图，并把那张图当输入送给图生图", async () => {
    await createProject(storage, { name: "本条图隔离", slug: "edit-current" });
    const photo = `${projectSourceDir("edit-current")}/0-photo.png`;
    await storage.writeBytes(photo, PNG_BYTES);

    const submitted: Record<string, unknown>[] = [];
    const recordFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/images/generations") && init?.body) {
        submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
      }
      return fakeFetch(input);
    }) as typeof fetch;

    const result = await runGenerateReferenceImages(
      storage,
      "edit-current",
      { mode: "edit", assetSlug: "armchair", prompt: "isolate the armchair" },
      { volcengineApiKey: "vk" },
      { fetchFn: recordFetch, pollIntervalMs: 1 },
      [photo],
    );

    expect(submitted[0]).toMatchObject({
      image: expect.stringContaining("data:image/png;base64,"),
    });
    expect(result.images).toHaveLength(1);
  });

  test("slug 撞上非模型资产时拒绝——新通路不绕过撞名预检", async () => {
    await createProject(storage, { name: "隔离撞名", slug: "edit-conflict" });
    const photo = `${projectSourceDir("edit-conflict")}/0-photo.png`;
    await storage.writeBytes(photo, PNG_BYTES);
    await writeJson(
      storage,
      assetIdentityFile("edit-conflict", "sky"),
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "sky",
        kind: "world",
        name: "已有世界",
        intent: "existing world",
        sourceImages: [],
        createdAt: new Date().toISOString(),
      },
    );

    await expect(
      runGenerateReferenceImages(
        storage,
        "edit-conflict",
        { mode: "edit", assetSlug: "sky", prompt: "isolate the sky", sourceImage: photo },
        { volcengineApiKey: "vk" },
        { fetchFn: fakeFetch, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("已被 world 资产占用");
  });
});
