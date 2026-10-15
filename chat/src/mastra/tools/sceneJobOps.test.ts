import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAnalysisFile, projectSourceDir } from "../../common/libraryPaths";
import { SceneAnalysisSchema } from "../../dto/library";
import type { SceneJob } from "../../dto/sceneJobs";
import { LocalFileStorage, setAssetStorage, writeJson } from "../../services/assetStorage";
import {
  createSceneJob,
  ensureSceneSpecFromAnalysis,
  readSceneJob,
  readSceneSpec,
  resolveCurrentSceneJob,
} from "../../services/sceneJobs";
import { buildRequestContext } from "../../services/workflowRuns";
import { createProject } from "./projectTools";
import {
  getSceneJobTool,
  retrySceneJobNodesTool,
  reviseSceneJobTool,
} from "./sceneJobOps";

/*
  jobId 与参考图分析的 runId 是同一类东西：**服务端拥有的不透明 UUID**。
  这里钉住"它必须是可选的、能由服务端从项目状态解析"——让模型保管 UUID，
  跨会话/上下文压缩时它只能编一个出来（线上事故见 referenceAnalysis.ts 的注释）。
*/

const root = await mkdtemp(join(tmpdir(), "chatspace-scene-job-ops-test-"));
const storage = new LocalFileStorage(root);
const projectSlug = "job-ops";
const emptyProjectSlug = "job-ops-empty";
let job: SceneJob;

beforeAll(async () => {
  setAssetStorage(storage);
  for (const slug of [projectSlug, emptyProjectSlug]) {
    await createProject(storage, { name: `Job Ops ${slug}`, slug });
    const image = `${projectSourceDir(slug)}/0-room.png`;
    await storage.writeBytes(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await writeJson(storage, projectAnalysisFile(slug), SceneAnalysisSchema, {
      schemaVersion: 1,
      confirmation: {
        runId: "11111111-1111-4111-8111-111111111111",
        selectedSlugs: ["sofa", "table"],
        allSelected: true,
      },
      sceneName: "客厅",
      sceneDescription: "木地板客厅",
      environment: { lighting: "daylight" },
      objects: [
        { slug: "sofa", name: "沙发", description: "灰色布艺沙发", sourceImages: [image] },
        { slug: "table", name: "茶几", description: "圆形木茶几", sourceImages: [image] },
      ],
      sources: [image],
      analyzedAt: new Date().toISOString(),
    });
  }
  job = await createSceneJob(storage, await ensureSceneSpecFromAnalysis(storage, projectSlug));
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

const context = (slug: string) =>
  ({ requestContext: buildRequestContext({ projectSlug: slug }) }) as never;

describe("SceneJob 工具的 jobId 解析", () => {
  test("get-scene-job 省略 jobId 时返回当前场景任务的 job", async () => {
    const result = (await getSceneJobTool.execute!({}, context(projectSlug))) as {
      job: { id: string } | null;
    };
    expect(result.job?.id).toBe(job.id);
  });

  test("get-scene-job 给了不存在的 jobId 时仍按项目当前任务解析，而不是报错", async () => {
    const result = (await getSceneJobTool.execute!(
      { jobId: "00000000-0000-0000-0000-000000000000" },
      context(projectSlug),
    )) as { job: { id: string } | null };
    expect(result.job?.id).toBe(job.id);
  });

  test("revise-scene-job 省略 jobId 时改的就是当前场景任务", async () => {
    const result = (await reviseSceneJobTool.execute!(
      {
        addObjects: [{ slug: "lamp", name: "落地灯", description: "黑色落地灯" }],
        removeSlugs: [],
        updateObjects: [],
        reason: "漏了一盏灯",
        resume: false,
      },
      context(projectSlug),
    )) as { job: { id: string; specRevision: number } };

    expect(result.job.id).toBe(job.id);
    expect(result.job.specRevision).toBe(2);
    const spec = await readSceneSpec(storage, projectSlug);
    expect(spec?.objects.map((object) => object.slug)).toEqual(["sofa", "table", "lamp"]);
    // 没有 jobId 也修订在同一个任务记录上，而不是新建一个。
    expect((await readSceneJob(storage, projectSlug, job.id)).specRevision).toBe(2);
  });

  test("retry-scene-job-nodes 省略 jobId 时重做的是当前场景任务的节点", async () => {
    const result = (await retrySceneJobNodesTool.execute!(
      { nodes: ["plate"], resume: false },
      context(projectSlug),
    )) as { job: { id: string } };

    expect(result.job.id).toBe(job.id);
    const retried = await readSceneJob(storage, projectSlug, job.id);
    expect(retried.nodes.plate?.status).toBe("pending");
    expect(retried.status).toBe("paused");
  });

  test("项目还没有 SceneJob 时：查询返回 null，修订给出可执行的报错", async () => {
    const queried = (await getSceneJobTool.execute!({}, context(emptyProjectSlug))) as {
      job: unknown;
    };
    expect(queried.job).toBeNull();

    await expect(
      reviseSceneJobTool.execute!(
        {
          addObjects: [{ slug: "chair", name: "椅子", description: "木椅" }],
          removeSlugs: [],
          updateObjects: [],
          reason: "补一把椅子",
          resume: false,
        },
        context(emptyProjectSlug),
      ),
    ).rejects.toThrow("start-scene-job first");
  });

  test("resolveCurrentSceneJob 解析到与当前 SceneSpec revision 匹配的那个任务", async () => {
    const resolved = await resolveCurrentSceneJob(storage, projectSlug);
    expect(resolved?.id).toBe(job.id);
    expect(resolved?.specRevision).toBe(2);
    // 显式给的 jobId 存在时优先（消歧参数仍然有用）。
    expect((await resolveCurrentSceneJob(storage, projectSlug, job.id))?.id).toBe(job.id);
  });
});
