import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, readJson, writeJson } from "../../services/assetStorage";
import {
  runHunyuanImageTo3d,
  runHunyuanMotion,
  runHunyuanRetopo,
  runHunyuanUvUnwrap,
  runProfileTo3d,
} from "./hunyuanOps";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-hunyuan-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const OBJ_BYTES = new Uint8Array([0x23, 0x20, 0x6f, 0x62]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假·腾讯云 ai3d：按 X-TC-Action 分发（Submit* → JobId；Describe/Query* → DONE + ResultFile3Ds）+ CDN */
function makeFakeHunyuanFetch() {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(OBJ_BYTES.buffer.slice(0), { status: 200 });
    }
    const headers = init?.headers as Record<string, string>;
    const action = headers["X-TC-Action"] ?? "";
    calls.push({ action, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (action.startsWith("Submit")) {
      return jsonResponse({ Response: { JobId: "job-7", RequestId: "r" } });
    }
    return jsonResponse({
      Response: {
        Status: "DONE",
        ResultFile3Ds: [
          { Type: "GLB", Url: "https://cdn.fake/out.glb" },
          { Type: "PREVIEW", Url: "https://cdn.fake/preview.png" },
        ],
        RequestId: "r",
      },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

beforeAll(async () => {
  await createProject(storage, { name: "混元演示", slug: "hy" });
  await storage.writeBytes(`${projectSourceDir("hy")}/0-photo.png`, PNG_BYTES);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("runHunyuanImageTo3d", () => {
  test("Base64 提交 → DONE → ResultFile3Ds 落盘 + 侧写", async () => {
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    const result = await runHunyuanImageTo3d(
      storage,
      { projectSlug: "hy", assetSlug: "crate" },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );
    expect(calls[0]?.action).toBe("SubmitHunyuanTo3DProJob");
    expect(typeof calls[0]?.body.ImageBase64).toBe("string");
    expect(result.jobId).toBe("job-7");
    expect(result.files).toHaveLength(2);
    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.provider).toBe("hunyuan");
    expect(sidecar.status).toBe("succeeded");
  });

  test("key 格式错误快速失败", () => {
    expect(
      runHunyuanImageTo3d(
        storage,
        { projectSlug: "hy", assetSlug: "crate2" },
        { apiKey: "no-colon", fetchFn: makeFakeHunyuanFetch().fetchFn },
      ),
    ).rejects.toThrow("SecretId:SecretKey");
  });
});

describe("runProfileTo3d / runHunyuanUvUnwrap", () => {
  test("人物生成：Profile.Base64 + Template", async () => {
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    const result = await runProfileTo3d(
      storage,
      { projectSlug: "hy", assetSlug: "hero", template: "basketball" },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );
    const submit = calls.find((c) => c.action === "SubmitProfileTo3DJob");
    expect((submit?.body.Profile as { Base64: string }).Base64.length).toBeGreaterThan(0);
    expect(submit?.body.Template).toBe("basketball");
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("UV 展开：取侧写 providerUrl 作 InputFile3D；无 URL 报错", async () => {
    // crate 资产上一测试已有带 providerUrl 的侧写（out.glb）
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    const result = await runHunyuanUvUnwrap(
      storage,
      { projectSlug: "hy", assetSlug: "crate" },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );
    const submit = calls.find((c) => c.action === "SubmitHunyuanTo3DUVJob");
    expect((submit?.body.File as { Url: string }).Url).toBe("https://cdn.fake/out.glb");
    expect((submit?.body.File as { Type: string }).Type).toBe("GLB");
    expect(result.files.length).toBeGreaterThan(0);

    // 只有本地文件、无 providerUrl 的资产：明确报错
    const dir = assetDir("hy", "local-only");
    await storage.writeBytes(`${dir}/0-local-only.glb`, OBJ_BYTES);
    await writeJson(storage, `${dir}/.0-local-only-request.json`, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 0,
      slug: "local-only",
      provider: "volcengine",
      model: "x/y",
      params: {},
      status: "succeeded",
      outputs: [{ path: `${dir}/0-local-only.glb` }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(
      runHunyuanUvUnwrap(
        storage,
        { projectSlug: "hy", assetSlug: "local-only" },
        { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("公网 URL");
  });

});

describe("后处理渠道函数", () => {
  test("文生动作：纯 Prompt 提交，无需模型输入", async () => {
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    const result = await runHunyuanMotion(
      storage,
      { projectSlug: "hy", assetSlug: "hero", prompt: "向前走两步然后挥手", duration: 6 },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );
    const submit = calls.find((c) => c.action === "SubmitHunyuanTo3DMotionJob");
    expect(submit?.body.Prompt).toBe("向前走两步然后挥手");
    expect(submit?.body.Duration).toBe(6);
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("智能拓扑：字段名 File3D + FaceLevel", async () => {
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    await runHunyuanRetopo(
      storage,
      { projectSlug: "hy", assetSlug: "crate", faceLevel: "low", polygonType: "quadrilateral" },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );
    const submit = calls.find((c) => c.action === "SubmitReduceFaceJob");
    expect((submit?.body.File3D as { Url: string }).Url).toContain("https://");
    expect(submit?.body.FaceLevel).toBe("low");
    expect(submit?.body.PolygonType).toBe("quadrilateral");
  });
});
