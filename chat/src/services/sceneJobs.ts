import { createHash, randomUUID } from "node:crypto";
import { ChatServiceError } from "../common/errors";
import {
  projectAnalysisFile,
  projectSceneJobFile,
  projectSceneJobsDir,
  projectSceneSpecFile,
  projectSceneSpecRevisionFile,
  projectTaskFile,
} from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import { GenerationTaskSchema } from "../dto/tasks";
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

function serial<T>(storage: AssetStorage, key: string, operation: () => Promise<T>): Promise<T> {
  if (storage.withLock) return storage.withLock(key, operation);
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

/**
 * 摆放节点的依赖：世界（地面/尺度基准）与全部模型（要量每个模型的包围盒）。
 * 单独抽出来是因为修订路径与旧任务回填都要用同一个定义。
 */
function placementDependencies(spec: Pick<SceneSpec, "objects">): string[] {
  return ["world", ...spec.objects.map((object) => modelNodeId(object.slug))];
}

function placementFingerprint(spec: SceneSpec): string {
  return sceneInputFingerprint({
    specRevision: spec.revision,
    sourceImage: spec.sourceImage,
    camera: spec.camera ?? null,
    // 框与高度是摆放的全部输入；对象顺序无关，所以按 slug 排序后再算。
    boxes: [...spec.objects]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((object) => [object.slug, object.box ?? null, object.heightMeters ?? null]),
    dependencies: placementDependencies(spec),
  });
}

/** 摆放节点（免费、纯本地计算）：世界与全部模型就绪后按参考图把家具摆回原位。 */
function placementNode(spec: SceneSpec): SceneJobNode {
  return node({
    id: "placement",
    kind: "placement",
    dependsOn: placementDependencies(spec),
    status: "blocked",
    inputFingerprint: placementFingerprint(spec),
  });
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
  // 摆放是纯本地计算（免费）：世界与全部模型就绪后按参考图把家具摆回原位。
  nodes.placement = placementNode(spec);
  // 交付汇总只依赖摆放：摆放的输出里已经含世界与全部模型产物，另加 scene.json。
  nodes["final-review"] = node({
    id: "final-review",
    kind: "final-review",
    dependsOn: ["placement"],
    status: "blocked",
    inputFingerprint: sceneInputFingerprint({
      specRevision: spec.revision,
      dependencies: ["placement"],
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
  return serial(storage, projectSceneSpecFile(projectSlug), async () => {
    const analysisPath = projectAnalysisFile(projectSlug);
    if (!(await storage.exists(analysisPath))) {
      throw new ChatServiceError(
        `Project "${projectSlug}" has no confirmed scene analysis yet`,
        409,
        "analysis_missing",
      );
    }
    const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
    const sourceImage = analysis.sources[0];
    if (!sourceImage || !(await storage.exists(sourceImage))) {
      throw new ChatServiceError("The source image of the confirmed scene does not exist", 409, "source_image_missing");
    }
    if (analysis.objects.length === 0) {
      throw new ChatServiceError("The confirmed scene has no generatable object", 409, "no_objects");
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
      revisionReason: existing ? "Replaced by a new confirmed scene analysis" : "Created from the confirmed scene analysis",
      sourceImage,
      ...(analysis.confirmation?.runId
        ? { sourceAnalysisRunId: analysis.confirmation.runId }
        : {}),
      sceneName: analysis.sceneName,
      sceneDescription: analysis.sceneDescription,
      environment: analysis.environment,
      // box / heightMeters 是摆放（placement 节点）的输入，必须穿过升格这一步。
      objects: analysis.objects.map(({ slug, name, description, box, heightMeters }) => ({
        slug,
        name,
        description,
        ...(box ? { box } : {}),
        ...(heightMeters ? { heightMeters } : {}),
        origin: "analysis" as const,
        addedAtRevision: revision,
      })),
      ...(analysis.camera ? { camera: analysis.camera } : {}),
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
    throw new ChatServiceError(`Scene job does not exist: ${jobId}`, 404, "scene_job_not_found");
  }
  return withParentFailure(storage, await readJson(storage, path, SceneJobSchema));
}

/** 旧版本可能只把父任务标失败；读取时恢复真实状态，使历史任务也能被修订。 */
async function withParentFailure(storage: AssetStorage, job: SceneJob): Promise<SceneJob> {
  if (job.status !== "running" || !job.parentTaskId) return job;
  const path = projectTaskFile(job.projectSlug, job.parentTaskId);
  if (!(await storage.exists(path))) return job;
  const parent = await readJson(storage, path, GenerationTaskSchema);
  return parent.status === "failed"
    ? { ...job, status: "failed", error: parent.error ?? "Parent scene task failed", updatedAt: parent.updatedAt }
    : job;
}

export async function listSceneJobs(
  storage: AssetStorage,
  projectSlug: string,
): Promise<SceneJob[]> {
  const jobs: SceneJob[] = [];
  for (const name of await storage.list(projectSceneJobsDir(projectSlug))) {
    if (!name.endsWith(".json")) continue;
    try {
      jobs.push(await withParentFailure(storage, await readJson(
        storage,
        `${projectSceneJobsDir(projectSlug)}/${name}`,
        SceneJobSchema,
      )));
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
  return serial(storage, path, async () => {
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
    taskIds: [],
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
      "The scene job is running; wait for the current node to finish before revising the object list",
      409,
      "scene_job_running",
    );
  }
  const previous = await readSceneSpec(storage, projectSlug);
  if (!previous || previous.revision !== job.specRevision) {
    throw new ChatServiceError(
      "The scene job does not match the current scene spec revision; first choose which job to continue",
      409,
      "scene_spec_revision_conflict",
    );
  }

  const remove = new Set(input.removeSlugs);
  const updates = new Map(input.updateObjects.map((object) => [object.slug, object]));
  const existing = new Map(previous.objects.map((object) => [object.slug, object]));
  for (const object of input.addObjects) {
    if (existing.has(object.slug)) {
      throw new ChatServiceError(`Scene object already exists: ${object.slug}`, 409, "scene_object_exists");
    }
  }
  for (const slug of remove) {
    if (!existing.has(slug)) {
      throw new ChatServiceError(`Scene object does not exist: ${slug}`, 404, "scene_object_not_found");
    }
  }
  for (const slug of updates.keys()) {
    if (!existing.has(slug)) {
      throw new ChatServiceError(`Scene object does not exist: ${slug}`, 404, "scene_object_not_found");
    }
  }

  const revision = previous.revision + 1;
  const now = new Date().toISOString();
  const objects = previous.objects
    .filter((object) => !remove.has(object.slug))
    .map((object) => {
      const update = updates.get(object.slug);
      // 修订也可以补一个原本缺失的 box（旧分析没有框时唯一的补救入口）。
      return update
        ? {
            ...object,
            name: update.name,
            description: update.description,
            ...(update.box ? { box: update.box } : {}),
            ...(update.heightMeters ? { heightMeters: update.heightMeters } : {}),
          }
        : object;
    })
    .concat(input.addObjects.map((object) => ({
      ...object,
      origin: "added" as const,
      addedAtRevision: revision,
    })));
  if (objects.length === 0) {
    throw new ChatServiceError("A scene must keep at least one object", 409, "scene_objects_empty");
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
        ...(object.box ? { box: object.box } : {}),
        ...(object.heightMeters ? { heightMeters: object.heightMeters } : {}),
        sourceImages: old?.sourceImages ?? [spec.sourceImage],
        ...(old?.referenceViews ? { referenceViews: old.referenceViews } : {}),
        /*
          新增对象才算"本会话登记"；已有对象保留它原来的 createdAt（拿不到就用注册表
          的 updatedAt——那一定早于本会话，于是不会被新会话继承，符合预期）。
        */
        createdAt: old?.createdAt ?? registry.updatedAt,
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
    // 场景事实变了（对象增删、描述或框变化），摆放必须按新事实重算：
    // 新增/修好的家具要重新摆位，被删对象的摆放不该留在场景里。
    nodes.placement = staleNode(
      {
        ...(nodes.placement ?? placementNode(spec)),
        dependsOn: placementDependencies(spec),
      },
      placementFingerprint(spec),
    );
    nodes["final-review"] = staleNode(
      {
        ...nodes["final-review"]!,
        dependsOn: ["placement"],
      },
      sceneInputFingerprint({
        specRevision: spec.revision,
        dependencies: ["placement"],
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
 * 把"摆放"节点补进一个已经存在的 SceneJob。
 *
 * `placement` 是后加的节点，磁盘上早先创建的 SceneJob 里没有它。恢复执行前补齐，
 * 老场景才会跟着新流程一起把家具摆回原位，而不必重新跑一遍付费生成。
 * 已经存在时只校正依赖与指纹（修订路径会改对象清单）。返回是否做过改动。
 */
export function ensurePlacementNode(
  job: SceneJob,
  spec: SceneSpec,
): { job: SceneJob; changed: boolean } {
  const dependencies = placementDependencies(spec);
  const existing = job.nodes.placement;
  const dependenciesMatch =
    existing !== undefined &&
    existing.dependsOn.length === dependencies.length &&
    existing.dependsOn.every((id, index) => id === dependencies[index]);
  if (existing && dependenciesMatch) return { job, changed: false };
  const nodes = { ...job.nodes };
  nodes.placement = existing
    ? staleNode({ ...existing, dependsOn: dependencies }, placementFingerprint(spec))
    : placementNode(spec);
  // final-review 的产物要包含 scene.json，所以它必须跟着重算一遍（只是汇总，免费）。
  const finalReview = nodes["final-review"];
  if (finalReview) {
    nodes["final-review"] = staleNode(
      { ...finalReview, dependsOn: ["placement"] },
      sceneInputFingerprint({
        specRevision: spec.revision,
        dependencies: ["placement"],
      }),
    );
  }
  return { job: { ...job, nodes }, changed: true };
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
      throw new ChatServiceError(`Scene node does not exist or is obsolete: ${id}`, 404, "scene_node_not_found");
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
      throw new ChatServiceError("The scene job is running", 409, "scene_job_running");
    }
    const { pending, stale } = planNodeInvalidation(job.nodes, nodeIds);
    const nodes = { ...job.nodes };
    const invalidate = (id: string, status: "pending" | "stale"): void => {
      const current = nodes[id]!;
      nodes[id] = {
        ...current,
        status,
        taskIds: [],
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
