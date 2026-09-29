import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatServiceError } from "../common/errors";
import { projectAnalysisFile, projectSourceDir } from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import type { SceneJobNode, SceneJobNodeStatus, SceneSpec } from "../dto/sceneJobs";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage, writeJson } from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import {
  buildSceneJobNodes,
  createSceneJob,
  ensureSceneSpecFromAnalysis,
  mutateSceneJob,
  planNodeInvalidation,
  retrySceneJobNodes,
  reviseSceneSpecAndJob,
} from "./sceneJobs";

const root = await mkdtemp(join(tmpdir(), "chatspace-scene-jobs-test-"));
const storage = new LocalFileStorage(root);
const projectSlug = "scene-job-test";
const sourceImage = `${projectSourceDir(projectSlug)}/0-room.png`;

beforeAll(async () => {
  await createProject(storage, { name: "Scene Job", slug: projectSlug });
  await storage.writeBytes(sourceImage, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeJson(storage, projectAnalysisFile(projectSlug), SceneAnalysisSchema, {
    schemaVersion: 1,
    confirmation: {
      runId: "11111111-1111-4111-8111-111111111111",
      selectedSlugs: ["sofa", "table"],
      allSelected: true,
    },
    sceneName: "客厅",
    sceneDescription: "木地板客厅",
    environment: { lighting: "daylight", spatialLayout: "open plan" },
    objects: [
      { slug: "sofa", name: "沙发", description: "灰色布艺沙发", sourceImages: [sourceImage] },
      { slug: "table", name: "茶几", description: "圆形木茶几", sourceImages: [sourceImage] },
    ],
    sources: [sourceImage],
    analyzedAt: new Date().toISOString(),
  });
});

afterAll(() => rm(root, { recursive: true, force: true }));

async function succeededJob() {
  const spec = await ensureSceneSpecFromAnalysis(storage, projectSlug);
  const job = await createSceneJob(storage, spec);
  return mutateSceneJob(storage, projectSlug, job.id, (current) => ({
    ...current,
    status: "succeeded",
    nodes: Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [
      id,
      { ...node, status: "succeeded" as const, outputs: [] },
    ])),
  }));
}

