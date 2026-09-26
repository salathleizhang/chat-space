import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { assetDir, projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { extractSeed3dFileUrls, SEED3D_MODEL } from "../../models/seed3d";
import { LocalFileStorage, readJson } from "../../services/assetStorage";
import { createProject } from "./projectTools";
import { runSeed3dImageTo3d } from "./seed3dOps";
import { landSeed3dOutputBytes } from "./seed3dOutput";

const root = await mkdtemp(join(tmpdir(), "chatspace-seed3d-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function zipBytes(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  return zip.generateAsync({ type: "uint8array" });
}

/** 假方舟：提交 → {id}；查询先 running 后 succeeded；CDN 出文件 */
function makeFakeArkFetch(succeededBody?: unknown) {
  let pollCalls = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/contents/generations/tasks")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ id: "task-77" });
    }
    if (url.includes("/contents/generations/tasks/")) {
      pollCalls += 1;
      return pollCalls < 2
        ? jsonResponse({ id: "task-77", status: "running" })
        : jsonResponse(
            succeededBody ?? {
              id: "task-77",
              status: "succeeded",
              content: { file_url: "https://cdn.fake/model.glb" },
            },
          );
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  return { fetchFn, bodies, pollCount: () => pollCalls };
}

beforeAll(async () => {
  await createProject(storage, { name: "Seed3D 演示", slug: "sd" });
  await storage.writeBytes(`${projectSourceDir("sd")}/0-photo.png`, PNG_BYTES);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("extractSeed3dFileUrls", () => {
  test("认 file_url 键——签名链接没有扩展名也要认出来", () => {
    expect(
      extractSeed3dFileUrls({
        data: { content: { file_url: "https://tos.fake/abc?sig=xyz" } },
      }),
    ).toEqual(["https://tos.fake/abc?sig=xyz"]);
  });

  test("按扩展名兜底识别 usd/usdz", () => {
    const urls = extractSeed3dFileUrls({
      outputs: ["https://cdn.fake/a.usdz", "https://cdn.fake/b.usd", "https://cdn.fake/c.txt"],
    });
    expect(urls).toEqual(["https://cdn.fake/a.usdz", "https://cdn.fake/b.usd"]);
  });

  test("同一 URL 出现在多处只落一次", () => {
    expect(
      extractSeed3dFileUrls({
        file_url: "https://cdn.fake/m.glb",
        mirror: "https://cdn.fake/m.glb",
      }),
    ).toEqual(["https://cdn.fake/m.glb"]);
  });
});

describe("runSeed3dImageTo3d", () => {
  test("提交体是方舟的 content 形状，输出规格走文本命令而非结构化字段", async () => {
    const { fetchFn, bodies } = makeFakeArkFetch();
    await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "chair", subdivisionLevel: "high", fileFormat: "glb" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );
    expect(bodies[0]).toMatchObject({
      model: SEED3D_MODEL,
      content: [
        { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
        { type: "text", text: "--subdivisionlevel high --fileformat glb" },
      ],
    });
  });

  test("显式 model 覆盖默认模型，请求体与侧写都按它提交", async () => {
    const { fetchFn, bodies } = makeFakeArkFetch();
    const result = await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "pinned", model: "doubao-seed3d-3-0-test" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );
    expect(bodies[0]).toMatchObject({ model: "doubao-seed3d-3-0-test" });
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.model).toBe("doubao-seed3d-3-0-test");
  });

  test("产物落盘 + 侧写记 provider/任务 id，轮询到 succeeded 才算成功", async () => {
    const { fetchFn, pollCount } = makeFakeArkFetch();
    const result = await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "lamp" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );
    expect(result.taskId).toBe("task-77");
    expect(pollCount()).toBe(2); // running 那轮没被当成终态
    expect(result.files).toEqual([`${assetDir("sd", "lamp")}/0-lamp.glb`]);
    expect(await storage.exists(result.files[0]!)).toBe(true);

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.provider).toBe("seed3d");
    expect(sidecar.model).toBe(SEED3D_MODEL);
    expect(sidecar.providerTaskId).toBe("task-77");
    expect(sidecar.status).toBe("succeeded");
  });

  test("没传规格时不发 text 部件——供应商自己的缺省更可靠", async () => {
    const { fetchFn, bodies } = makeFakeArkFetch();
    await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "vase" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );
    expect((bodies[0]!.content as unknown[]).length).toBe(1);
  });

  test("没有扩展名的 file_url 按 glb 落盘（Seed3D 默认产物格式）", async () => {
    const { fetchFn } = makeFakeArkFetch({
      status: "succeeded",
      file_url: "https://cdn.fake/signed?token=1",
    });
    const result = await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "rock" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );
    expect(result.files[0]).toEndWith("0-rock.glb");
  });

  test("Seed3D 返回 ZIP 时提取 PBR GLB，侧写记录可渲染产物而不是压缩包", async () => {
    const archive = await zipBytes({ "pbr/mesh_textured_pbr.glb": GLB_BYTES });
    const base = makeFakeArkFetch({
      status: "succeeded",
      file_url: "https://cdn.fake/model.zip",
    });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://cdn.fake/model.zip") {
        return new Response(archive.buffer.slice(0), { status: 200 });
      }
      return base.fetchFn(input, init);
    }) as typeof fetch;

    const result = await runSeed3dImageTo3d(
      storage,
      { projectSlug: "sd", assetSlug: "zip-chair" },
      { apiKey: "ak", fetchFn, pollIntervalMs: 1 },
    );

    expect(result.files).toEqual([`${assetDir("sd", "zip-chair")}/0-zip-chair.glb`]);
    expect(await storage.readBytes(result.files[0]!)).toEqual(GLB_BYTES);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.outputs[0]?.path).toBe(result.files[0]);
    expect(sidecar.outputs[0]?.providerUrl).toEndWith("model.zip");
  });

  test("ZIP 内部路径不参与落盘，且没有模型时明确失败", async () => {
    const archive = await zipBytes({ "../../notes.txt": new TextEncoder().encode("no model") });
    await expect(
      landSeed3dOutputBytes(storage, archive, {
        basePath: `${assetDir("sd", "safe")}/0-safe`,
      }),
    ).rejects.toThrow("没有可用模型文件");
    expect(await storage.exists("notes.txt")).toBe(false);
  });

  test("伪装成 GLB 的损坏下载不能被标记为成功", async () => {
    await expect(
      landSeed3dOutputBytes(storage, new Uint8Array([1, 2, 3, 4]), {
        basePath: `${assetDir("sd", "invalid")}/0-invalid`,
        fallbackExtension: "glb",
      }),
    ).rejects.toThrow("glTF 文件头");
    expect(await storage.exists(`${assetDir("sd", "invalid")}/0-invalid.glb`)).toBe(false);
  });

  test("任务失败时侧写记 failed 并带出错误信息", async () => {
    const failFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/contents/generations/tasks")) return jsonResponse({ id: "task-x" });
      return jsonResponse({ status: "failed", error: { message: "内容审核不通过" } });
    }) as typeof fetch;
    await expect(
      runSeed3dImageTo3d(
        storage,
        { projectSlug: "sd", assetSlug: "bad" },
        { apiKey: "ak", fetchFn: failFetch, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("内容审核不通过");

    // 侧写要留在磁盘上供续跑/排查，不能因为失败就不落
    const sidecar = await readJson(
      storage,
      `${assetDir("sd", "bad")}/.0-bad-request.json`,
      RequestSidecarSchema,
    );
    expect(sidecar.status).toBe("failed");
    expect(sidecar.providerTaskId).toBe("task-x");
    expect(sidecar.error).toContain("内容审核不通过");
  });
});
