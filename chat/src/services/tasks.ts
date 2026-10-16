import { ChatServiceError, toErrorMessage } from "../common/errors";
import { randomUUID } from "node:crypto";
import { currentCloudContext, type CloudOperation } from "../cloud/context";
import { runWithTaskPump, taskPumpStatus, tickTaskPumps } from "../common/taskPump";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectTaskFile,
  projectTasksDir,
} from "../common/libraryPaths";
import { SceneAnalysisSchema } from "../dto/library";
import { GenerationTaskSchema, type GenerationTask } from "../dto/tasks";
import { getProjectState } from "../mastra/tools/projectTools";
import {
  resumableSidecarForTask,
  resumeGeneration,
} from "../mastra/tools/resumeGeneration";
import { runSkyboxGeneration } from "../mastra/tools/skyboxGen";
import { runProjectWorldGeneration } from "../mastra/tools/worldGen";
import { serverResumeKeys } from "../config";
import { getAssetStorage, readJson, writeJson } from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import { mutateSceneJob, readSceneJob } from "./sceneJobs";
import { refreshBlenderTasks, BLENDER_TASK_WORKFLOW } from "./blenderTasks";
import {
  type GenerationObject,
} from "./modelPublishing";

/** 内存表负责即时通知；projects/<slug>/tasks/*.json 是跨重启的任务事实。 */
const tasks = new Map<string, GenerationTask>();
let taskSeq = 0;

/**
 * 本进程的身份。挂在 globalThis 上：`bun --hot` 只替换模块、保留全局对象，所以热重载
 * 后它不变，真正的进程重启才会换新。用来区分「服务重启」（任务确实丢了）和「开发时
 * 改了代码导致模块重载」（executor 还活着，只是内存表被重建）。
 *
 * 2026-09-26：热重载清空内存表，三个还在跑的任务被误判为「服务中断」，Agent 据此把
 * 供应商侧早已完成的付费任务又提交了一遍。任务记录带上进程身份后就不会再误判。
 */
const BOOT_ID: string = (() => {
  const holder = globalThis as { __chatspaceBootId?: string };
  holder.__chatspaceBootId ??= randomUUID();
  return holder.__chatspaceBootId;
})();

/**
 * 卡死看门狗：同进程内的任务如果一直没有任何进展，`listTasks` 的「服务曾中断」判定
 * 永远发现不了它——2026-09-26 的 Tripo 批量任务就挂在 running/generating 近两小时，
 * 供应商侧其实早已成功。出网请求现在都有超时，这里再兜一层：静默超过这个时长即判失败。
 * 预算取 60 分钟，高于任何一条供应商轮询 deadline（最长 30 分钟）加上产物下载的合法耗时。
 *
 * ⚠️ 它自己也是**时钟驱动**的，所以只治「任务在动但没进展」，治不了「进程的定时器/时钟整体卡死」：
 * 2026-10-02 的 Tripo 贴图任务就是这样——供应商 43 秒就做完了，本机进程的 `Date` 头停在提交那一秒
 * 十几分钟不动（同机 Vite/DSH 的时间都正常），10 秒轮询的 sleep、15 分钟的 deadline、这条 60 分钟
 * 看门狗**一个都没醒**，任务文件连一个字节都没改。这种卡死只能靠**重启服务**后由上面那段
 * 「服务曾在任务运行时中断」的判定收尾，再凭侧写 resume 把已付费的产物拉回来。进程内无解，
 * 不要再试图用更短的超时来兜它。
 */
export const STALLED_TASK_TIMEOUT_MS = 60 * 60_000;

/**
 * 「还在跑、但一直没有进展」的**可见**口径：90 秒。
 *
 * 2026-10-03 的事故里，16 个已付费任务的文件停在提交那一毫秒十几分钟，而唯一的判据是
 * 上面那条 60 分钟的「卡死」——期间看板、Agent、用户看到的一切都是"正常等待"。
 * 90 秒足够把「供应商慢」（轮询间隔 10 秒）和「没人推了」分开，所以它不是失败判据：
 * 任务照旧 running，只是多带一个读时派生的 `stall` 字段（见 dto/tasks.ts），
 * 而 `GET /api/tasks` 那条路径本身就会顺手把它推着走（`tickTaskPumps`）。
 */
