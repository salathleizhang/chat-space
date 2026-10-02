import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDir,
  projectSourceDir,
  projectTaskFile,
} from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { GenerationTaskSchema } from "../../dto/tasks";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
  writeJson,
} from "../../services/assetStorage";
import { clearTasks } from "../../services/tasks";
import { runArk3dImageTo3d, startArk3dBatch } from "./ark3dOps";
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
afterAll(async () => {
  setAssetStorage(undefined);
  clearTasks();
  await rm(root, { recursive: true, force: true });
});

/** 轮询到条件成立；超时就抛，避免测试挂死。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

test("显式 model 覆盖该渠道默认模型，请求体与侧写都按它提交", async () => {
  const { bodies, fetchFn } = fakeArk();
  const result = await runArk3dImageTo3d(
    storage, "hyper3d-volc", "ark-models", "robot-pinned", source,
    { apiKey: "test-volc", model: "hyper3d-gen3-test", fetchFn, pollIntervalMs: 1 },
  );
  expect(bodies[0]).toMatchObject({ model: "hyper3d-gen3-test" });
  expect((await readJson(storage, result.sidecar, RequestSidecarSchema)).model)
    .toBe("hyper3d-gen3-test");
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

test("轮询状态回调一路传到等待器（看板进度与卡死看门狗都靠它）", async () => {
  const statuses: string[] = [];
  let finished = false;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/contents/generations/tasks")) return Response.json({ id: "cgt-live" });
    if (url.endsWith("/contents/generations/tasks/cgt-live")) {
      return Response.json(
        finished
          ? { status: "succeeded", content: { file_url: "https://cdn.fake/model.glb" } }
          : { status: "running" },
      );
    }
    if (url === "https://cdn.fake/model.glb") return new Response(glb);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const pending = runArk3dImageTo3d(
    storage, "hyper3d-volc", "ark-models", "robot-live", source,
    {
      apiKey: "test-volc",
      fetchFn,
      pollIntervalMs: 5,
      onStatus: (status) => {
        statuses.push(status);
      },
    },
  );
  await waitFor(async () => statuses.includes("running"));
  finished = true;
  await pending;
  expect(statuses.at(-1)).toBe("succeeded");
});

test("轮询失败报自己渠道的名字，不再串台成 Seed3D", async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/contents/generations/tasks")) return Response.json({ id: "cgt-bad" });
    return Response.json({ error: "boom" }, { status: 500 });
  }) as typeof fetch;
  await expect(
    runArk3dImageTo3d(
      storage, "hyper3d-volc", "ark-models", "robot-label", source,
      { apiKey: "test-volc", fetchFn, pollIntervalMs: 1 },
    ),
  ).rejects.toThrow("Hyper3D 任务查询 请求失败（500）");
});

test("提交失败同样用渠道自己的名字", async () => {
  const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ error: "boom" }, { status: 500 })) as typeof fetch;
  await expect(
    runArk3dImageTo3d(
      storage, "hyper3d-volc", "ark-models", "robot-submit", source,
      { apiKey: "test-volc", fetchFn, pollIntervalMs: 1 },
    ),
  ).rejects.toThrow("Hyper3D 任务提交失败（500）");
});

test("批量生成：轮询期间任务记录持续刷新，长任务不会被 60 分钟看门狗误杀", async () => {
  setAssetStorage(storage);
  await createProject(storage, { name: "看门狗", slug: "watchdog" });
  const watchdogSource = `${projectSourceDir("watchdog")}/0-photo.png`;
  await storage.writeBytes(watchdogSource, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  let finished = false;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/contents/generations/tasks")) return Response.json({ id: "cgt-watch" });
    if (url.endsWith("/contents/generations/tasks/cgt-watch")) {
      return Response.json(
        finished
          ? { status: "succeeded", content: { file_url: "https://cdn.fake/model.glb" } }
          : { status: "running" },
      );
    }
    if (url === "https://cdn.fake/model.glb") return new Response(glb);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const [task] = startArk3dBatch(
    "hyper3d-volc",
    "watchdog",
    [{ slug: "chair", name: "椅子", intent: "一张椅子", sourceImages: [watchdogSource] }],
    { apiKey: "test-volc", fetchFn, pollIntervalMs: 10 },
  );
  expect(task).toBeDefined();
  const taskPath = projectTaskFile("watchdog", task!.id);
  const readUpdatedAt = async () =>
    (await readJson(storage, taskPath, GenerationTaskSchema)).updatedAt;

  // 轮询还在跑的时候，记录必须一直在动（看门狗判据就是 updatedAt）。
  // 首次落盘是异步的，等文件出现再取基准值。
  await waitFor(async () => {
    try {
      await readUpdatedAt();
      return true;
    } catch {
      return false;
    }
  });
  const first = await readUpdatedAt();
  await waitFor(async () => (await readUpdatedAt()) !== first);
  const second = await readUpdatedAt();
  await waitFor(async () => (await readUpdatedAt()) !== second);

  finished = true;
  await waitFor(async () =>
    (await readJson(storage, taskPath, GenerationTaskSchema)).status === "succeeded");
});
