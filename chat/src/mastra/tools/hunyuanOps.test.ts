import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, writeJson } from "../../services/assetStorage";
import { runHunyuanUvUnwrap } from "./hunyuanOps";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-hunyuan-uv-test-"));
const storage = new LocalFileStorage(root);
const MODEL_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeFakeHunyuanFetch() {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(MODEL_BYTES.buffer.slice(0), { status: 200 });
    }
    const headers = init?.headers as Record<string, string>;
    const action = headers["X-TC-Action"] ?? "";
    calls.push({ action, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (action === "SubmitHunyuanTo3DUVJob") {
      return jsonResponse({ Response: { JobId: "job-uv-7", RequestId: "r" } });
    }
    return jsonResponse({
      Response: {
        Status: "DONE",
        ResultFile3Ds: [{ Type: "GLB", Url: "https://cdn.fake/uv.glb" }],
        RequestId: "r",
      },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

beforeAll(async () => {
  await createProject(storage, { name: "混元 UV 演示", slug: "hy" });
  const dir = assetDir("hy", "crate");
  await storage.writeBytes(`${dir}/0-crate.glb`, MODEL_BYTES);
  await writeJson(storage, `${dir}/.0-crate-request.json`, RequestSidecarSchema, {
    schemaVersion: 1,
    index: 0,
    slug: "crate",
    provider: "tripo",
    model: "/generation/image-to-model",
    providerTaskId: "task-model",
    params: {},
    status: "succeeded",
    outputs: [{ path: `${dir}/0-crate.glb`, providerUrl: "https://cdn.fake/source.glb" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("runHunyuanUvUnwrap", () => {
  test("只调用 UV Action，并把结果落盘", async () => {
    const { fetchFn, calls } = makeFakeHunyuanFetch();
    const result = await runHunyuanUvUnwrap(
      storage,
      { projectSlug: "hy", assetSlug: "crate" },
      { apiKey: "sid:skey", fetchFn, pollIntervalMs: 1 },
    );

    expect(calls.map((call) => call.action)).toEqual([
      "SubmitHunyuanTo3DUVJob",
      "DescribeHunyuanTo3DUVJob",
    ]);
    const submit = calls[0];
    expect((submit?.body.File as { Url: string }).Url).toBe("https://cdn.fake/source.glb");
    expect(result.jobId).toBe("job-uv-7");
    expect(result.files).toEqual([`${assetDir("hy", "crate")}/1-crate.glb`]);
  });

  test("无效密钥在提交前失败", () => {
    expect(
      runHunyuanUvUnwrap(
        storage,
        { projectSlug: "hy", assetSlug: "crate" },
        { apiKey: "invalid", fetchFn: makeFakeHunyuanFetch().fetchFn },
      ),
    ).rejects.toThrow("SecretId:SecretKey");
  });
});