export const STALLED_TASK_WARN_MS = 90_000;

/**
 * 读时派生 `stall`：running 且静默超过 `STALLED_TASK_WARN_MS` 才带上，不落盘。
 * `pumpActive` 是关键分野——进程里还有闸门照看它，说明下一次外部 tick 就能推动；
 * 没有闸门（进程重启过、或链路整条丢了）就只能靠续跑/重试。
 */
function withStallDiagnostics(task: GenerationTask, now: number): GenerationTask {
  if (task.status !== "running") {
    return task.stall ? { ...task, stall: undefined } : task;
  }
  const updated = Date.parse(task.updatedAt);
  const silentForMs = Number.isFinite(updated) ? Math.max(0, now - updated) : 0;
  if (silentForMs <= STALLED_TASK_WARN_MS) return task;
  return {
    ...task,
    stall: { silentForMs, pumpActive: taskPumpStatus(task.id, now) !== undefined },
  };
}

/** 运行中但长期没有更新的任务 → 判定卡死；未卡死返回 undefined。 */
function asStalledFailure(task: GenerationTask): GenerationTask | undefined {
  if (task.status !== "running") return undefined;
  const updated = Date.parse(task.updatedAt);
  if (!Number.isFinite(updated)) return undefined;
  if (Date.now() - updated <= STALLED_TASK_TIMEOUT_MS) return undefined;
  return {
    ...task,
    status: "failed",
    phase: "failed",
    error:
      `Task made no progress for more than ${Math.round(STALLED_TASK_TIMEOUT_MS / 60_000)} minutes and was declared stalled. ` +
      "The provider may already have finished; first resume from the sidecar with resume-generation (no duplicate charge), then consider retrying.",
    updatedAt: new Date().toISOString(),
  };
}

/** 同一项目的长流程仍在运行时复用其任务，避免重复提交付费请求。 */
export function findRunningTask(projectSlug: string, workflowId: string): GenerationTask | undefined {
  return [...tasks.values()].find(
    (task) => task.projectSlug === projectSlug && task.workflowId === workflowId && task.status === "running",
  );
}

async function persistTask(task: GenerationTask): Promise<void> {
  await writeJson(
    getAssetStorage(),
    projectTaskFile(task.projectSlug, task.id),
    GenerationTaskSchema,
    task,
  );
}

async function updateTask(id: string, patch: Partial<GenerationTask>): Promise<void> {
  const current = tasks.get(id);
  if (!current) return;
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  tasks.set(id, updated);
  await persistTask(updated);
}

export interface TaskExecutionContext {
  id: string;
  setPhase: (phase: GenerationTask["phase"]) => Promise<void>;
  /** 身份提交后回写 assetSlug，让重启恢复能识别「已发布但任务状态未落盘」的崩溃窗口 */
  setAssetSlug: (assetSlug: string) => Promise<void>;
}

interface StartTaskMetadata {
  cloudOperation?: CloudOperation;
  assetSlug?: string;
  batchId?: string;
  retry?: GenerationTask["retry"];
  /** 续跑任务的来源侧写；重启自动续跑与路由共用，用来判重 */
  resumeSidecar?: string;
}

