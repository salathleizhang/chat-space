import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import { AssetIdentitySchema, ProjectSchema, RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, readJson, writeJson } from "../../services/assetStorage";
import { createProject, requireProject, setCurrentSkybox } from "./projectTools";
import { fetchDefaultSkyboxDataUri, runCurrentSkyboxEdit, runSkyboxGeneration } from "./skyboxGen";

const root = await mkdtemp(join(tmpdir(), "chatspace-skybox-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const HDR_BYTES = new Uint8Array([0x23, 0x3f, 0x52, 0x41, 0x44, 0x49, 0x41, 0x4e, 0x43, 0x45]);

test("浏览器从同源静态路径读默认全景，返回原图字节而不依赖 Bun.file", async () => {
  let requested = "";
  const fetchFn = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(PNG_BYTES, { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  expect(await fetchDefaultSkyboxDataUri(fetchFn, "https://site.test/local-runtime.js"))
    .toBe(`data:image/jpeg;base64,${Buffer.from(PNG_BYTES).toString("base64")}`);
  expect(requested).toBe("https://site.test/env/sky.jpg");
});

test("默认全景路由返回 HTML 或 404 时先失败，不把错误页面当输入图提交付费生成", async () => {
  for (const response of [
    new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    new Response("missing", { status: 404 }),
  ]) {
    const fetchFn = (async () => response) as unknown as typeof fetch;
    await expect(fetchDefaultSkyboxDataUri(fetchFn, "https://site.test/local-runtime.js"))
      .rejects.toThrow("default skybox image could not be loaded");
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 Blockade Labs：生成 pending→complete，导出 pending→complete */
function makeFakeBlockadeFetch() {
  let genPolls = 0;
  let exportPolls = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://files.fake/")) {
      const bytes = url.endsWith(".hdr") ? HDR_BYTES : PNG_BYTES;
      return new Response(bytes.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/skybox")) {
      return jsonResponse({ id: 42, obfuscated_id: "obf-42", status: "pending" });
    }
    if (url.includes("/imagine/requests/")) {
      genPolls += 1;
      return jsonResponse({
        status: genPolls < 2 ? "processing" : "complete",
        file_url: "https://files.fake/pano.png",
      });
    }
    if (url.endsWith("/skybox/export")) {
      return jsonResponse({ id: 99, status: "pending" });
    }
    if (url.includes("/skybox/export/")) {
      exportPolls += 1;
      return jsonResponse({
        status: exportPolls < 2 ? "processing" : "complete",
        file_url: "https://files.fake/sky.hdr",
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  return { fetchFn };
}

beforeAll(async () => {
  await createProject(storage, { name: "天空盒演示", slug: "sb" });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("runSkyboxGeneration", () => {
  test("生成 → 导出 HDR 两段链式落盘 + 各自侧写 + 替换 currentSkybox", async () => {
    const { fetchFn } = makeFakeBlockadeFetch();
    const result = await runSkyboxGeneration(
      storage,
      { projectSlug: "sb", prompt: "a starry night sky" },
      { apiKey: "bk", fetchFn, pollIntervalMs: 1 },
    );

    const dir = assetDir("sb", "sky");
    expect(result.panoPath).toBe(`${dir}/0-sky.png`);
    expect(result.hdrPath).toBe(`${dir}/1-sky.hdr`);
    expect(await storage.exists(result.panoPath)).toBe(true);
    expect(await storage.exists(result.hdrPath)).toBe(true);

    const genSidecar = await readJson(storage, result.sidecars[0]!, RequestSidecarSchema);
    expect(genSidecar.provider).toBe("blockade-labs");
    expect(genSidecar.model).toBe("skybox/generate");
    expect(genSidecar.status).toBe("succeeded");
    expect(genSidecar.providerTaskId).toBe("obf-42");
    expect(genSidecar.params.requestId).toBe("42");

    const exportSidecar = await readJson(storage, result.sidecars[1]!, RequestSidecarSchema);
    expect(exportSidecar.provider).toBe("blockade-labs");
    expect(exportSidecar.model).toBe("skybox/export");
    expect(exportSidecar.status).toBe("succeeded");
    expect(exportSidecar.params.skyboxId).toBe("obf-42");

    const project = await requireProject(storage, "sb");
    expect(ProjectSchema.parse(project).currentSkybox).toBe("sky");
  });

  test("再次省略 slug 会创建 sky-2，并自动切为当前天空盒", async () => {
    const { fetchFn } = makeFakeBlockadeFetch();
    const result = await runSkyboxGeneration(
      storage,
      { projectSlug: "sb", prompt: "sunset sky" },
      { apiKey: "bk", fetchFn, pollIntervalMs: 1 },
    );

    expect(result.hdrPath).toContain("/assets/sky-2/");
    expect((await requireProject(storage, "sb")).currentSkybox).toBe("sky-2");
    expect(await storage.exists(assetDir("sb", "sky"))).toBe(true);
  });

  test("导出阶段失败：生成侧写保留成功状态，导出侧写标记失败，不替换 currentSkybox", async () => {
    let genPolls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://files.fake/")) {
        return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
      }
      if (url.endsWith("/skybox")) {
        return jsonResponse({ id: 7, obfuscated_id: "obf-7", status: "pending" });
      }
      if (url.includes("/imagine/requests/")) {
        genPolls += 1;
        return jsonResponse({
          status: genPolls < 2 ? "processing" : "complete",
          file_url: "https://files.fake/pano.png",
        });
      }
      if (url.endsWith("/skybox/export")) {
        return jsonResponse({ error_message: "quota exceeded" }, 500);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    await createProject(storage, { name: "失败演示", slug: "sb-fail" });
    await expect(
      runSkyboxGeneration(
        storage,
        { projectSlug: "sb-fail", prompt: "desert dunes" },
        { apiKey: "bk", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow();

    const dir = assetDir("sb-fail", "sky");
    const genSidecar = await readJson(
      storage,
      `${dir}/.0-sky-request.json`,
      RequestSidecarSchema,
    );
    expect(genSidecar.status).toBe("succeeded");
    const exportSidecar = await readJson(
      storage,
      `${dir}/.1-sky-request.json`,
      RequestSidecarSchema,
    );
    expect(exportSidecar.status).toBe("failed");

    const project = await requireProject(storage, "sb-fail");
    expect(ProjectSchema.parse(project).currentSkybox).toBeUndefined();
    expect(await storage.exists(assetIdentityFile("sb-fail", "sky"))).toBe(false);
  });

  test("全景图下载失败：生成侧写记 failed 且保留 requestId 供续跑", async () => {
    let genPolls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://files.fake/")) {
        return new Response("gone", { status: 404 });
      }
      if (url.endsWith("/skybox")) {
        return jsonResponse({ id: 11, obfuscated_id: "obf-11", status: "pending" });
      }
      if (url.includes("/imagine/requests/")) {
        genPolls += 1;
        return jsonResponse({
          status: genPolls < 2 ? "processing" : "complete",
          file_url: "https://files.fake/pano.png",
        });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    await createProject(storage, { name: "下载失败演示", slug: "sb-download" });
    await expect(
      runSkyboxGeneration(
        storage,
        { projectSlug: "sb-download", prompt: "night sky" },
        { apiKey: "bk", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow();

    const genSidecar = await readJson(
      storage,
      `${assetDir("sb-download", "sky")}/.0-sky-request.json`,
      RequestSidecarSchema,
    );
    expect(genSidecar.status).toBe("failed");
    expect(genSidecar.error).toBeTruthy();
    expect(genSidecar.providerTaskId).toBe("obf-11");
    expect(genSidecar.params.requestId).toBe("11");
  });
});

describe("runCurrentSkyboxEdit", () => {
  test("固定用 Seedream 4.5 + 4096x2048 编辑，忽略对话框所选的图片模型", async () => {
    await createProject(storage, { name: "编辑天空盒", slug: "sb-edit" });
    const dir = assetDir("sb-edit", "evening-sky");
    await writeJson(storage, assetIdentityFile("sb-edit", "evening-sky"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "evening-sky",
      kind: "skybox",
      name: "Evening sky",
      intent: "warm evening",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${dir}/0-evening-sky.png`, PNG_BYTES);
    await storage.writeBytes(`${dir}/1-evening-sky.hdr`, HDR_BYTES);
    await setCurrentSkybox(storage, "sb-edit", "evening-sky");

    let requestBody: Record<string, unknown> | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
      });
    }) as typeof fetch;

    const result = await runCurrentSkyboxEdit(
      storage,
      {
        projectSlug: "sb-edit",
        prompt: "改成有紫色极光的雪夜",
        model: "seedream-5-pro",
      },
      { volcengineApiKey: "volc-key" },
      { fetchFn },
    );

    expect(result).toMatchObject({
      skyboxSlug: "evening-sky",
      image: `${dir}/2-evening-sky.png`,
      // 回来的是**实际用了哪个模型**（4.5），不是请求里传的 5.0 Pro
      model: "seedream",
    });
    expect(await storage.exists(`${dir}/0-evening-sky.png`)).toBe(true);
    expect(await storage.exists(`${dir}/1-evening-sky.hdr`)).toBe(true);
    expect(await storage.exists(result.image)).toBe(true);
    // 5.0 系像素上限只有约 419 万（2:1 全景 ≈ 2912×1456），所以天空盒不看所选模型：
    // 钉 4.5 + 精确 4096×2048（4K，2:1 全景能拿到的上限），且不做任何后处理
    expect(requestBody?.model).toBe("doubao-seedream-4-5-251128");
    expect(requestBody?.size).toBe("4096x2048");
    expect(requestBody?.image).toBeString();
    expect(String(requestBody?.prompt)).toContain("seamless 360-degree equirectangular");
    expect(String(requestBody?.prompt)).toContain("紫色极光");

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.provider).toBe("volcengine");
    expect(sidecar.model).toBe("doubao-seedream-4-5-251128");
    // 请求侧写保留调用方原本点的模型，便于回溯"为什么不按我选的来"
    expect(sidecar.params.model).toBe("seedream-5-pro");
    expect(sidecar.params.effective_model).toBe("seedream");
    expect(sidecar.params.output_size).toBe("4096x2048");
    expect(sidecar.params.input_image).toBe(`${dir}/0-evening-sky.png`);
    expect((await requireProject(storage, "sb-edit")).currentSkybox).toBe("evening-sky");
  });

  test("没有方舟 key 时回退到所选渠道，且不硬塞方舟尺寸", async () => {
    await createProject(storage, { name: "回退天空盒", slug: "sb-fallback" });
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: Buffer.from(PNG_BYTES).toString("base64") } }],
            },
          },
        ],
      });
    }) as typeof fetch;

    const result = await runCurrentSkyboxEdit(
      storage,
      { projectSlug: "sb-fallback", prompt: "改成清晨", model: "nano-banana" },
      { googleApiKey: "google-key" },
      { fetchFn },
    );

    expect(result.model).toBe("nano-banana");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.url).toContain("gemini-3.1-flash-image");
    // Gemini 那条路本来就没有 size 字段，别把方舟的尺寸泄漏过去
    expect(bodies[0]!.body).not.toHaveProperty("size");
  });

  test("没有已生成天空盒时以内置默认图创建唯一天空盒资产", async () => {
    await createProject(storage, { name: "默认天空盒", slug: "sb-default" });
    let requestBody: Record<string, unknown> | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
      });
    }) as typeof fetch;

    const result = await runCurrentSkyboxEdit(
      storage,
      { projectSlug: "sb-default", prompt: "改成夜晚" },
      { volcengineApiKey: "volc-key" },
      { fetchFn },
    );

    expect(result.skyboxSlug).toBe("skybox");
    expect(result.image).toBe(`${assetDir("sb-default", "skybox")}/0-skybox.png`);
    expect(requestBody?.image).toBeString();
    expect(String(requestBody?.image)).toStartWith("data:image/jpeg;base64,");
    expect((await requireProject(storage, "sb-default")).currentSkybox).toBe("skybox");
    const identity = await readJson(
      storage,
      assetIdentityFile("sb-default", "skybox"),
      AssetIdentitySchema,
    );
    expect(identity.kind).toBe("skybox");
    expect(identity.name).toBe("Skybox");
  });

  test("旧项目有天空盒但没有 currentSkybox 指针时自动复用现有资产", async () => {
    await createProject(storage, { name: "旧天空盒", slug: "sb-legacy" });
    const dir = assetDir("sb-legacy", "legacy-sky");
    await writeJson(storage, assetIdentityFile("sb-legacy", "legacy-sky"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "legacy-sky",
      kind: "skybox",
      name: "Legacy sky",
      intent: "legacy",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${dir}/0-legacy-sky.png`, PNG_BYTES);
    const fetchFn = (async (_input: string | URL | Request) => jsonResponse({
      data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
    })) as typeof fetch;

    const result = await runCurrentSkyboxEdit(
      storage,
      { projectSlug: "sb-legacy", prompt: "加一点云" },
      { volcengineApiKey: "volc-key" },
      { fetchFn },
    );

    expect(result.skyboxSlug).toBe("legacy-sky");
    expect(result.image).toBe(`${dir}/1-legacy-sky.png`);
    expect((await requireProject(storage, "sb-legacy")).currentSkybox).toBe("legacy-sky");
  });

  test("现有天空盒只有 HDR 时用内置默认图作为可编辑输入，但仍写回同一资产", async () => {
    await createProject(storage, { name: "HDR 天空盒", slug: "sb-hdr-only" });
    const dir = assetDir("sb-hdr-only", "hdr-sky");
    await writeJson(storage, assetIdentityFile("sb-hdr-only", "hdr-sky"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "hdr-sky",
      kind: "skybox",
      name: "HDR sky",
      intent: "legacy HDR",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${dir}/0-hdr-sky.hdr`, HDR_BYTES);
    const defaultDataUri = `data:image/jpeg;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
    let requestBody: Record<string, unknown> | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
      });
    }) as typeof fetch;

    const result = await runCurrentSkyboxEdit(
      storage,
      { projectSlug: "sb-hdr-only", prompt: "变成清晨" },
      { volcengineApiKey: "volc-key" },
      { fetchFn, defaultImageDataUri: defaultDataUri },
    );

    expect(result.skyboxSlug).toBe("hdr-sky");
    expect(result.image).toBe(`${dir}/1-hdr-sky.png`);
    expect(requestBody?.image).toBe(defaultDataUri);
    expect((await requireProject(storage, "sb-hdr-only")).currentSkybox).toBe("hdr-sky");
  });
});
