import { ChatServiceError, toErrorMessage } from "../common/errors";
import { Deadline } from "../common/http";
import { currentTaskPump } from "../common/taskPump";
import { CloudTaskPending, currentCloudContext } from "../cloud/context";
import {
  assetDir,
  assetIdentityFile,
  projectAssetsDir,
  projectSourceDir,
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
  ensurePlacementNode,
  ensureSceneSpecFromAnalysis,
  listSceneJobs,
  mutateSceneJob,
  readSceneJob,
  readSceneSpec,
} from "./sceneJobs";
import {
  findRunningTask,
  getTask,
  listTasks,
  startCustomTask,
  type TaskExecutionContext,
} from "./tasks";
import type { RunKeys } from "./workflowRuns";
import { runPlateGeneration } from "../mastra/tools/imageEdit";
import { runReferenceImageEdit } from "../mastra/tools/referenceImage";
import { startTripo3dBatch } from "../mastra/tools/tripoOps";

/**
 * 完整场景的模型节点仍按 Tripo 记录模型 ID（`tripoImageModel` 字段是持久化契约）。
 * 这条链路当前**暂时关闭**（见 `mastra/agents/creator.ts` 的 scene 工具开关），
 * 保留常量只是为了让存量任务与测试仍能读出原来的模型 ID。
 */
const SCENE_MODEL_ID = THREE_D_MODELS["tripo-3-1"].model;

/** 场景任务记录的是 **Tripo 模型 ID**（持久化字段 `tripoImageModel`）：选中 Tripo 时沿用它，否则用默认。 */
function sceneModelFor(selection: unknown): string {
  const entry = threeDModelFor(selection);
  return entry && entry.provider === "tripo-direct" ? entry.model : SCENE_MODEL_ID;
}
import { THREE_D_MODELS, threeDModelFor } from "../models/threeD";
import {
  composeEmptyWorldPrompt,
  runProjectWorldGeneration,
} from "../mastra/tools/worldGen";
import { runScenePlacement } from "./scenePlacementRun";