/** 任何长操作统一任务化：先持久化 queued，再启动 executor。 */
export function startCustomTask(
  kind: string,
  projectSlug: string,
  subject: string,
  executor: (context: TaskExecutionContext) => Promise<unknown>,
  metadata: StartTaskMetadata = {},
): GenerationTask {
  const cloud = currentCloudContext();
  if (cloud?.capture) {
    cloud.capture.executor = executor;
    return cloud.capture.task;
  }
  const { cloudOperation, ...publicMetadata } = metadata;
  const operation = cloudOperation ?? (metadata.retry ? { operation: "3d", input: { retry: metadata.retry } } : undefined);
  if (cloud && !operation) throw new ChatServiceError(`This operation does not support browser tasks yet: ${kind}`, 409, "browser_operation_unsupported");
  const id = cloud ? `task-${randomUUID()}` : `task-${++taskSeq}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const task: GenerationTask = {
    id,
    workflowId: kind,
    projectSlug,
    subject,
    status: "running",
    phase: "queued",
    bootId: BOOT_ID,
    ...publicMetadata,
    createdAt: now,
    updatedAt: now,
  };
  if (cloud) {
    cloud.pending.push(cloud.enqueue(task, operation!));
    return task;
  }
  tasks.set(id, task);
  // 闸门必须**先于 executor** 建立：executor 里的每一次等待都要能认出自己的闸门，
  // 这样本进程定时器停摆时，工作台每秒一次的 GET /api/tasks 仍能把链路推着走
  // （见 common/taskPump.ts 的事故记录）。
  void runWithTaskPump(id, projectSlug, () =>
    persistTask(task).then(() =>
      executor({
        id,
        setPhase: (phase) => updateTask(id, { phase }),
        setAssetSlug: (assetSlug) => updateTask(id, { assetSlug }),
      }),
    ),
  )
    .then((result) => updateTask(id, { status: "succeeded", phase: "completed", result }))
    .catch((error) =>
      updateTask(id, {
        status: "failed",
        phase: "failed",
        error: toErrorMessage(error),
      }),
    );
  return task;
}

/** 正式资产与尚未发布的 analysis 候选共同组成可生成对象。 */
export async function resolve3dObjects(
  projectSlug: string,
  assetSlugs?: string[],
): Promise<GenerationObject[]> {
  const storage = getAssetStorage();
  const state = await getProjectState(storage, projectSlug);
  const analysisPath = projectAnalysisFile(projectSlug);
  const analyzed = (await storage.exists(analysisPath))
    ? (await readJson(storage, analysisPath, SceneAnalysisSchema)).objects
    : [];
  const candidates = (await readCandidates(storage, projectSlug)).objects;
  const bySlug = new Map<string, GenerationObject>();

  // 历史 analysis 对象与新 candidates 目标都可生成；同 slug 时显式候选覆盖分析草稿。
  for (const candidate of [...analyzed, ...candidates]) {
    bySlug.set(candidate.slug, {
      slug: candidate.slug,
      name: candidate.name,
      intent: candidate.description,
      sourceImages: candidate.sourceImages ?? [],
      ...(candidate.referenceViews ? { referenceViews: candidate.referenceViews } : {}),
    });
  }
  // 正式资产最后写入、优先级最高：analysis.json 在资产发布后从不清理，会残留旧的
  // sourceImages（编辑参考图只更新 asset.json 不动 analysis.json），若让草稿覆盖正式
  // 资产，「改参考图 → 重新 start-3d-batch」会退回用旧图。
  for (const asset of state.assets) {
    if (asset.identity?.kind !== "model") continue;
    bySlug.set(asset.slug, {
      slug: asset.slug,
      name: asset.identity.name,
      intent: asset.identity.intent,
      sourceImages: asset.identity.sourceImages,
      ...(asset.identity.referenceViews ? { referenceViews: asset.identity.referenceViews } : {}),
    });
  }

  const objects = assetSlugs
    ? assetSlugs
        .map((slug) => bySlug.get(slug))
        .filter((object): object is GenerationObject => Boolean(object))
    : [...bySlug.values()];
  if (objects.length === 0) {
    throw new ChatServiceError(
      "The project has no generatable object. For a text-to-single-object reference image, pass assetSlug to generate-reference-images and then start 3D with the same slug directly; for a full scene, first use analyze-reference to get candidates, then hand the confirmed selection to start-scene-job",
      409,
      "no_objects",
    );
  }
  return objects;
}

export function startWorldTask(
  projectSlug: string,
  options: { worldLabsApiKey: string } & (
    | { mode: "direct"; sourceImage?: string | null; prompt?: string }
    | { mode?: "empty-environment"; sourceImage?: string | null; extraPrompt?: string }
  ),
): GenerationTask {
  const input = options.mode === "direct"
    ? { projectSlug, mode: options.mode, sourceImage: options.sourceImage, prompt: options.prompt }
    : { projectSlug, mode: "empty-environment" as const, sourceImage: options.sourceImage, extraPrompt: options.extraPrompt };
  const subject = options.mode === "direct" ? "World generation (World Labs)" : "Empty environment generation (World Labs)";
  return startCustomTask("world", projectSlug, subject, async (context) => {
    // 一开工就离开 queued：世界生成是长轮询，phase 必须能一路看见。
    await context.setPhase("generating");
    return runProjectWorldGeneration(
      getAssetStorage(),
      input,
      {
        apiKey: options.worldLabsApiKey,
        // 每次轮询都刷新一次任务：进度可见，卡死看门狗也能区分「在动」和「没动」。
        onStatus: () => context.setPhase("generating"),
      },
      async (assetSlug) => {
        // 身份已提交：推进 publishing 并记录 assetSlug，让重启恢复能识别「已发布但状态未落盘」
        await context.setPhase("publishing");
        await context.setAssetSlug(assetSlug);
      },
      (phase) => context.setPhase(phase),
    );
  }, { cloudOperation: { operation: "world", input } });
}

export function startSkyboxTask(
  projectSlug: string,
  options: {
    blockadeLabsApiKey: string;
    prompt: string;
    styleId?: number;
    skyboxSlug?: string;
  },
): GenerationTask {
  return startCustomTask("skybox", projectSlug, "Skybox generation (Blockade Labs)", async (context) => {
    await context.setPhase("generating");
    return runSkyboxGeneration(
      getAssetStorage(),
      {
        projectSlug,
        skyboxSlug: options.skyboxSlug,
        prompt: options.prompt,
        styleId: options.styleId,
      },
      {
        apiKey: options.blockadeLabsApiKey,
        onStatus: () => context.setPhase("generating"),
      },
      async (assetSlug) => {
        await context.setPhase("publishing");
        await context.setAssetSlug(assetSlug);
      },
      (phase) => context.setPhase(phase),
    );
  });
}

/**
 * 凭侧写续跑（不重新提交、不重复付费）。HTTP 路由与「重启自动续跑」共用这一条。
 */
export function startResumeTask(projectSlug: string, sidecarPath: string): GenerationTask {
  return startCustomTask(
    "resume",
    projectSlug,
    `Resume: ${sidecarPath.split("/").pop()}`,
    async (context) => {
      // 续跑同样是长流程（轮询 + 下载几十 MB）：报阶段，别让看板只看到 queued。
      await context.setPhase("generating");
      return resumeGeneration(
        getAssetStorage(),
        sidecarPath,
        serverResumeKeys(),
        (phase) => context.setPhase(phase),
      );
    },
    { resumeSidecar: sidecarPath, cloudOperation: { operation: "resume", input: { sidecarPath } } },
  );
}

/**
 * 已经自动接上续跑的任务记录（本进程内）。判重放在 `await` **之前**同步占位，
 * 因为工作台 1 Hz 的读路径与 Agent 的工具调用可能并发走到同一份 running 记录，
 * 各起一个续跑会让同一份产物被下载/发布两次。
 */
const autoResumedTasks = new Set<string>();

export async function listTasks(projectSlug?: string): Promise<GenerationTask[]> {
  // 浏览器任务由独立 worker 执行；当前请求的 bootId/内存表不能判断它是否中断。
  if (currentCloudContext()) {
    const storage = getAssetStorage();
    const projects = projectSlug ? [projectSlug] : await storage.list("projects");
    const found: GenerationTask[] = [];
    for (const project of projects) {
      for (const name of await storage.list(projectTasksDir(project))) {
        if (!name.endsWith(".json")) continue;
        found.push(await readJson(storage, `${projectTasksDir(project)}/${name}`, GenerationTaskSchema));
      }
    }
    const refreshed = await refreshBlenderTasks(storage, found);
    const stale = refreshed.filter((task) => task.workflowId !== BLENDER_TASK_WORKFLOW && task.status === "running" && Date.now() - Date.parse(task.updatedAt) > STALLED_TASK_WARN_MS);
    if (stale.length) {
      const activeIds = await currentCloudContext()!.activeTaskIds?.() ?? new Set<string>();
      for (const task of stale) task.stall = { silentForMs: Date.now() - Date.parse(task.updatedAt), pumpActive: activeIds.has(task.id) };
    }
    return refreshed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  // **外部时钟**：工作台每 1 秒调一次这个接口（useTaskPolling），那条心跳来自浏览器进程，
  // 与本进程定时器的死活无关。生成链路的等待由它放行、超预算的在飞请求由它中止。
  // 放在这里而不是路由里：读任务列表的每一条路径（路由、Agent 工具、测试）都该推动任务。
  tickTaskPumps(projectSlug);
  const merged = new Map<string, GenerationTask>();
  if (projectSlug) {
    for (const name of await getAssetStorage().list(projectTasksDir(projectSlug))) {
      if (!name.endsWith(".json")) continue;
      try {
        let task = await readJson(
          getAssetStorage(),
          `${projectTasksDir(projectSlug)}/${name}`,
          GenerationTaskSchema,
        );
        if (task.status === "running" && !tasks.has(task.id)) {
          // 同进程热重载（bun --hot 改了代码）：executor 还活着，只是内存表被重建，
          // 认领回内存表即可，绝不能当成「服务中断」——误判会让 Agent 重新提交付费请求。
          if (task.bootId === BOOT_ID) {
            tasks.set(task.id, task);
            merged.set(task.id, task);
            continue;
          }
          const storage = getAssetStorage();
          if (task.workflowId.startsWith("scene-job:")) {
            const jobId = task.workflowId.slice("scene-job:".length);
            try {
              const job = await readSceneJob(storage, task.projectSlug, jobId);
              if (job.status === "succeeded") {
                task = {
                  ...task,
                  status: "succeeded",
                  phase: "completed",
                  result: {
                    jobId,
                    specRevision: job.specRevision,
                    outputs: job.nodes["final-review"]?.outputs ?? [],
                  },
                  updatedAt: new Date().toISOString(),
                };
              } else {
                await mutateSceneJob(storage, task.projectSlug, jobId, (current) => ({
                  ...current,
                  status: "paused",
                  nodes: Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [
                    id,
                    node.status === "running"
                      ? { ...node, status: "pending" as const, error: undefined }
                      : node,
                  ])),
                }));
                task = {
                  ...task,
                  status: "failed",
                  phase: "failed",
                  error:
                    "The local service was interrupted while the scene job was running. Node state has been preserved; " +
                    "resume the same SceneJob, do not rebuild the nodes that already finished",
                  updatedAt: new Date().toISOString(),
                };
              }
              await persistTask(task);
              merged.set(task.id, task);
              continue;
            } catch {
              // 损坏/缺失的 SceneJob 回退到下面通用中断判定。
            }
          }
          const identityPublished =
            task.phase === "publishing" &&
            task.assetSlug &&
            (await storage.exists(assetIdentityFile(task.projectSlug, task.assetSlug)));
          // 模型任务还需可渲染模型文件已落盘；world/skybox 的身份提交本身就是发布成功信号。
          const publishedModels =
            identityPublished && task.workflowId !== "world" && task.workflowId !== "skybox"
              ? (await storage.list(assetDir(task.projectSlug, task.assetSlug!)))
                  .filter((file) => /\.(?:glb|gltf|obj|fbx)$/i.test(file))
                  .map((file) => `${assetDir(task.projectSlug, task.assetSlug!)}/${file}`)
              : [];
          const recovered =
            (task.workflowId === "world" || task.workflowId === "skybox")
              ? identityPublished
              : publishedModels.length > 0;
          task = recovered
            ? {
                ...task,
                status: "succeeded",
                phase: "completed",
                result: publishedModels.length > 0
                  ? { model: publishedModels[0], files: publishedModels }
                  : undefined,
                updatedAt: new Date().toISOString(),
              }
            : {
                ...task,
                status: "failed",
                phase: "failed",
                error:
                  "The local service was interrupted while the task was running. The provider may already have finished; " +
                  "first resume from the sidecar with resume-generation (no duplicate charge), then consider retrying",
                updatedAt: new Date().toISOString(),
              };
          // **重启自愈**：进程重启不该让用户去点"续跑"。侧写里有 providerTaskId
          // （已提交 = 已付费）就直接接着轮询，不重新提交。没有 providerTaskId 的
          // 侧写不算可续跑——续跑它等于重新付费，必须由用户/Agent 决定。
          if (task.status === "failed" && !autoResumedTasks.has(task.id)) {
            autoResumedTasks.add(task.id);
            try {
              const resumable = await resumableSidecarForTask(
                storage,
                task.projectSlug,
                task.id,
              );
              if (resumable) {
                const resumeTask = startResumeTask(task.projectSlug, resumable.sidecarPath);
                task = {
                  ...task,
                  error:
                    "The local service was interrupted while the task was running; it has been resumed automatically from the sidecar (no duplicate charge), " +
                    `resume task ${resumeTask.id}`,
                };
              }
            } catch (error) {
              // 自动续跑失败不该让任务列表读不出来：任务照旧是 failed，人工可再续跑。
              autoResumedTasks.delete(task.id);
              task = { ...task, error: `${task.error ?? ""} (automatic resume did not start: ${toErrorMessage(error)})` };
            }
          }
          await persistTask(task);
        }
        merged.set(task.id, task);
      } catch {
        // 单个损坏任务不应拖垮整个项目任务列表。
      }
    }
  }
  for (const task of tasks.values()) {
    if (projectSlug && task.projectSlug !== projectSlug) continue;
    // 同进程内的卡死只能在这里发现：磁盘上仍是 running，重启判定不会触发。
    const stalled = asStalledFailure(task);
    if (stalled) {
      tasks.set(stalled.id, stalled);
      await persistTask(stalled);
      merged.set(stalled.id, stalled);
      continue;
    }
    /*
      **磁盘上更新的那一份必须赢**。内存表不是权威：写盘路径不止这一张表。

      2026-10-06 本机就是反例：`bun --hot` 重建模块后，老实例里还活着的 executor 在
      自己的表上把世界任务写成 succeeded 并落盘，而新实例的 `listTasks` 只把磁盘上那条
      running 认领回内存（上面 bootId 分支）。此后的每次读都被内存里的旧快照盖住——
      接口一直报 05:44:40 running，磁盘上其实是 05:47:22 succeeded，而且 stall 诊断还会
      说 `pumpActive=false`（根本没有执行者在照看它），用户看到的就是"已经生成完的世界
      永远卡在生成中"。

      判据用 `updatedAt`：GenerationTaskSchema 收的是 ISO 时间串，同格式可直接比大小。
    */
    const fromDisk = merged.get(task.id);
    if (fromDisk && fromDisk.updatedAt > task.updatedAt) {
      tasks.set(fromDisk.id, fromDisk);
      merged.set(fromDisk.id, fromDisk);
      continue;
    }
    merged.set(task.id, task);
  }
  const now = Date.now();
  return [...merged.values()]
    .map((task) => withStallDiagnostics(task, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTask(
  projectSlug: string,
  id: string,
): Promise<GenerationTask | undefined> {
  const current = currentCloudContext() ? undefined : tasks.get(id);
  if (current?.projectSlug === projectSlug) return current;
  const path = projectTaskFile(projectSlug, id);
  return (await getAssetStorage().exists(path))
    ? readJson(getAssetStorage(), path, GenerationTaskSchema)
    : undefined;
}

/** 测试用。 */
export function clearTasks(): void {
  tasks.clear();
}
