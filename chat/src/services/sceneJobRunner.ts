import { ChatServiceError, toErrorMessage } from "../common/errors";
import {
  assetDir,
  assetIdentityFile,
  projectAssetsDir,
} from "../common/libraryPaths";
import {
  AssetIdentitySchema,
  RequestSidecarSchema,
  type RequestSidecar,
} from "../dto/library";
import type { SceneJob, SceneJobNode, SceneSpec } from "../dto/sceneJobs";
import { renderablePathsFromResult } from "./modelPublishing";
import { getAssetStorage, readJson, type AssetStorage } from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import {
  createSceneJob,
  ensureSceneSpecFromAnalysis,
  listSceneJobs,
  mutateSceneJob,
  readSceneJob,
  readSceneSpec,
} from "./sceneJobs";
import {
  findRunningTask,
  getTask,
  startCustomTask,
  type TaskExecutionContext,
} from "./tasks";
import type { RunKeys } from "./workflowRuns";
import { runPlateGeneration } from "../mastra/tools/imageEdit";
import { runReferenceImageEdit } from "../mastra/tools/referenceImage";
import { startSeed3d3dBatch } from "../mastra/tools/seed3dOps";
import {
  composeEmptyWorldPrompt,
  runProjectWorldGeneration,
} from "../mastra/tools/worldGen";

function requireRunKey(keys: RunKeys, name: "volcengineApiKey" | "seed3dApiKey" | "worldLabsApiKey") {
  const value = keys[name];
  if (value) return value;
  throw new ChatServiceError(
    `完整场景生成需要本机 chat/.env 配置 ${name === "worldLabsApiKey" ? "WORLDLABS_KEY" : "VOLC_KEY"}`,
    401,
    "scene_job_missing_key",
  );
}

function isolatePrompt(object: SceneSpec["objects"][number]): string {
  return `Isolate the single ${object.name} (${object.description}) from the source image. ` +
    "Reproduce its colors, materials, proportions, and visible details faithfully. " +
    "Show the complete object centered on a plain white background, with space around every edge. " +
    "Remove other objects, people, scenery, text, and shadows on the ground.";
}

async function succeededSidecar(
  storage: AssetStorage,
  dir: string,
  matches: (sidecar: RequestSidecar) => boolean,
): Promise<RequestSidecar | undefined> {
  const names = (await storage.list(dir))
    .filter((name) => /^\.\d+-[a-z0-9-]+-request\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of names) {
    let sidecar: RequestSidecar;
    try {
      sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
    } catch {
      continue;
    }
    if (sidecar.status !== "succeeded" || sidecar.outputs.length === 0 || !matches(sidecar)) continue;
    if ((await Promise.all(sidecar.outputs.map((output) => storage.exists(output.path)))).every(Boolean)) {
      return sidecar;
    }
  }
  return undefined;
}

async function updateNode(
  storage: AssetStorage,
  job: SceneJob,
  nodeId: string,
  reducer: (node: SceneJobNode) => SceneJobNode,
): Promise<SceneJob> {
  return mutateSceneJob(storage, job.projectSlug, job.id, (current) => {
    const previous = current.nodes[nodeId];
    if (!previous) {
      throw new ChatServiceError(`场景节点不存在：${nodeId}`, 500, "scene_node_missing");
    }
    return {
      ...current,
      nodes: {
        ...current.nodes,
        [nodeId]: { ...reducer(previous), updatedAt: new Date().toISOString() },
      },
    };
  });
}

