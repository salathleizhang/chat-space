import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAnalysisFile, projectTaskFile } from "../common/libraryPaths";
import { CloudTaskPending, withCloudContext, type CloudOperation } from "../cloud/context";
import { SceneAnalysisSchema } from "../dto/library";
import { GenerationTaskSchema, type GenerationTask } from "../dto/tasks";
import { config } from "../config";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage, withAssetStorage, writeJson } from "./assetStorage";
import { createSceneJob, ensureSceneSpecFromAnalysis, mutateSceneJob, readSceneJob, retrySceneJobNodes } from "./sceneJobs";
import { runSceneJob } from "./sceneJobRunner";
import type { RunKeys } from "./workflowRuns";

test("完整场景钉住所选渠道与模型 ID，后台续跑保留选择，显式重试不再等待旧的失败子任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "scene-tripo-"));
  const storage = new LocalFileStorage(root);
  const project = "tripo-scene";
  const image = `projects/${project}/source/0-chair.png`;
  const queued: { task: GenerationTask; operation: CloudOperation }[] = [];
  const cloud = {
    workspace: "browser", polling: true, pending: [] as Promise<unknown>[],
    enqueue: async (task: GenerationTask, operation: CloudOperation) => {
      queued.push({ task, operation });
      await writeJson(storage, projectTaskFile(project, task.id), GenerationTaskSchema, task);
    },
  };
  try {
    await withAssetStorage(storage, () => withCloudContext(cloud, async () => {
      await createProject(storage, { name: "Tripo scene", slug: project });
      await storage.writeBytes(image, new Uint8Array([1]));
      await writeJson(storage, projectAnalysisFile(project), SceneAnalysisSchema, {
        schemaVersion: 1, sceneName: "room", sceneDescription: "room", environment: {},
        objects: [{ slug: "chair", name: "chair", description: "chair" }], sources: [image],
        analyzedAt: new Date().toISOString(),
      });
      const spec = await ensureSceneSpecFromAnalysis(storage, project);
      const created = await createSceneJob(storage, spec);
      await mutateSceneJob(storage, project, created.id, job => ({
        ...job, status: "failed",
        nodes: Object.fromEntries(Object.entries(job.nodes).map(([id, node]) => [id,
          id === "model:chair"
            ? { ...node, status: "failed" as const, taskIds: ["old-failed-seed3d"] }
            : { ...node, status: "succeeded" as const, outputs: id === "reference:chair" ? [image] : [] },
        ])),
      }));
      const retry = await retrySceneJobNodes(storage, project, created.id, ["model:chair"]);
      expect(retry.nodes["model:chair"]?.taskIds).toEqual([]);
      expect(retry.nodes.world?.status).toBe("succeeded");
      // 摆放/汇总另有测试；本条只让模型成为可运行节点。
      await mutateSceneJob(storage, project, created.id, job => ({ ...job, nodes: {
        ...job.nodes, placement: { ...job.nodes.placement!, status: "succeeded" },
        "final-review": { ...job.nodes["final-review"]!, status: "succeeded" },
      } }));
      const step = async (keys: RunKeys) => {
        try { return await runSceneJob(project, created.id, keys); }
        catch (error) { if (!(error instanceof CloudTaskPending)) throw error; }
        finally { await Promise.all(cloud.pending); }
      };
      await step({ seed3dApiKey: "fixture", threeDModel: "hyper3d-gen2" });
      expect(queued).toHaveLength(1);
      expect(queued[0]!.operation).toMatchObject({ operation: "3d", input: {
        retry: {
          provider: "hyper3d-volc",
          options: { model: config.ark3d.hyper3dModel },
        },
      } });
      // 任务把渠道与模型 ID 钉在自己身上：后续续跑/重试都看这两个字段
      const pinned = await readSceneJob(storage, project, created.id);
      expect(pinned.modelProvider).toBe("hyper3d-volc");
      expect(pinned.modelId).toBe(config.ark3d.hyper3dModel);
      await step({ seed3dApiKey: "fixture" });
      expect(queued).toHaveLength(1);
      const model = `projects/${project}/assets/chair/0-chair.glb`;
      await storage.writeBytes(model, new Uint8Array([1]));
      await writeJson(storage, projectTaskFile(project, queued[0]!.task.id), GenerationTaskSchema, {
        ...queued[0]!.task, status: "succeeded", result: { files: [model] },
      });
      await step({ seed3dApiKey: "fixture" });
      await step({});
      expect((await readSceneJob(storage, project, created.id)).status).toBe("succeeded");
      expect(queued).toHaveLength(1);
    }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
