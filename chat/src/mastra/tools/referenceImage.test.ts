import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { routeImageGenerateChannel } from "../../models/images";
import { LocalFileStorage, readJson, writeJson } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import {
  composeReferenceImageEditPrompt,
  composeReferenceImagePrompt,
  GenerateReferenceImagesInputSchema,
  runGenerateReferenceImages,
  runReferenceImageEdit,
  runReferenceImageGeneration,
} from "./referenceImage";

const root = await mkdtemp(join(tmpdir(), "chatspace-refimage-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假·四种渠道：fal 队列 / 方舟(OpenAI 兼容) / Gemini / OpenRouter + CDN */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith("https://cdn.fake/")) {
    return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
  }
  if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
  if (url.includes("queue.fal.run") && url.includes("/requests/")) {
    return jsonResponse({
      images: [
        { url: "https://cdn.fake/ref1.png", content_type: "image/png" },
        { url: "https://cdn.fake/ref2.png", content_type: "image/png" },
      ],
    });
  }
  if (url.startsWith("https://queue.fal.run/")) {
    return jsonResponse({ request_id: "req-ref" });
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

afterAll(() => rm(root, { recursive: true, force: true }));

describe("routeImageGenerateChannel", () => {
  test("未指定渠道时原厂优先，原厂没 key 才回退聚合渠道", () => {
    expect(
      routeImageGenerateChannel("seedream", { volcengineApiKey: "vk" }).channel,
    ).toBe("volcengine");
    expect(
      routeImageGenerateChannel("seedream", {
        falApiKey: "fk",
        volcengineApiKey: "vk",
      }).channel,
    ).toBe("volcengine");
    expect(routeImageGenerateChannel("seedream", { falApiKey: "fk" }).channel).toBe("fal");
  });

  test("指定渠道但模型不支持 → 400；没 key → 401", () => {
    expect(() =>
      routeImageGenerateChannel("seedream", { falApiKey: "fk" }, "google"),
    ).toThrow("不支持");
    expect(() =>
      routeImageGenerateChannel("nano-banana", {}, "google"),
    ).toThrow("API key");
    expect(() => routeImageGenerateChannel("gpt-image-2", {})).toThrow(
      "都没有配置",
    );
  });
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
  test("旧调用不传 mode 时仍默认为文生图，edit 模式使用图生图默认模型", () => {
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
  });
});

describe("runReferenceImageGeneration", () => {
  test("fal 渠道：多张落盘 source/ 共享索引 + 侧写可续跑", async () => {
    const submittedBodies: Record<string, unknown>[] = [];
    const recordFalFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).startsWith("https://queue.fal.run/") && init?.body) {
        submittedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return fakeFetch(input);
    }) as typeof fetch;
    const result = await runReferenceImageGeneration(
      storage,
      { projectSlug: "ref-demo", prompt: "a wooden crate, white background", count: 2 },
      { falApiKey: "fk" },
      { fetchFn: recordFalFetch, pollIntervalMs: 1 },
    );
    const sourceDir = projectSourceDir("ref-demo");
    expect(result.channel).toBe("fal");
    expect(result.images).toEqual([
      `${sourceDir}/0-ref.png`,
      `${sourceDir}/0-ref-v2.png`,
    ]);
    for (const image of result.images) {
      expect(await storage.exists(image)).toBe(true);
    }
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.provider).toBe("fal");
    expect(sidecar.providerTaskId).toBe("req-ref");
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.params.canvas).toBe("landscape");
    expect(String(sidecar.params.effective_prompt)).toContain("fully visible");
    expect(submittedBodies[0]).toMatchObject({
      image_size: "landscape_4_3",
      num_images: 2,
    });
  });

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

  test("fal Nano Banana 使用 aspect_ratio，而不是其他 fal 模型的 image_size", async () => {
    const submittedBodies: Record<string, unknown>[] = [];
    const recordFalFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).startsWith("https://queue.fal.run/") && init?.body) {
        submittedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return fakeFetch(input);
    }) as typeof fetch;

    await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "ref-demo",
        prompt: "a tall floor lamp",
        model: "nano-banana",
        channel: "fal",
        canvas: "portrait",
      },
      { falApiKey: "fk" },
      { fetchFn: recordFalFetch, pollIntervalMs: 1 },
    );

    expect(submittedBodies[0]).toMatchObject({ aspect_ratio: "3:4" });
    expect(submittedBodies[0]).not.toHaveProperty("image_size");
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

  test("openrouter Seedream 专用 Image API 使用顶层 aspect_ratio", async () => {
    const bodies: Record<string, unknown>[] = [];
    const recordFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as typeof fetch;

    const result = await runReferenceImageGeneration(
      storage,
      {
        projectSlug: "ref-demo",
        prompt: "a compact stool",
        model: "seedream",
        channel: "openrouter",
        canvas: "square",
      },
      { openrouterApiKey: "ok" },
      { fetchFn: recordFetch },
    );

    expect(await storage.exists(result.images[0]!)).toBe(true);
    expect(bodies[0]).toMatchObject({ aspect_ratio: "1:1", n: 1 });
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
});

describe("runReferenceImageEdit", () => {
  test("资产不存在时报错", () => {
    expect(
      runReferenceImageEdit(
        storage,
        { projectSlug: "ref-demo", assetSlug: "nope-asset", prompt: "x" },
        { falApiKey: "fk" },
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
        { falApiKey: "fk" },
      ),
    ).rejects.toThrow("还没有参考图");
  });

  test("fal 渠道编辑：产物替换资产参考图（不覆盖旧文件）", async () => {
    // rope-coil 候选与参考图由上面 volcengine 测试建立
    const before = await readJson(
      storage,
      projectAnalysisFile("ref-demo"),
      SceneAnalysisSchema,
    );
    const originalImage = before.objects[0]!.sourceImages![0]!;

    const result = await runReferenceImageEdit(
      storage,
      { projectSlug: "ref-demo", assetSlug: "rope-coil", prompt: "make it look wet", model: "nano-banana", channel: "fal" },
      { falApiKey: "fk" },
      { fetchFn: fakeFetch, pollIntervalMs: 1 },
    );

    expect(result.channel).toBe("fal");
    expect(await storage.exists(result.image)).toBe(true);
    // 旧参考图仍在磁盘上，没被删除或覆盖
    expect(await storage.exists(originalImage)).toBe(true);
    expect(result.image).not.toBe(originalImage);

    const analysis = await readJson(
      storage,
      projectAnalysisFile("ref-demo"),
      SceneAnalysisSchema,
    );
    expect(analysis.objects[0]?.sourceImages).toEqual([result.image]);

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(String(sidecar.params.prompt)).toBe("make it look wet");
    expect(String(sidecar.params.effective_prompt)).toContain("visual source of truth");
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
});