async function waitForModelTask(projectSlug: string, taskId: string): Promise<string[]> {
  for (;;) {
    const task = await getTask(projectSlug, taskId);
    if (!task || task.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (task.status === "failed") {
      throw new ChatServiceError(
        `物体生成失败：${task.error ?? "未知错误"}`,
        502,
        "scene_model_failed",
      );
    }
    const files = renderablePathsFromResult(task.result);
    if (files.length === 0) {
      throw new ChatServiceError("物体生成完成但没有可渲染模型文件", 502, "scene_model_empty");
    }
    return files;
  }
}

async function executeReferenceNode(
  storage: AssetStorage,
  job: SceneJob,
  spec: SceneSpec,
  node: SceneJobNode,
  keys: RunKeys,
  mayReuse: boolean,
): Promise<string[]> {
  const object = spec.objects.find((candidate) => candidate.slug === node.objectSlug);
  if (!object) throw new ChatServiceError(`场景对象不存在：${node.objectSlug}`, 409, "scene_object_missing");

  if (mayReuse) {
    const candidates = await readCandidates(storage, job.projectSlug);
    const candidate = candidates.objects.find((item) => item.slug === object.slug);
    const identityPath = assetIdentityFile(job.projectSlug, object.slug);
    const identity = await storage.exists(identityPath)
      ? await readJson(storage, identityPath, AssetIdentitySchema)
      : undefined;
    for (const path of [...(candidate?.sourceImages ?? []), ...(identity?.sourceImages ?? [])]) {
      if (path !== spec.sourceImage && await storage.exists(path)) return [path];
    }
  }

  const result = await runReferenceImageEdit(
    storage,
    {
      projectSlug: job.projectSlug,
      assetSlug: object.slug,
      prompt: isolatePrompt(object),
    },
    { volcengineApiKey: requireRunKey(keys, "volcengineApiKey") },
  );
  return [result.image];
}

async function executePlateNode(
  storage: AssetStorage,
  job: SceneJob,
  spec: SceneSpec,
  keys: RunKeys,
): Promise<string[]> {
  const result = await runPlateGeneration(
    storage,
    {
      projectSlug: job.projectSlug,
      sourceImage: spec.sourceImage,
      objectsToRemove: spec.objects.map(({ slug, name, description }) => ({ slug, name, description })),
    },
    { volcengineApiKey: requireRunKey(keys, "volcengineApiKey") },
  );
  return [result.output];
}

async function executeWorldNode(
  storage: AssetStorage,
  job: SceneJob,
  spec: SceneSpec,
  keys: RunKeys,
): Promise<string[]> {
  const current = await readSceneJob(storage, job.projectSlug, job.id);
  const plate = current.nodes.plate?.outputs[0];
  if (!plate) throw new ChatServiceError("干净底板节点没有输出", 409, "scene_plate_missing");
  const prompt = composeEmptyWorldPrompt({
    schemaVersion: 1,
    sceneName: spec.sceneName,
    sceneDescription: spec.sceneDescription,
    environment: spec.environment,
    objects: spec.objects.map(({ slug, name, description }) => ({ slug, name, description })),
    sources: [spec.sourceImage],
    analyzedAt: spec.updatedAt,
  });

  // 父任务在结果已落盘、节点状态尚未写回时中断：先复用匹配侧写。
  for (const slug of await storage.list(projectAssetsDir(job.projectSlug))) {
    const identityPath = assetIdentityFile(job.projectSlug, slug);
    if (!(await storage.exists(identityPath))) continue;
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    if (identity.kind !== "world") continue;
    const existing = await succeededSidecar(storage, assetDir(job.projectSlug, slug), (sidecar) =>
      sidecar.provider === "world-labs" &&
      sidecar.params.image === plate &&
      sidecar.params.prompt === prompt,
    );
    const worldJson = existing?.outputs.find((output) => output.path.endsWith(".json"))?.path;
    if (worldJson) return existing!.outputs.map((output) => output.path);
  }

  const result = await runProjectWorldGeneration(
    storage,
    { projectSlug: job.projectSlug, mode: "direct", sourceImage: plate, prompt },
    { apiKey: requireRunKey(keys, "worldLabsApiKey") },
  );
  return [result.worldJson, ...result.files];
}

async function executeModelNode(
  storage: AssetStorage,
  job: SceneJob,
  spec: SceneSpec,
  node: SceneJobNode,
  keys: RunKeys,
): Promise<string[]> {
  const object = spec.objects.find((candidate) => candidate.slug === node.objectSlug);
  if (!object) throw new ChatServiceError(`场景对象不存在：${node.objectSlug}`, 409, "scene_object_missing");
  const current = await readSceneJob(storage, job.projectSlug, job.id);
  const reference = current.nodes[`reference:${object.slug}`]?.outputs[0];
  if (!reference) throw new ChatServiceError(`对象「${object.name}」没有参考图输出`, 409, "scene_reference_missing");

  const identityPath = assetIdentityFile(job.projectSlug, object.slug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    if (identity.kind === "model") {
      const existing = await succeededSidecar(storage, assetDir(job.projectSlug, object.slug), (sidecar) =>
        sidecar.provider === "seed3d" && sidecar.params.image === reference,
      );
      const files = renderablePathsFromResult({ files: existing?.outputs.map((output) => output.path) });
      if (files.length > 0) return files;
    }
  }

  const task = startSeed3d3dBatch(
    job.projectSlug,
    [{ slug: object.slug, name: object.name, intent: object.description, sourceImages: [reference] }],
    { seed3dApiKey: requireRunKey(keys, "seed3dApiKey") },
  )[0];
  if (!task) throw new ChatServiceError("无法创建 Seed3D 任务", 500, "scene_model_task_missing");
  await updateNode(storage, job, node.id, (currentNode) => ({
    ...currentNode,
    taskIds: [...new Set([...currentNode.taskIds, task.id])],
  }));
  return waitForModelTask(job.projectSlug, task.id);
}

async function executeFinalNode(
  storage: AssetStorage,
  job: SceneJob,
  node: SceneJobNode,
): Promise<string[]> {
  const current = await readSceneJob(storage, job.projectSlug, job.id);
  return [...new Set(node.dependsOn.flatMap((dependency) => current.nodes[dependency]?.outputs ?? []))];
}

async function executeSceneNode(
  storage: AssetStorage,
  job: SceneJob,
  spec: SceneSpec,
  original: SceneJobNode,
  keys: RunKeys,
): Promise<void> {
  const mayReuse = original.status === "pending" || original.status === "blocked";
  const runningJob = await updateNode(storage, job, original.id, (node) => ({
    ...node,
    status: "running",
    attempts: node.attempts + 1,
    error: undefined,
  }));
  const running = runningJob.nodes[original.id]!;
  try {
    const outputs = running.kind === "reference"
      ? await executeReferenceNode(storage, job, spec, running, keys, mayReuse)
      : running.kind === "plate"
        ? await executePlateNode(storage, job, spec, keys)
        : running.kind === "world"
          ? await executeWorldNode(storage, job, spec, keys)
          : running.kind === "model"
            ? await executeModelNode(storage, job, spec, running, keys)
            : await executeFinalNode(storage, job, running);
    await updateNode(storage, job, original.id, (node) => ({
      ...node,
      status: "succeeded",
      outputs,
      error: undefined,
    }));
  } catch (error) {
    await updateNode(storage, job, original.id, (node) => ({
      ...node,
      status: "failed",
      error: toErrorMessage(error),
    }));
  }
}

function isRunnable(node: SceneJobNode, nodes: Record<string, SceneJobNode>): boolean {
  if (!["pending", "blocked", "stale"].includes(node.status)) return false;
  return node.dependsOn.every((id) => nodes[id]?.status === "succeeded");
}

export async function runSceneJob(
  projectSlug: string,
  jobId: string,
  keys: RunKeys,
): Promise<{ jobId: string; specRevision: number; outputs: string[] }> {
  const storage = getAssetStorage();
  const spec = await readSceneSpec(storage, projectSlug);
  if (!spec) throw new ChatServiceError("场景规格不存在", 409, "scene_spec_missing");
  const initial = await readSceneJob(storage, projectSlug, jobId);
  if (initial.specRevision !== spec.revision) {
    throw new ChatServiceError("场景任务与当前规格版本不一致", 409, "scene_spec_revision_conflict");
  }

  // 完整新任务仍会在任何付费请求前验证三类凭证；局部重跑只要求它
  // 实际会触及的节点凭证，例如重做 plate/world 不应被 Seed3D key 阻塞。
  const unfinishedKinds = new Set(
    Object.values(initial.nodes)
      .filter((node) => !["succeeded", "obsolete"].includes(node.status))
      .map((node) => node.kind),
  );
  if (unfinishedKinds.has("reference") || unfinishedKinds.has("plate")) {
    requireRunKey(keys, "volcengineApiKey");
  }
  if (unfinishedKinds.has("model")) requireRunKey(keys, "seed3dApiKey");
  if (unfinishedKinds.has("world")) requireRunKey(keys, "worldLabsApiKey");

  await mutateSceneJob(storage, projectSlug, jobId, (job) => ({ ...job, status: "running" }));
  for (;;) {
    const job = await readSceneJob(storage, projectSlug, jobId);
    const activeNodes = Object.values(job.nodes).filter((node) => node.status !== "obsolete");
    const ready = activeNodes.filter((node) => isRunnable(node, job.nodes));
    if (ready.length > 0) {
      await Promise.all(ready.map((node) => executeSceneNode(storage, job, spec, node, keys)));
      continue;
    }
    if (activeNodes.every((node) => node.status === "succeeded")) {
      const completed = await mutateSceneJob(storage, projectSlug, jobId, (current) => ({
        ...current,
        status: "succeeded",
      }));
      return {
        jobId,
        specRevision: completed.specRevision,
        outputs: completed.nodes["final-review"]?.outputs ?? [],
      };
    }
    const failures = activeNodes.filter((node) => node.status === "failed");
    const message = failures.length > 0
      ? failures.map((node) => `${node.id}：${node.error ?? "未知错误"}`).join("；")
      : "场景节点之间存在无法解锁的依赖";
    await mutateSceneJob(storage, projectSlug, jobId, (current) => ({
      ...current,
      status: "failed",
    }));
    throw new ChatServiceError(`完整场景生成未完成：${message}`, 502, "scene_job_failed");
  }
}

export async function startSceneJobExecution(
  projectSlug: string,
  jobId: string,
  keys: RunKeys,
) {
  const workflowId = `scene-job:${jobId}`;
  const running = findRunningTask(projectSlug, workflowId);
  if (running) return running;
  const task = startCustomTask(
    workflowId,
    projectSlug,
    "完整场景生成",
    async (execution: TaskExecutionContext) => {
      await execution.setPhase("generating");
      return runSceneJob(projectSlug, jobId, keys);
    },
  );
  await mutateSceneJob(getAssetStorage(), projectSlug, jobId, (job) => ({
    ...job,
    status: "running",
    parentTaskId: task.id,
  }));
  return task;
}

export async function createAndStartSceneJob(projectSlug: string, keys: RunKeys) {
  const storage = getAssetStorage();
  const spec = await ensureSceneSpecFromAnalysis(storage, projectSlug);
  const existing = (await listSceneJobs(storage, projectSlug)).find((job) =>
    job.specRevision === spec.revision,
  );
  const job = existing ?? await createSceneJob(storage, spec);
  if (job.status === "succeeded" && job.parentTaskId) {
    const completedTask = await getTask(projectSlug, job.parentTaskId);
    if (completedTask?.status === "succeeded") return { job, task: completedTask };
  }
  const task = job.status === "failed" || job.status === "paused"
    ? await resumeSceneJob(projectSlug, job.id, keys)
    : await startSceneJobExecution(projectSlug, job.id, keys);
  return { job: await readSceneJob(storage, projectSlug, job.id), task };
}

export async function resumeSceneJob(projectSlug: string, jobId: string, keys: RunKeys) {
  const storage = getAssetStorage();
  await mutateSceneJob(storage, projectSlug, jobId, (job) => ({
    ...job,
    status: "paused",
    nodes: Object.fromEntries(Object.entries(job.nodes).map(([id, node]) => [
      id,
      node.status === "running" || node.status === "failed"
        ? { ...node, status: "pending" as const, error: undefined }
        : node,
    ])),
  }));
  return startSceneJobExecution(projectSlug, jobId, keys);
}
