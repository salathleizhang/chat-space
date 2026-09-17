import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import { ProjectSchema, RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, readJson } from "../../services/assetStorage";
import { createProject, requireProject } from "./projectTools";
import { runSkyboxGeneration } from "./skyboxGen";

const root = await mkdtemp(join(tmpdir(), "chatspace-skybox-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const HDR_BYTES = new Uint8Array([0x23, 0x3f, 0x52, 0x41, 0x44, 0x49, 0x41, 0x4e, 0x43, 0x45]);

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
