import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { LocalFileStorage, readJson, writeJson } from "../../services/assetStorage";
import { runArk3dImageTo3d } from "./ark3dOps";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-ark3d-test-"));
const storage = new LocalFileStorage(root);
const source = `${projectSourceDir("ark-models")}/0-reference.png`;
const imageUrl = "https://ark-project.tos-cn-beijing.volces.com/reference.png";
const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

beforeAll(async () => {
  await createProject(storage, { name: "方舟模型", slug: "ark-models" });
  await storage.writeBytes(source, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
});
afterAll(() => rm(root, { recursive: true, force: true }));

function fakeArk() {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/contents/generations/tasks")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "cgt-test" });
    }
    if (url.endsWith("/contents/generations/tasks/cgt-test")) {
      return Response.json({ status: "succeeded", content: { file_url: "https://cdn.fake/model.glb" } });
    }
    if (url === "https://cdn.fake/model.glb") return new Response(glb);
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
  return { bodies, fetchFn };
}

test("火山 Hyper3D 使用 data URI、文本参数，结果保存到本地", async () => {
  const { bodies, fetchFn } = fakeArk();
  const result = await runArk3dImageTo3d(
    storage, "hyper3d-volc", "ark-models", "robot", source,
    { apiKey: "test-volc", faceCount: 150000, taPose: true, fetchFn, pollIntervalMs: 1 },
  );
  expect(bodies[0]).toMatchObject({
    model: "hyper3d-gen2-260112",
    content: [
      { type: "text", text: expect.stringContaining("--TAPose true") },
      { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
    ],
  });
  expect(result.files).toEqual([`${assetDir("ark-models", "robot")}/0-robot.glb`]);
  expect((await readJson(storage, result.sidecar, RequestSidecarSchema)).provider).toBe("ark-hyper3d");
});

test("火山 Hi3D 使用 Seedream URL，上传原图不可直接提交", async () => {
  const { bodies, fetchFn } = fakeArk();
  await expect(runArk3dImageTo3d(
    storage, "hi3d-volc", "ark-models", "chair", source,
    { apiKey: "test-volc", fetchFn, pollIntervalMs: 1 },
  )).rejects.toThrow("Seedream");
  expect(bodies).toHaveLength(0);

  await writeJson(storage, `${projectSourceDir("ark-models")}/.0-reference-request.json`, RequestSidecarSchema, {
    schemaVersion: 1,
    index: 0,
    slug: "reference",
    provider: "volcengine",
    model: "doubao-seedream-4-5-251128",
    params: {},
    status: "succeeded",
    outputs: [{ path: source, providerUrl: imageUrl }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const result = await runArk3dImageTo3d(
    storage, "hi3d-volc", "ark-models", "chair", source,
    { apiKey: "test-volc", faceCount: 2000000, resolution: "1536pro", fetchFn, pollIntervalMs: 1 },
  );
  expect(bodies[0]).toMatchObject({
    model: "hitem3d-2-0-251223",
    content: [
      { type: "text", text: "--ff 2 --resolution 1536pro --request_type 3 --face 2000000" },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  });
  expect(result.files).toEqual([`${assetDir("ark-models", "chair")}/0-chair.glb`]);
  expect((await readJson(storage, result.sidecar, RequestSidecarSchema)).provider).toBe("ark-hitem3d");
});
