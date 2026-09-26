import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCandidatesFile, projectSourceDir } from "../../common/libraryPaths";
import { CandidateRegistrySchema, RequestSidecarSchema } from "../../dto/library";
import { SEED3D_MODEL } from "../../models/seed3d";
import {
  LocalFileStorage,
  readJson,
  setAssetStorage,
  writeJson,
} from "../../services/assetStorage";
import { clearTasks, getTask } from "../../services/tasks";
import { buildRequestContext } from "../../services/workflowRuns";
import { createProject } from "./projectTools";
import { start3dBatchTool } from "./taskTools";

/**
 * 界面下拉选的是具体模型，服务端必须把它当成硬约束：agent 传的 provider 不能
 * 把它顶掉，模型 ID 也要原样落到供应商请求里。
 */

const root = await mkdtemp(join(tmpdir(), "chatspace-task-tools-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const realFetch = globalThis.fetch;

const seed3dBodies: Record<string, unknown>[] = [];
const arkBodies: Record<string, unknown>[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 假方舟：Seed3D 与影眸/数美共用提交路径，按模型 ID 分流记录。 */
function installFakeFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.fake/")) {
      return new Response(GLB_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/contents/generations/tasks") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (body.model === SEED3D_MODEL) seed3dBodies.push(body);
      else arkBodies.push(body);
      return jsonResponse({ id: `ark-${seed3dBodies.length + arkBodies.length}` });
    }
    if (url.includes("/contents/generations/tasks/")) {
      return jsonResponse({ status: "succeeded", content: { file_url: "https://cdn.fake/model.glb" } });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  setAssetStorage(storage);
  installFakeFetch();
  await createProject(storage, { name: "任务工具", slug: "tt" });
  const image = `${projectSourceDir("tt")}/0-ref.png`;
  await storage.writeBytes(image, PNG_BYTES);
  await writeJson(storage, projectCandidatesFile("tt"), CandidateRegistrySchema, {
    schemaVersion: 1,
    objects: [{ slug: "lamp", name: "台灯", description: "暖光台灯", sourceImages: [image] }],
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAssetStorage(undefined);
  clearTasks();
  await rm(root, { recursive: true, force: true });
});

/** 后台任务是 fire-and-forget，等它结算，避免断言跑在提交之前。 */
async function waitForSettle(taskId: string) {
  for (let i = 0; i < 200; i++) {
    const task = await getTask("tt", taskId);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务未在预期时间内结算：${taskId}`);
}

async function runBatch(threeDModel: string | undefined, provider: string) {
  const result = await start3dBatchTool.execute!(
    { provider, tripoGenerationMode: "auto" } as never,
    {
      requestContext: buildRequestContext({
        projectSlug: "tt",
        ...(threeDModel ? { threeDModel: threeDModel as never } : {}),
        volcengineApiKey: "sk-volc",
        seed3dApiKey: "sk-volc",
        tripo3dApiKey: "tsk-1",
      }),
    } as never,
  );
  const taskId = (result as { tasks: { id: string }[] }).tasks[0]!.id;
  return waitForSettle(taskId);
}

describe("start-3d-batch 的 3D 模型选择", () => {
  test("用户选定 Hyper3D Gen-2 时，agent 传的 Seed3D 被顶掉，模型 ID 原样提交", async () => {
    seed3dBodies.length = 0;
    arkBodies.length = 0;
    const task = await runBatch("hyper3d-gen2", "seed3d-direct");

    expect(task.status).toBe("succeeded");
    expect(seed3dBodies).toHaveLength(0);
    expect(arkBodies[0]).toMatchObject({ model: "hyper3d-gen2-260112" });
    const sidecar = await readJson(
      storage,
      `projects/tt/assets/lamp/.0-lamp-request.json`,
      RequestSidecarSchema,
    );
    expect(sidecar.provider).toBe("ark-hyper3d");
    expect(sidecar.model).toBe("hyper3d-gen2-260112");
  });

  test("Auto（未选择）时按 agent 的判断走 Seed3D 默认模型", async () => {
    seed3dBodies.length = 0;
    arkBodies.length = 0;
    const task = await runBatch(undefined, "seed3d-direct");

    expect(task.status).toBe("succeeded");
    expect(arkBodies).toHaveLength(0);
    expect(seed3dBodies[0]).toMatchObject({ model: SEED3D_MODEL });
  });
});
