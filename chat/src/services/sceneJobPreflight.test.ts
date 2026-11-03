import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAnalysisFile, projectTaskFile } from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage, withAssetStorage, writeJson } from "./assetStorage";
import { createSceneJob, ensureSceneSpecFromAnalysis, listSceneJobs, mutateSceneJob, readSceneJob, reviseSceneSpecAndJob } from "./sceneJobs";
import { GenerationTaskSchema } from "../dto/tasks";
import { runSceneJob } from "./sceneJobRunner";

test("缺少 World Labs 凭证时 SceneJob 与父任务一样失败，零节点被执行，恢复后清除错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "scene-job-preflight-"));
  const storage = new LocalFileStorage(root);
  try {
    await withAssetStorage(storage, async () => {
      await createProject(storage, { name: "Preflight", slug: "preflight" });
      await storage.writeBytes("projects/preflight/source/0-room.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      await writeJson(storage, projectAnalysisFile("preflight"), SceneAnalysisSchema, {
        schemaVersion: 1, sceneName: "room", sceneDescription: "room",
        environment: {}, objects: [{ slug: "chair", name: "chair", description: "chair" }],
        sources: ["projects/preflight/source/0-room.png"], analyzedAt: new Date().toISOString(),
      });
      const spec = await ensureSceneSpecFromAnalysis(storage, "preflight");
      const job = await createSceneJob(storage, spec);
      await expect(runSceneJob("preflight", job.id, {
        volcengineApiKey: "fixture", seed3dApiKey: "fixture",
      })).rejects.toThrow("WORLDLABS_KEY");
      const failed = await readSceneJob(storage, "preflight", job.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("WORLDLABS_KEY");
      expect(Object.values(failed.nodes).every(node => node.attempts === 0 && node.outputs.length === 0)).toBe(true);

      await mutateSceneJob(storage, "preflight", job.id, current => ({
        ...current, nodes: Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [
          id, { ...node, status: "succeeded" as const },
        ])),
      }));
      await runSceneJob("preflight", job.id, {});
      const completed = await readSceneJob(storage, "preflight", job.id);
      expect(completed.status).toBe("succeeded");
      expect(completed.error).toBeUndefined();

      // 历史记录已经处于这个坏状态：无需重新执行（或重新付费）也能解除修订闸门。
      await mutateSceneJob(storage, "preflight", job.id, current => ({
        ...current, status: "running", parentTaskId: "historical-parent",
      }));
      const now = new Date().toISOString();
      await writeJson(storage, projectTaskFile("preflight", "historical-parent"), GenerationTaskSchema, {
        id: "historical-parent", projectSlug: "preflight", workflowId: `scene-job:${job.id}`,
        subject: "scene", status: "failed", phase: "failed", error: "missing WORLDLABS_KEY",
        createdAt: now, updatedAt: now,
      });
      expect((await readSceneJob(storage, "preflight", job.id)).status).toBe("failed");
      expect((await listSceneJobs(storage, "preflight"))[0]?.error).toBe("missing WORLDLABS_KEY");
      const revised = await reviseSceneSpecAndJob(storage, "preflight", job.id, {
        addObjects: [{ slug: "sphere", name: "sphere", description: "sphere" }],
        removeSlugs: [], updateObjects: [], reason: "repair stale running state",
      });
      expect(revised.spec.revision).toBe(2);
      expect(revised.job.status).toBe("paused");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
