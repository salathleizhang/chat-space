import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAnalysisFile, projectSourceDir } from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage, writeJson } from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import {
  createSceneJob,
  ensureSceneSpecFromAnalysis,
  mutateSceneJob,
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
});