describe("SceneSpec / SceneJob 依赖失效", () => {
  test("从已确认 analysis 幂等创建 SceneSpec 和两条生成分支", async () => {
    const first = await ensureSceneSpecFromAnalysis(storage, projectSlug);
    const repeated = await ensureSceneSpecFromAnalysis(storage, projectSlug);
    expect(repeated).toEqual(first);
    const job = await createSceneJob(storage, first);
    expect(job.nodes["reference:sofa"]?.dependsOn).toEqual([]);
    expect(job.nodes["model:sofa"]?.dependsOn).toEqual(["reference:sofa"]);
    expect(job.nodes.plate?.dependsOn).toEqual([]);
    expect(job.nodes.world?.dependsOn).toEqual(["plate"]);
    expect(job.nodes["final-review"]?.dependsOn).toEqual([
      "world",
      "model:sofa",
      "model:table",
    ]);
  });

  test("补充遗漏椅子：新建椅子参考图/模型，只失效底板、world 和汇总", async () => {
    const job = await succeededJob();
    const { spec, job: revised } = await reviseSceneSpecAndJob(storage, projectSlug, job.id, {
      reason: "发现原图遗漏一把椅子",
      addObjects: [{ slug: "chair", name: "椅子", description: "木质餐椅" }],
    });
    expect(spec.objects.map((object) => object.slug)).toEqual(["sofa", "table", "chair"]);
    expect(revised.nodes["reference:chair"]?.status).toBe("pending");
    expect(revised.nodes["model:chair"]?.status).toBe("blocked");
    expect(revised.nodes["reference:sofa"]?.status).toBe("succeeded");
    expect(revised.nodes["model:sofa"]?.status).toBe("succeeded");
    expect(revised.nodes.plate?.status).toBe("stale");
    expect(revised.nodes.world?.status).toBe("stale");
    expect(revised.nodes["final-review"]?.status).toBe("stale");
    expect(revised.nodes["final-review"]?.dependsOn).toContain("model:chair");
    expect((await readCandidates(storage, projectSlug)).objects.find((object) => object.slug === "chair")?.sourceImages)
      .toEqual([sourceImage]);
  });

  test("底板不干净：局部重做 plate 只失效 world/汇总，不碰已有模型", async () => {
    const job = await succeededJob();
    const retried = await retrySceneJobNodes(storage, projectSlug, job.id, ["plate"]);
    expect(retried.nodes.plate?.status).toBe("pending");
    expect(retried.nodes.world?.status).toBe("stale");
    expect(retried.nodes["final-review"]?.status).toBe("stale");
    expect(retried.nodes["model:sofa"]?.status).toBe("succeeded");
    expect(retried.nodes["model:table"]?.status).toBe("succeeded");
  });

  test("重做 reference:sofa：只重跑该分支，清掉 qa/error 并刷新 updatedAt", async () => {
    const job = await succeededJob();
    const prepared = await mutateSceneJob(storage, projectSlug, job.id, (current) => ({
      ...current,
      nodes: {
        ...current.nodes,
        "model:sofa": {
          ...current.nodes["model:sofa"]!,
          qa: {
            decision: "regenerate" as const,
            issues: ["台面穿模"],
            checkedAt: "2000-01-01T00:00:00.000Z",
          },
          error: "旧错误",
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
        "model:table": {
          ...current.nodes["model:table"]!,
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
      },
    }));
    const retried = await retrySceneJobNodes(storage, projectSlug, prepared.id, ["reference:sofa"]);
    expect(retried.nodes["reference:sofa"]?.status).toBe("pending");
    expect(retried.nodes["model:sofa"]?.status).toBe("stale");
    expect(retried.nodes["model:sofa"]?.qa).toBeUndefined();
    expect(retried.nodes["model:sofa"]?.error).toBeUndefined();
    expect(retried.nodes["model:sofa"]!.updatedAt > "2000-01-01T00:00:00.000Z").toBe(true);
    expect(retried.nodes["final-review"]?.status).toBe("stale");
    expect(retried.nodes.plate?.status).toBe("succeeded");
    expect(retried.nodes.world?.status).toBe("succeeded");
    expect(retried.nodes["reference:table"]?.status).toBe("succeeded");
    expect(retried.nodes["model:table"]?.status).toBe("succeeded");
    expect(retried.nodes["model:table"]?.updatedAt).toBe("2000-01-01T00:00:00.000Z");
    // retry 只改状态，不重算输入指纹（指纹由 revise 负责）。
    expect(retried.nodes["model:sofa"]?.inputFingerprint)
      .toBe(prepared.nodes["model:sofa"]?.inputFingerprint);
  });

  test("修改对象：revise 的失效范围与纯函数一致，但状态语义是 stale 而非 pending", async () => {
    const job = await succeededJob();
    const { job: revised } = await reviseSceneSpecAndJob(storage, projectSlug, job.id, {
      reason: "修正沙发描述",
      updateObjects: [{ slug: "sofa", name: "沙发", description: "浅灰布艺沙发" }],
    });
    const scope = planNodeInvalidation(job.nodes, ["plate", "reference:sofa"]);
    const expected = [...scope.pending, ...scope.stale].sort();
    const changed = Object.entries(revised.nodes)
      .filter(([id, node]) => node.status !== job.nodes[id]?.status)
      .map(([id]) => id)
      .sort();
    expect(changed).toEqual(expected);
    // revise 把被修改对象的参考图/模型标 stale（不自动重跑），与 retry 的 pending 刻意不同。
    expect(revised.nodes["reference:sofa"]?.status).toBe("stale");
    expect(revised.nodes["model:sofa"]?.status).toBe("stale");
    expect(revised.nodes["model:table"]?.status).toBe("succeeded");
  });
});

/** 与存储无关的图夹具：sofa/table 两条参考→模型分支 + plate→world + final-review 汇总。 */
const fixtureSlug = "scene-invalidation-fixture";
const fixtureSourceImage = `${projectSourceDir(fixtureSlug)}/0-room.png`;

function fixtureNodes(
  overrides: Record<string, SceneJobNodeStatus> = {},
): Record<string, SceneJobNode> {
  const spec: SceneSpec = {
    schemaVersion: 1,
    projectSlug: fixtureSlug,
    revision: 1,
    revisionReason: "纯函数测试夹具",
    sourceImage: fixtureSourceImage,
    sceneName: "客厅",
    sceneDescription: "木地板客厅",
    environment: { lighting: "daylight", spatialLayout: "open plan" },
    objects: [
      { slug: "sofa", name: "沙发", description: "灰色布艺沙发", origin: "analysis", addedAtRevision: 1 },
      { slug: "table", name: "茶几", description: "圆形木茶几", origin: "analysis", addedAtRevision: 1 },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return Object.fromEntries(
    Object.entries(buildSceneJobNodes(spec)).map(([id, node]) => [
      id,
      { ...node, status: overrides[id] ?? "succeeded" },
    ]),
  ) as Record<string, SceneJobNode>;
}

function captureChatServiceError(run: () => unknown): ChatServiceError {
  try {
    run();
  } catch (error) {
    if (error instanceof ChatServiceError) return error;
    throw error;
  }
  throw new Error("期望抛出 ChatServiceError，但没有抛出");
}

describe("planNodeInvalidation 纯函数", () => {
  test("改一个对象：只失效该对象的参考图/模型与 plate/world/汇总，其他对象模型不受影响", () => {
    const nodes = fixtureNodes();
    const plan = planNodeInvalidation(nodes, ["reference:sofa", "plate"]);
    expect(plan.pending).toEqual(["reference:sofa", "plate"]);
    expect([...plan.stale].sort()).toEqual(["final-review", "model:sofa", "world"]);
    const touched = [...plan.pending, ...plan.stale];
    expect(touched).not.toContain("reference:table");
    expect(touched).not.toContain("model:table");
    // 纯函数：不修改入参、可重复调用且结果稳定。
    expect(nodes["reference:sofa"]?.status).toBe("succeeded");
    expect(nodes["model:sofa"]?.status).toBe("succeeded");
    expect(planNodeInvalidation(nodes, ["reference:sofa", "plate"])).toEqual(plan);
  });

  test("菱形/多路径依赖只出现一次，不会重复或死循环", () => {
    const nodes = fixtureNodes();
    const plan = planNodeInvalidation(nodes, ["plate", "reference:sofa"]);
    expect(plan.pending).toEqual(["plate", "reference:sofa"]);
    // final-review 同时经 world 与 model:sofa 两条路径到达。
    expect(plan.stale.filter((id) => id === "final-review")).toHaveLength(1);
    expect(plan.stale.filter((id) => id === "model:sofa")).toHaveLength(1);
    expect([...plan.stale].sort()).toEqual(["final-review", "model:sofa", "world"]);
    expect(new Set([...plan.pending, ...plan.stale]).size)
      .toBe(plan.pending.length + plan.stale.length);
  });

  test("obsolete 节点被跳过，且不沿它向下传播", () => {
    const nodes = fixtureNodes({ "model:table": "obsolete" });
    const plan = planNodeInvalidation(nodes, ["plate"]);
    expect(plan).toEqual({ pending: ["plate"], stale: ["world", "final-review"] });
    // reference:table 的下游只有已废弃的 model:table，链路到此为止。
    const stoppedAtObsolete = planNodeInvalidation(nodes, ["reference:table"]);
    expect(stoppedAtObsolete).toEqual({ pending: ["reference:table"], stale: [] });
  });

  test("指定不存在或已废弃的节点 → 404 scene_node_not_found", () => {
    const nodes = fixtureNodes({ "model:table": "obsolete" });
    for (const id of ["ghost", "model:table"]) {
      const error = captureChatServiceError(() => planNodeInvalidation(nodes, [id]));
      expect(error.status).toBe(404);
      expect(error.code).toBe("scene_node_not_found");
      expect(error.message).toBe(`场景节点不存在或已废弃：${id}`);
    }
  });

  test("多个指定节点都是 pending，共同下游是 stale", () => {
    const nodes = fixtureNodes();
    const plan = planNodeInvalidation(nodes, ["reference:sofa", "reference:table"]);
    expect(plan.pending).toEqual(["reference:sofa", "reference:table"]);
    expect([...plan.stale].sort()).toEqual(["final-review", "model:sofa", "model:table"]);
    const touched = [...plan.pending, ...plan.stale];
    expect(touched).not.toContain("plate");
    expect(touched).not.toContain("world");
  });
});
