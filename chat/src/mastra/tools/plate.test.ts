import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickLatestSourceImage } from "../../common/indexedFiles";
import { projectAnalysisFile, projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema, SceneAnalysisSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
} from "../../services/assetStorage";
import {
  composePlatePrompt,
  runLibraryImageEdit,
  runPlateGeneration,
} from "./imageEdit";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-plate-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假 Seedream 图片接口 + 产物 CDN */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/images/generations")) {
    return jsonResponse({ data: [{ url: "https://cdn.fake/plate.png" }] });
  }
  if (url === "https://cdn.fake/plate.png") {
    return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

beforeAll(async () => {
  await createProject(storage, { name: "底板演示", slug: "plate-demo" });
  const sourceDir = projectSourceDir("plate-demo");
  await storage.writeBytes(`${sourceDir}/0-photo.png`, PNG_BYTES);
  await writeJson(storage, projectAnalysisFile("plate-demo"), SceneAnalysisSchema, {
    schemaVersion: 1,
    sceneName: "黄昏码头",
    sceneDescription: "木质码头延伸入海，落日在远处",
    environment: { lighting: "golden hour", mood: "calm" },
    objects: [
      { slug: "wooden-crate", name: "木箱", description: "码头边缘的旧木箱" },
      { slug: "rope-coil", name: "缆绳卷", description: "盘起的粗麻缆绳" },
    ],
    sources: [`${sourceDir}/0-photo.png`],
    analyzedAt: new Date().toISOString(),
  });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("composePlatePrompt / pickLatestSourceImage", () => {
  test("prompt 含全部对象且只删不补", () => {
    const prompt = composePlatePrompt(
      [
        { slug: "a", name: "木箱", description: "旧木箱" },
        { slug: "b", name: "缆绳卷", description: "粗麻缆绳" },
      ],
      "保持水面倒影",
    );
    expect(prompt).toContain("木箱");
    expect(prompt).toContain("缆绳卷");
    expect(prompt).toContain("Removal only");
    expect(prompt).toContain("保持水面倒影");
  });

  test("选最高索引可见源图，忽略侧写与非图片", () => {
    expect(
      pickLatestSourceImage([
        "0-photo.png",
        "1-plate.png",
        ".1-plate-request.json",
        "note.json",
      ]),
    ).toBe("1-plate.png");
    expect(pickLatestSourceImage(["asset.json"])).toBeNull();
  });
});

describe("runPlateGeneration", () => {
  test("全链路：分析对象 → 移除 prompt → 生成落盘", async () => {
    const result = await runPlateGeneration(
      storage,
      { projectSlug: "plate-demo" },
      { volcengineApiKey: "sk-test" },
      { fetchFn: fakeFetch },
    );

    expect(result.output).toBe(`${projectSourceDir("plate-demo")}/1-plate.png`);
    expect(await storage.exists(result.output)).toBe(true);

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(String(sidecar.params.prompt)).toContain("木箱");
    expect(String(sidecar.params.prompt)).toContain("Removal only");
  });

  test("没有分析也没有显式对象时快速失败", async () => {
    await createProject(storage, { name: "空项目", slug: "empty" });
    expect(
      runPlateGeneration(
        storage,
        { projectSlug: "empty" },
        { volcengineApiKey: "sk-test" },
        { fetchFn: fakeFetch },
      ),
    ).rejects.toThrow("sourceImage and objectsToRemove");
  });

  test("独立模式：显式源图和移除对象不依赖场景分析", async () => {
    const source = `${projectSourceDir("empty")}/0-room.png`;
    await storage.writeBytes(source, PNG_BYTES);
    const result = await runPlateGeneration(
      storage,
      {
        projectSlug: "empty",
        sourceImage: source,
        objectsToRemove: [
          { slug: "chair", name: "椅子", description: "木质餐椅" },
        ],
      },
      { volcengineApiKey: "sk-test" },
      { fetchFn: fakeFetch },
    );
    expect(result.output).toBe(`${projectSourceDir("empty")}/1-plate.png`);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(String(sidecar.params.prompt)).toContain("木质餐椅");
  });
});

describe("runLibraryImageEdit 输入校验", () => {
  test("输入图不存在时在生成前失败", () => {
    expect(
      runLibraryImageEdit(
        storage,
        {
          projectSlug: "plate-demo",
          images: ["projects/plate-demo/source/999-nope.png"],
          prompt: "x",
        },
        { volcengineApiKey: "sk-test" },
        { fetchFn: fakeFetch },
      ),
    ).rejects.toThrow("Input image does not exist");
  });
});
