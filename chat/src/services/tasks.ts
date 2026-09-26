import { ChatServiceError, toErrorMessage } from "../common/errors";
import { randomUUID } from "node:crypto";
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
import { runSkyboxGeneration } from "../mastra/tools/skyboxGen";
import { runProjectWorldGeneration } from "../mastra/tools/worldGen";
import { getAssetStorage, readJson, writeJson } from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
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
 */
export const STALLED_TASK_TIMEOUT_MS = 60 * 60_000;

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
      `任务超过 ${Math.round(STALLED_TASK_TIMEOUT_MS / 60_000)} 分钟没有任何进展，已判定卡死。` +
      "供应商侧可能已经完成，先用 resume-generation 凭侧写续跑（不重复付费），再考虑重试。",
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
  assetSlug?: string;
  batchId?: string;
  retry?: GenerationTask["retry"];
}

/** 任何长操作统一任务化：先持久化 queued，再启动 executor。 */
export function startCustomTask(
  kind: string,
  projectSlug: string,
  subject: string,
  executor: (context: TaskExecutionContext) => Promise<unknown>,
  metadata: StartTaskMetadata = {},
): GenerationTask {
  const id = `task-${++taskSeq}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const task: GenerationTask = {
    id,
    workflowId: kind,
    projectSlug,
    subject,
    status: "running",
    phase: "queued",
    bootId: BOOT_ID,
    ...metadata,
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(id, task);
  void persistTask(task)
    .then(() =>
      executor({
        id,
        setPhase: (phase) => updateTask(id, { phase }),
        setAssetSlug: (assetSlug) => updateTask(id, { assetSlug }),
      }),
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
      "项目里没有可生成的对象。文生单物体参考图时请给 generate-reference-images 传 assetSlug，然后直接用同一 slug 启动 3D；完整场景请先用 analyze-reference 获取候选，再把确认选择交给 one-shot-scene Workflow",
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
  const subject = options.mode === "direct" ? "世界生成（World Labs）" : "空环境生成（World Labs）";
  return startCustomTask("world", projectSlug, subject, (context) =>
    runProjectWorldGeneration(
      getAssetStorage(),
      input,
      { apiKey: options.worldLabsApiKey },
      async (assetSlug) => {
        // 身份已提交：推进 publishing 并记录 assetSlug，让重启恢复能识别「已发布但状态未落盘」
        await context.setPhase("publishing");
        await context.setAssetSlug(assetSlug);
      },
    ),
  );
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
  return startCustomTask("skybox", projectSlug, "天空盒生成（Blockade Labs）", (context) =>
    runSkyboxGeneration(
      getAssetStorage(),
      {
        projectSlug,
        skyboxSlug: options.skyboxSlug,
        prompt: options.prompt,
        styleId: options.styleId,
      },
      { apiKey: options.blockadeLabsApiKey },
      async (assetSlug) => {
        await context.setPhase("publishing");
        await context.setAssetSlug(assetSlug);
      },
    ),
  );
}

export async function listTasks(projectSlug?: string): Promise<GenerationTask[]> {
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
                  "本地服务曾在任务运行时中断。供应商侧可能已经完成，" +
                  "先用 resume-generation 凭侧写续跑（不重复付费），再考虑重试",
                updatedAt: new Date().toISOString(),
              };
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
    merged.set(task.id, task);
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTask(
  projectSlug: string,
  id: string,
): Promise<GenerationTask | undefined> {
  const current = tasks.get(id);
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
