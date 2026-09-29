import { createHash, randomUUID } from "node:crypto";
import { ChatServiceError } from "../common/errors";
import {
  projectAnalysisFile,
  projectSceneJobFile,
  projectSceneJobsDir,
  projectSceneSpecFile,
  projectSceneSpecRevisionFile,
} from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import {
  SceneJobSchema,
  SceneSpecRevisionInputSchema,
  SceneSpecSchema,
  type SceneJob,
  type SceneJobNode,
  type SceneSpec,
  type SceneSpecRevisionInput,
} from "../dto/sceneJobs";
import { readJson, writeJson, type AssetStorage } from "./assetStorage";
import { mutateCandidates } from "./candidateRegistry";

const mutationTails = new Map<string, Promise<unknown>>();

function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationTails.set(key, current);
  return current.finally(() => {
    if (mutationTails.get(key) === current) mutationTails.delete(key);
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function sceneInputFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

const referenceNodeId = (slug: string) => `reference:${slug}`;
const modelNodeId = (slug: string) => `model:${slug}`;

function node(
  value: Omit<SceneJobNode, "attempts" | "maxAttempts" | "outputs" | "taskIds" | "updatedAt">,
): SceneJobNode {
  return {
    ...value,
    attempts: 0,
    maxAttempts: 1,
    outputs: [],
    taskIds: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 把场景事实编译成可持久化的生成 DAG。 */
export function buildSceneJobNodes(spec: SceneSpec): Record<string, SceneJobNode> {
  const nodes: Record<string, SceneJobNode> = {};
  for (const object of spec.objects) {
    const referenceId = referenceNodeId(object.slug);
    nodes[referenceId] = node({
      id: referenceId,
      kind: "reference",
      objectSlug: object.slug,
      dependsOn: [],
      status: "pending",
      inputFingerprint: sceneInputFingerprint({
        sourceImage: spec.sourceImage,
        object,
      }),
    });
    const modelId = modelNodeId(object.slug);
    nodes[modelId] = node({
      id: modelId,
      kind: "model",
      objectSlug: object.slug,
      dependsOn: [referenceId],
      status: "blocked",
      inputFingerprint: sceneInputFingerprint({ object, referenceId }),
    });
  }
  nodes.plate = node({
    id: "plate",
    kind: "plate",
    dependsOn: [],
    status: "pending",
    inputFingerprint: sceneInputFingerprint({
      sourceImage: spec.sourceImage,
      objects: spec.objects,
    }),
  });
  nodes.world = node({
    id: "world",
    kind: "world",
    dependsOn: ["plate"],
    status: "blocked",
    inputFingerprint: sceneInputFingerprint({
      sceneDescription: spec.sceneDescription,
      environment: spec.environment,
      objectSlugs: spec.objects.map((object) => object.slug),
      plate: "plate",
    }),
  });
  nodes["final-review"] = node({
    id: "final-review",
    kind: "final-review",
    dependsOn: ["world", ...spec.objects.map((object) => modelNodeId(object.slug))],
    status: "blocked",
    inputFingerprint: sceneInputFingerprint({
      specRevision: spec.revision,
      dependencies: ["world", ...spec.objects.map((object) => modelNodeId(object.slug))],
    }),
  });
  return nodes;
}

async function saveSceneSpec(storage: AssetStorage, spec: SceneSpec): Promise<void> {
  await writeJson(
    storage,
    projectSceneSpecRevisionFile(spec.projectSlug, spec.revision),
    SceneSpecSchema,
    spec,
  );
  await writeJson(storage, projectSceneSpecFile(spec.projectSlug), SceneSpecSchema, spec);
}

export async function readSceneSpec(
  storage: AssetStorage,
  projectSlug: string,
): Promise<SceneSpec | undefined> {
  const path = projectSceneSpecFile(projectSlug);
  return (await storage.exists(path))
    ? readJson(storage, path, SceneSpecSchema)
    : undefined;
}

/** 将一次已确认分析升格为可修订 SceneSpec；同一 run 保持幂等。 */
export async function ensureSceneSpecFromAnalysis(
  storage: AssetStorage,
  projectSlug: string,
): Promise<SceneSpec> {
  return serial(projectSceneSpecFile(projectSlug), async () => {
    const analysisPath = projectAnalysisFile(projectSlug);
    if (!(await storage.exists(analysisPath))) {
      throw new ChatServiceError(
        `项目「${projectSlug}」还没有已确认的场景分析`,
        409,
        "analysis_missing",
      );
    }
    const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
    const sourceImage = analysis.sources[0];
    if (!sourceImage || !(await storage.exists(sourceImage))) {
      throw new ChatServiceError("已确认场景的源图不存在", 409, "source_image_missing");
    }
    if (analysis.objects.length === 0) {
      throw new ChatServiceError("已确认场景没有可生成对象", 409, "no_objects");
    }

    const existing = await readSceneSpec(storage, projectSlug);
    if (
      existing &&
      analysis.confirmation?.runId &&
      existing.sourceAnalysisRunId === analysis.confirmation.runId
    ) {
      return existing;
    }
    const revision = (existing?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    const spec: SceneSpec = {
      schemaVersion: 1,
      projectSlug,
      revision,
      revisionReason: existing ? "用新的已确认场景分析替换" : "从已确认场景分析创建",
      sourceImage,
      ...(analysis.confirmation?.runId
        ? { sourceAnalysisRunId: analysis.confirmation.runId }
        : {}),
      sceneName: analysis.sceneName,
      sceneDescription: analysis.sceneDescription,
      environment: analysis.environment,
      objects: analysis.objects.map(({ slug, name, description }) => ({
        slug,
        name,
        description,
        origin: "analysis" as const,
        addedAtRevision: revision,
      })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await saveSceneSpec(storage, spec);
    return spec;
  });
}

export async function createSceneJob(
  storage: AssetStorage,
  spec: SceneSpec,
): Promise<SceneJob> {
  const now = new Date().toISOString();
  const job: SceneJob = {
    schemaVersion: 1,
    id: randomUUID(),
    projectSlug: spec.projectSlug,
    specRevision: spec.revision,
    status: "paused",
    nodes: buildSceneJobNodes(spec),
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(storage, projectSceneJobFile(spec.projectSlug, job.id), SceneJobSchema, job);
  return job;
}

export async function readSceneJob(
  storage: AssetStorage,
  projectSlug: string,
  jobId: string,
): Promise<SceneJob> {
  const path = projectSceneJobFile(projectSlug, jobId);
  if (!(await storage.exists(path))) {
    throw new ChatServiceError(`场景任务不存在：${jobId}`, 404, "scene_job_not_found");
  }
  return readJson(storage, path, SceneJobSchema);
}

export async function listSceneJobs(
  storage: AssetStorage,
  projectSlug: string,
): Promise<SceneJob[]> {
  const jobs: SceneJob[] = [];
  for (const name of await storage.list(projectSceneJobsDir(projectSlug))) {
    if (!name.endsWith(".json")) continue;
    try {
      jobs.push(await readJson(
        storage,
        `${projectSceneJobsDir(projectSlug)}/${name}`,
        SceneJobSchema,
      ));
    } catch {
      // 单个损坏记录不影响其他场景任务。
    }
  }
  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function mutateSceneJob(
  storage: AssetStorage,
  projectSlug: string,
  jobId: string,
  reducer: (job: SceneJob) => SceneJob | Promise<SceneJob>,
): Promise<SceneJob> {
  const path = projectSceneJobFile(projectSlug, jobId);
  return serial(path, async () => {
    const current = await readSceneJob(storage, projectSlug, jobId);
    const next = SceneJobSchema.parse({
      ...(await reducer(current)),
      updatedAt: new Date().toISOString(),
    });
    await writeJson(storage, path, SceneJobSchema, next);
    return next;
  });
}

function staleNode(previous: SceneJobNode, fingerprint: string): SceneJobNode {
  if (previous.status === "obsolete") return previous;
  return {
    ...previous,
    status: "stale",
    inputFingerprint: fingerprint,
    qa: undefined,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 修订场景事实并精确失效下游：
 * - 新增/删除对象：底板和 world 过期；旧模型不受影响；
 * - 修改对象：该对象参考图和模型过期，底板/world 也重新评估。
 */
export async function reviseSceneSpecAndJob(
  storage: AssetStorage,
  projectSlug: string,
  jobId: string,
  rawInput: SceneSpecRevisionInput,
): Promise<{ spec: SceneSpec; job: SceneJob }> {
  const input = SceneSpecRevisionInputSchema.parse(rawInput);
  const job = await readSceneJob(storage, projectSlug, jobId);
  if (job.status === "running") {
    throw new ChatServiceError(
      "场景任务正在执行，请等当前节点结束后再修订对象清单",
      409,
      "scene_job_running",
    );
  }
  const previous = await readSceneSpec(storage, projectSlug);
  if (!previous || previous.revision !== job.specRevision) {
    throw new ChatServiceError(
      "场景任务与当前场景规格版本不一致，请先选择要继续的任务",
      409,
      "scene_spec_revision_conflict",
    );
  }

  const remove = new Set(input.removeSlugs);
  const updates = new Map(input.updateObjects.map((object) => [object.slug, object]));
  const existing = new Map(previous.objects.map((object) => [object.slug, object]));
  for (const object of input.addObjects) {
    if (existing.has(object.slug)) {
      throw new ChatServiceError(`场景对象已存在：${object.slug}`, 409, "scene_object_exists");
    }
  }
  for (const slug of remove) {
    if (!existing.has(slug)) {
      throw new ChatServiceError(`场景对象不存在：${slug}`, 404, "scene_object_not_found");
    }
  }
  for (const slug of updates.keys()) {
    if (!existing.has(slug)) {
      throw new ChatServiceError(`场景对象不存在：${slug}`, 404, "scene_object_not_found");
    }
  }

  const revision = previous.revision + 1;
  const now = new Date().toISOString();
  const objects = previous.objects
    .filter((object) => !remove.has(object.slug))
    .map((object) => {
      const update = updates.get(object.slug);
      return update ? { ...object, name: update.name, description: update.description } : object;
    })
    .concat(input.addObjects.map((object) => ({
      ...object,
      origin: "added" as const,
      addedAtRevision: revision,
    })));
  if (objects.length === 0) {
    throw new ChatServiceError("场景至少需要保留一个对象", 409, "scene_objects_empty");
  }
  const spec: SceneSpec = {
    ...previous,
    revision,
    revisionReason: input.reason,
    objects,
    updatedAt: now,
  };
  await saveSceneSpec(storage, spec);

  // 让现有的单物体参考图/3D 工具也能看到新增对象。
  await mutateCandidates(storage, projectSlug, async (registry) => {
    const bySlug = new Map(registry.objects.map((object) => [object.slug, object]));
    for (const object of objects) {
      const old = bySlug.get(object.slug);
      bySlug.set(object.slug, {
        slug: object.slug,
        name: object.name,
        description: object.description,
        sourceImages: old?.sourceImages ?? [spec.sourceImage],
        ...(old?.referenceViews ? { referenceViews: old.referenceViews } : {}),
      });
    }
    for (const slug of remove) bySlug.delete(slug);
    return {
      schemaVersion: 1,
      objects: [...bySlug.values()],
      updatedAt: now,
    };
  });

  const nextJob = await mutateSceneJob(storage, projectSlug, jobId, (current) => {
    const nodes = { ...current.nodes };
    for (const slug of remove) {
      for (const id of [referenceNodeId(slug), modelNodeId(slug)]) {
        const previousNode = nodes[id];
        if (previousNode) nodes[id] = { ...previousNode, status: "obsolete", updatedAt: now };
      }
    }
    for (const object of input.addObjects) {
      const referenceId = referenceNodeId(object.slug);
      nodes[referenceId] = node({
        id: referenceId,
        kind: "reference",
        objectSlug: object.slug,
        dependsOn: [],
        status: "pending",
        inputFingerprint: sceneInputFingerprint({ sourceImage: spec.sourceImage, object }),
      });
      const modelId = modelNodeId(object.slug);
      nodes[modelId] = node({
        id: modelId,
        kind: "model",
        objectSlug: object.slug,
        dependsOn: [referenceId],
        status: "blocked",
        inputFingerprint: sceneInputFingerprint({ object, referenceId }),
      });
    }
    for (const object of input.updateObjects) {
      const referenceId = referenceNodeId(object.slug);
      const modelId = modelNodeId(object.slug);
      if (nodes[referenceId]) {
        nodes[referenceId] = staleNode(
          nodes[referenceId],
          sceneInputFingerprint({ sourceImage: spec.sourceImage, object }),
        );
      }
      if (nodes[modelId]) {
        nodes[modelId] = staleNode(
          nodes[modelId],
          sceneInputFingerprint({ object, referenceId }),
        );
      }
    }
    nodes.plate = staleNode(
      nodes.plate!,
      sceneInputFingerprint({ sourceImage: spec.sourceImage, objects: spec.objects }),
    );
    nodes.world = staleNode(
      nodes.world!,
      sceneInputFingerprint({
        sceneDescription: spec.sceneDescription,
        environment: spec.environment,
        objectSlugs: spec.objects.map((object) => object.slug),
        plate: "plate",
      }),
    );
    nodes["final-review"] = staleNode(
      {
        ...nodes["final-review"]!,
        dependsOn: ["world", ...spec.objects.map((object) => modelNodeId(object.slug))],
      },
      sceneInputFingerprint({
        specRevision: spec.revision,
        dependencies: ["world", ...spec.objects.map((object) => modelNodeId(object.slug))],
      }),
    );
    return {
      ...current,
      specRevision: spec.revision,
      status: "paused",
      nodes,
    };
  });
  return { spec, job: nextJob };
}

/**
 * 纯函数：算出"重做指定节点"要失效的节点集合，不触碰存储、不盖时间戳、不修改入参。
 * - 直接指定的节点归入 pending，被牵连的下游归入 stale；
 * - 沿 dependsOn 反向 BFS（遍历所有节点，看谁的 dependsOn 含当前 id）；
 * - obsolete 节点既不失效也不向下传播；指定不存在/已废弃的节点抛
 *   ChatServiceError(404, "scene_node_not_found")；
 * - touched 保证菱形/多路径依赖只出现一次；同样的输入给同样的输出。
 */
export function planNodeInvalidation(
  nodes: Record<string, SceneJobNode>,
  nodeIds: string[],
): { pending: string[]; stale: string[] } {
  const requested = new Set(nodeIds);
  const pending: string[] = [];
  const stale: string[] = [];
  const touched = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const current = nodes[id];
    if (!current || current.status === "obsolete") {
      throw new ChatServiceError(`场景节点不存在或已废弃：${id}`, 404, "scene_node_not_found");
    }
    if (touched.has(id)) continue;
    touched.add(id);
    (requested.has(id) ? pending : stale).push(id);
    for (const candidate of Object.values(nodes)) {
      if (candidate.status !== "obsolete" && candidate.dependsOn.includes(id)) queue.push(candidate.id);
    }
  }
  return { pending, stale };
}

/** 指定节点重做时同时失效它的下游，不动无关分支。 */
export async function retrySceneJobNodes(
  storage: AssetStorage,
  projectSlug: string,
  jobId: string,
  nodeIds: string[],
): Promise<SceneJob> {
  return mutateSceneJob(storage, projectSlug, jobId, (job) => {
    if (job.status === "running") {
      throw new ChatServiceError("场景任务正在执行", 409, "scene_job_running");
    }
    const { pending, stale } = planNodeInvalidation(job.nodes, nodeIds);
    const nodes = { ...job.nodes };
    const invalidate = (id: string, status: "pending" | "stale"): void => {
      const current = nodes[id]!;
      nodes[id] = {
        ...current,
        status,
        qa: undefined,
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
    };
    for (const id of pending) invalidate(id, "pending");
    for (const id of stale) invalidate(id, "stale");
    return { ...job, status: "paused", nodes };
  });
}