function requireRunKey(keys: RunKeys, name: "volcengineApiKey" | "tripo3dApiKey" | "worldLabsApiKey") {
  const value = keys[name];
  if (value) return value;
  throw new ChatServiceError(
    `Full scene generation requires ${name === "worldLabsApiKey" ? "WORLDLABS_KEY" : name === "tripo3dApiKey" ? "TRIPO_KEY" : "VOLC_KEY"} to be configured in the local chat/.env`,
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
      throw new ChatServiceError(`Scene node does not exist: ${nodeId}`, 500, "scene_node_missing");
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

/**
 * 等子任务结束。
 *
 * 子任务自己的轮询已经有硬预算（见 common/polling.ts），这里再兜一层：父任务不该因为
 * 一个永远停在 running 的子任务而无期限等下去——那正是「场景任务卡住」的最后一段路径。
 * 预算比卡死看门狗（60 分钟）宽，避免正常的长下载被误判。
 */
const MODEL_TASK_WAIT_TIMEOUT_MS = 90 * 60_000;

async function waitForModelTask(projectSlug: string, taskId: string): Promise<string[]> {
  const deadline = new Deadline(
    MODEL_TASK_WAIT_TIMEOUT_MS,
    () =>
      new ChatServiceError(
        `Timed out waiting for the object generation task (task_id=${taskId}): still not finished after ${MODEL_TASK_WAIT_TIMEOUT_MS / 60_000} minutes. ` +
          "The artifacts may already be on disk; confirm with list-generation-tasks first, then fill in any missing files with repair-assets.",
        504,
        "scene_model_wait_timeout",
      ),
  );
  try {
    for (;;) {
      const task = await deadline.guard(getTask(projectSlug, taskId));
      if (!task || task.status === "running") {
        if (currentCloudContext()) throw new CloudTaskPending(10);
        const pump = currentTaskPump();
        await deadline.guard(pump ? pump.wait(500) : new Promise((resolve) => setTimeout(resolve, 500)));
        continue;
      }
      if (task.status === "failed") {
        throw new ChatServiceError(
          `Object generation failed: ${task.error ?? "unknown error"}`,
          502,
          "scene_model_failed",
        );
      }
      const files = renderablePathsFromResult(task.result);
      if (files.length === 0) {
        throw new ChatServiceError("Object generation finished but there is no renderable model file", 502, "scene_model_empty");
      }
      return files;
    }
  } finally {
    deadline.dispose();
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
  if (!object) throw new ChatServiceError(`Scene object does not exist: ${node.objectSlug}`, 409, "scene_object_missing");

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
  if (currentCloudContext()) {
    const { composePlatePrompt } = await import("../mastra/tools/imageEdit");
    const prompt = composePlatePrompt(spec.objects.map(({ slug, name, description }) => ({ slug, name, description })));
    const existing = await succeededSidecar(storage, projectSourceDir(job.projectSlug), (sidecar) =>
      sidecar.params.role === "plate" && sidecar.params.prompt === prompt &&
      Array.isArray(sidecar.params.input_images) && sidecar.params.input_images.includes(spec.sourceImage));
    if (existing) return existing.outputs.map((output) => output.path);
  }
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
  if (!plate) throw new ChatServiceError("The clean plate node has no output", 409, "scene_plate_missing");
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
  if (!object) throw new ChatServiceError(`Scene object does not exist: ${node.objectSlug}`, 409, "scene_object_missing");
  const current = await readSceneJob(storage, job.projectSlug, job.id);
  const reference = current.nodes[`reference:${object.slug}`]?.outputs[0];
  if (!reference) throw new ChatServiceError(`Object "${object.name}" has no reference image output`, 409, "scene_reference_missing");

  const identityPath = assetIdentityFile(job.projectSlug, object.slug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    if (identity.kind === "model") {
      const existing = await succeededSidecar(storage, assetDir(job.projectSlug, object.slug), (sidecar) =>
        sidecar.provider === "tripo" && sidecar.params.image === reference &&
        sidecar.model === "v3/generation/image-to-model" &&
        sidecar.params.image_model === (job.tripoImageModel ?? SCENE_MODEL_ID),
      );
      const files = renderablePathsFromResult({ files: existing?.outputs.map((output) => output.path) });
      if (files.length > 0) return files;
    }
  }

  // 队列再次投递时沿用已登记的子任务，不能重新提交付费模型。
  if (currentCloudContext() && current.nodes[node.id]?.taskIds.length) {
    return waitForModelTask(job.projectSlug, current.nodes[node.id]!.taskIds.at(-1)!);
  }
  const task = startTripo3dBatch(
    job.projectSlug,
    [{ slug: object.slug, name: object.name, intent: object.description, sourceImages: [reference] }],
    { tripo3dApiKey: requireRunKey(keys, "tripo3dApiKey"),
      imageModel: job.tripoImageModel ?? sceneModelFor(keys.threeDModel), generationMode: "single" },
  )[0];
  if (!task) throw new ChatServiceError("Could not create the Tripo3D task", 500, "scene_model_task_missing");
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

/**
 * 摆放节点：按参考图把模型摆回世界，并把上游产物一并汇总成自己的输出。
 * 上游（世界 + 全部模型）必须已经成功——`isRunnable` 已经保证了这一点。
 */
async function executePlacementNode(
  storage: AssetStorage,
  job: SceneJob,
  node: SceneJobNode,
): Promise<string[]> {
  const report = await runScenePlacement(storage, job.projectSlug);
  const current = await readSceneJob(storage, job.projectSlug, job.id);
  const upstream = node.dependsOn.flatMap(
    (dependency) => current.nodes[dependency]?.outputs ?? [],
  );
  // 摆放结果本身就是 scene.json，它是最终交付的一部分；与模型/世界产物并集去重。
  // 一个对象都没摆成（例如旧分析没有框）时不把 scene.json 列进产物——那份文件
  // 压根没被写过，列出去等于谎报。
  return report.placed.length > 0
    ? [...new Set([...upstream, report.scenePath])]
    : [...new Set(upstream)];
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
            : running.kind === "placement"
              ? await executePlacementNode(storage, job, running)
              : await executeFinalNode(storage, job, running);
    await updateNode(storage, job, original.id, (node) => ({
      ...node,
      status: "succeeded",
      outputs,
      error: undefined,
    }));
  } catch (error) {
    if (error instanceof CloudTaskPending) {
      await updateNode(storage, job, original.id, (node) => ({ ...node, status: "pending", attempts: Math.max(0, node.attempts - 1) }));
      throw error;
    }
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
  if (!spec) throw new ChatServiceError("Scene spec does not exist", 409, "scene_spec_missing");
  const initial = await readSceneJob(storage, projectSlug, jobId);
  if (initial.specRevision !== spec.revision) {
    throw new ChatServiceError("The scene job does not match the current spec revision", 409, "scene_spec_revision_conflict");
  }

  // 完整新任务仍会在任何付费请求前验证三类凭证；局部重跑只要求它
  // 实际会触及的节点凭证，例如重做 plate/world 不应被 Tripo key 阻塞。
  const unfinishedKinds = new Set(
    Object.values(initial.nodes)
      .filter((node) => !["succeeded", "obsolete"].includes(node.status))
      .map((node) => node.kind),
  );
  try {
    if (unfinishedKinds.has("reference") || unfinishedKinds.has("plate")) {
      requireRunKey(keys, "volcengineApiKey");
    }
    if (unfinishedKinds.has("model")) requireRunKey(keys, "tripo3dApiKey");
    if (unfinishedKinds.has("world")) requireRunKey(keys, "worldLabsApiKey");
  } catch (error) {
    // 父任务会失败，但 get-scene-job 读的是这份记录；不能永远留在 running。
    await mutateSceneJob(storage, projectSlug, jobId, (job) => ({
      ...job, status: "failed", error: toErrorMessage(error),
    }));
    throw error;
  }

  await mutateSceneJob(storage, projectSlug, jobId, (job) => ({ ...job, status: "running", error: undefined,
    tripoImageModel: job.tripoImageModel ?? sceneModelFor(keys.threeDModel),
    ...(currentCloudContext() ? { nodes: Object.fromEntries(Object.entries(job.nodes).map(([id, node]) => [id,
      node.status === "running" ? { ...node, status: "pending", attempts: Math.max(0, node.attempts - 1) } : node])) } : {}),
  }));
  for (;;) {
    const job = await readSceneJob(storage, projectSlug, jobId);
    const activeNodes = Object.values(job.nodes).filter((node) => node.status !== "obsolete");
    const ready = activeNodes.filter((node) => isRunnable(node, job.nodes));
    if (ready.length > 0) {
      if (currentCloudContext()) {
        // 每次队列投递只推进一轮节点；已完成节点保留。
        await executeSceneNode(storage, job, spec, ready[0]!, keys);
        throw new CloudTaskPending(1);
      }
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
      ? failures.map((node) => `${node.id}: ${node.error ?? "unknown error"}`).join("; ")
      : "The scene nodes have a dependency that cannot be unblocked";
    await mutateSceneJob(storage, projectSlug, jobId, (current) => ({
      ...current,
      status: "failed",
      error: message,
    }));
    throw new ChatServiceError(`Full scene generation did not finish: ${message}`, 502, "scene_job_failed");
  }
}

export async function startSceneJobExecution(
  projectSlug: string,
  jobId: string,
  keys: RunKeys,
) {
  const workflowId = `scene-job:${jobId}`;
  const running = currentCloudContext()
    ? (await listTasks(projectSlug)).find((task) => task.workflowId === workflowId && task.status === "running")
    : findRunningTask(projectSlug, workflowId);
  if (running) return running;
  const task = startCustomTask(
    workflowId,
    projectSlug,
    "Complete scene generation",
    async (execution: TaskExecutionContext) => {
      await execution.setPhase("generating");
      return runSceneJob(projectSlug, jobId, keys);
    },
    { cloudOperation: { operation: "scene-job", input: { jobId } } },
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
  // 旧版本创建的 SceneJob 没有 placement 节点：补上它，让老场景也能摆回原位。
  const ensured = ensurePlacementNode(job, spec);
  let current = ensured.changed
    ? await mutateSceneJob(storage, projectSlug, job.id, () => ensured.job)
    : job;
  if (!current.tripoImageModel) {
    const model = sceneModelFor(keys.threeDModel);
    current = await mutateSceneJob(storage, projectSlug, job.id, stored => ({ ...stored, tripoImageModel: model }));
  }
  if (!ensured.changed && current.status === "succeeded" && current.parentTaskId) {
    const completedTask = await getTask(projectSlug, current.parentTaskId);
    if (completedTask?.status === "succeeded") return { job: current, task: completedTask };
  }
  const task = current.status === "failed" || current.status === "paused"
    ? await resumeSceneJob(projectSlug, current.id, keys)
    : await startSceneJobExecution(projectSlug, current.id, keys);
  return { job: await readSceneJob(storage, projectSlug, current.id), task };
}

export async function resumeSceneJob(projectSlug: string, jobId: string, keys: RunKeys) {
  const storage = getAssetStorage();
  const spec = await readSceneSpec(storage, projectSlug);
  await mutateSceneJob(storage, projectSlug, jobId, (job) => {
    const resumed: SceneJob = {
      ...job,
      status: "paused",
      error: undefined,
      tripoImageModel: job.tripoImageModel ?? sceneModelFor(keys.threeDModel),
      nodes: Object.fromEntries(Object.entries(job.nodes).map(([id, node]) => [
        id,
        node.status === "running" || node.status === "failed"
          ? { ...node, status: "pending" as const, error: undefined }
          : node,
      ])),
    };
    return spec ? ensurePlacementNode(resumed, spec).job : resumed;
  });
  return startSceneJobExecution(projectSlug, jobId, keys);
}
