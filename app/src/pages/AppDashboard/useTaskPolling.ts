import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { taskSubjectLabel } from "../../shared/lib/taskText";
import {
  listTasks,
  type GenerationTask,
} from "../../shared/lib/workflowClient";
import type { AgentActivity, ChatMessage } from "../../widgets/AgentDock";

interface UseTaskPollingOptions {
  projectSlug: string;
  /** 任务在项目内推进，完成消息只属于显式登记它的会话。 */
  sessionId?: string;
  /** 先恢复会话，再允许轮询写入完成消息，避免抢占恢复窗口。 */
  enabled?: boolean;
  assets: LibraryAsset[];
  pushAssistant: (content: string, images?: string[]) => string;
  updateMessage: (id: string, updater: (message: ChatMessage) => ChatMessage) => void;
  setActivity: (activity: AgentActivity) => void;
  bumpRefresh: () => void;
}

export interface TaskSettlement {
  tasks: GenerationTask[];
}

type TaskSettledCallback = (settlement: TaskSettlement) => void;

const PREVIEWABLE_MODEL_RE = /\.(?:glb|gltf|obj|fbx)$/i;
/** 本地任务列表开销很小；1 秒轮询让产物发布后的卡片接近即时进入场景。 */
const TASK_POLL_INTERVAL_MS = 1_000;

/** 各 3D 供应商的异步结果形状不同，统一取出可被当前视口渲染的主模型路径。 */
export function modelPathFromTaskResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { model?: unknown; files?: unknown };
  if (typeof record.model === "string" && PREVIEWABLE_MODEL_RE.test(record.model)) {
    return record.model;
  }
  if (!Array.isArray(record.files)) return null;
  return (
    record.files.find(
      (path): path is string => typeof path === "string" && PREVIEWABLE_MODEL_RE.test(path),
    ) ?? null
  );
}

/**
 * 从任务结果里取出**服务端测到的**模型重量（`modelInfo`，见 chat 侧 `tools/modelInfo.ts`）。
 * 判据在服务端，这里只做搬运：面数是"要不要问用户降面"的唯一依据，前端各算一遍必然与它不一致。
 */
export function modelInfoFromTaskResult(
  result: unknown,
): { faces: number | null; highPoly: boolean } | null {
  if (!result || typeof result !== "object") return null;
  const info = (result as { modelInfo?: unknown }).modelInfo;
  if (!info || typeof info !== "object") return null;
  const record = info as { faces?: unknown; highPoly?: unknown };
  if (typeof record.highPoly !== "boolean") return null;
  return {
    faces: typeof record.faces === "number" ? record.faces : null,
    highPoly: record.highPoly,
  };
}

/**
 * 生成完成通知里附的"这个模型多重"。带上它，Agent 在"生成完成"那一轮就能直接决定
 * 要不要弹降面卡片，不必为此再多调一次 list-generation-tasks——少一次往返，也少一次
 * 模型可能忘记判定的机会。读不到面数时如实写"未知"，不要编一个数字。
 */
export function modelInfoSuffix(result: unknown): string {
  const info = modelInfoFromTaskResult(result);
  if (!info) return "";
  const faces = info.faces === null ? "polygon count unknown" : `${info.faces.toLocaleString("en-US")} triangles`;
  return ` · ${faces}${info.highPoly ? " · high-poly" : " · low-poly"}`;
}

/** 轮询当前项目的生成任务，逐个回报完成/失败，全部结束后停止 */
export function useTaskPolling({
  projectSlug,
  sessionId,
  enabled = true,
  assets,
  pushAssistant,
  updateMessage,
  setActivity,
  bumpRefresh,
}: UseTaskPollingOptions) {
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const reportedTasksRef = useRef<Set<string>>(new Set());
  const refreshedTasksRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef(sessionId);
  const scoped = sessionId !== undefined;
  /** 主模型路径 → 等待缩略图的完成消息；批量生成时逐件回填。 */
  const pendingPreviewsRef = useRef<Map<string, Set<string>>>(new Map());
  const assetsRef = useRef(assets);
  const pollingRef = useRef(false);
  const initialLoadingRef = useRef(false);
  const batchSeqRef = useRef(0);
  /** 一次工具调用创建一个批次；只有该批次全部结束才唤醒 Agent。 */
  const activeBatchesRef = useRef<
    Map<number, { ids: Set<string>; onSettled?: TaskSettledCallback }>
  >(new Map());
  /** 卸载后停止自递归 tick，避免继续请求或写入已卸载的工作台。 */
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollFailureCountRef = useRef(0);

  useLayoutEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    activeBatchesRef.current.clear();
    reportedTasksRef.current.clear();
    pendingPreviewsRef.current.clear();
    setActivity({ state: "idle", message: "Waiting for your instructions" });
  }, [sessionId, setActivity]);

  const attachPreview = useCallback(
    (sourcePath: string, thumbnailPath: string) => {
      const messageIds = pendingPreviewsRef.current.get(sourcePath);
      if (!messageIds) return;
      for (const messageId of messageIds) {
        updateMessage(messageId, (message) =>
          message.images?.includes(thumbnailPath)
            ? message
            : { ...message, images: [...(message.images ?? []), thumbnailPath] },
        );
      }
      pendingPreviewsRef.current.delete(sourcePath);
    },
    [updateMessage],
  );

  // 任务完成时缩略图可能已存在（例如恢复任务），资产刷新后直接回填。
  useEffect(() => {
    assetsRef.current = assets;
    for (const asset of assets) {
      if (asset.modelPath && asset.thumbPath) attachPreview(asset.modelPath, asset.thumbPath);
    }
  }, [assets, attachPreview]);

  /** 新模型的离屏渲染完成后，由全局缩略图队列调用。 */
  const onThumbnailGenerated = useCallback(
    (_asset: LibraryAsset, sourcePath: string, thumbnailPath: string) =>
      attachPreview(sourcePath, thumbnailPath),
    [attachPreview],
  );

  useEffect(() => {
    // StrictMode 下是 mount → unmount → mount，重新挂载时要把闸门放回去
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      clearTimeout(timerRef.current);
      pollingRef.current = false;
    };
  }, []);

  const pollTasks = useCallback((taskIds: string[] = [], onSettled?: TaskSettledCallback) => {
    if (cancelledRef.current || !enabled || !projectSlug) return;
    const ids = new Set(taskIds.filter(Boolean));
    if (ids.size > 0) {
      activeBatchesRef.current.set(++batchSeqRef.current, { ids, onSettled });
    }
    // 已有轮询时只需把新批次并入；下一 tick 会一并观察。
    if (pollingRef.current || initialLoadingRef.current) return;
    pollingRef.current = true;
    const tick = async () => {
      if (cancelledRef.current) {
        pollingRef.current = false;
        return;
      }
      let tasks: GenerationTask[];
      try {
        tasks = await listTasks(projectSlug);
        setTasks(tasks);
      } catch (err) {
        if (cancelledRef.current) return;
        const failureCount = ++pollFailureCountRef.current;
        const retryDelay = Math.min(4_000 * 2 ** (failureCount - 1), 30_000);
        const reason = err instanceof Error ? err.message : String(err);
        const hasConversationWork = !scoped || activeBatchesRef.current.size > 0;
        if (failureCount === 1 && hasConversationWork) {
          pushAssistant(`⚠️ Could not read background task status: ${reason}. Retrying automatically.`);
        }
        if (hasConversationWork) setActivity({
          state: "working",
          message: `Failed to read background task status; retrying in ${Math.round(retryDelay / 1000)} seconds`,
        });
        timerRef.current = setTimeout(() => void tick(), retryDelay);
        return;
      }
      pollFailureCountRef.current = 0;
      if (cancelledRef.current) return;
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      const assetsByModelPath = new Map(
        assetsRef.current.flatMap((asset) =>
          asset.modelPath ? [[asset.modelPath, asset] as const] : [],
        ),
      );
      const trackedIds = new Set(
        [...activeBatchesRef.current.values()].flatMap((batch) => [...batch.ids]),
      );
      // 项目后台时钟照常推进，包括其它会话的任务；新产物仍然进入资产库。
      for (const task of tasks) {
        if (task.status === "running" || refreshedTasksRef.current.has(task.id)) continue;
        refreshedTasksRef.current.add(task.id);
        bumpRefresh();
      }
      const visibleTasks = scoped || trackedIds.size > 0
        ? tasks.filter((task) => trackedIds.has(task.id))
        : tasks;
      const hasConversationWork = !scoped || trackedIds.size > 0;
      for (const task of visibleTasks) {
        if (task.status === "running" || reportedTasksRef.current.has(task.id)) continue;
        reportedTasksRef.current.add(task.id);
        if (task.status === "succeeded") {
          const model = (task.result as { model?: string } | undefined)?.model;
          const files = (task.result as { files?: string[] } | undefined)?.files;
          const messageId = pushAssistant(
            `✅ ${taskSubjectLabel(task.subject)} completed${model ? `: ${model}` : files ? `: ${files.length + 1} files` : ""} (saved to the local project folder)`,
          );
          if (task.workflowId === "3d") {
            const modelPath = modelPathFromTaskResult(task.result);
            if (modelPath) {
              const existing = assetsByModelPath.get(modelPath);
              if (existing?.thumbPath) {
                updateMessage(messageId, (message) => ({
                  ...message,
                  images: [...(message.images ?? []), existing.thumbPath!],
                }));
              } else {
                const pending = pendingPreviewsRef.current.get(modelPath) ?? new Set<string>();
                pending.add(messageId);
                pendingPreviewsRef.current.set(modelPath, pending);
              }
            }
          }
        } else {
          pushAssistant(`❌ ${taskSubjectLabel(task.subject)} failed: ${task.error ?? "Unknown error"}`);
        }
      }
      const callbacks: Array<() => void> = [];
      for (const [batchId, batch] of activeBatchesRef.current) {
        const batchTasks = [...batch.ids]
          .map((id) => tasksById.get(id))
          .filter((task): task is GenerationTask => Boolean(task));
        if (
          batchTasks.length === batch.ids.size &&
          batchTasks.every((task) => task.status !== "running")
        ) {
          activeBatchesRef.current.delete(batchId);
          if (batch.onSettled) {
            callbacks.push(() => batch.onSettled!({ tasks: batchTasks }));
          }
        }
      }

      const runningTasks = visibleTasks.filter((t) => t.status === "running");
      const runningModelTasks = runningTasks.filter((task) => task.workflowId === "3d");
      const waitingForRegisteredTasks = activeBatchesRef.current.size > 0;
      if (tasks.some((task) => task.status === "running") || waitingForRegisteredTasks) {
        if (hasConversationWork) {
          setActivity({
            state: "working",
            message:
              runningTasks.length === 1
                ? runningModelTasks.length === 1
                  ? `Generating model: ${taskSubjectLabel(runningTasks[0]!.subject).replace(/^3D generation(?: \([^)]*\))?: /, "")}`
                  : `Running: ${taskSubjectLabel(runningTasks[0]!.subject)}`
                : runningTasks.length > 1 && runningModelTasks.length === runningTasks.length
                  ? `Generating ${runningTasks.length} models`
                  : runningTasks.length > 1
                    ? `Running ${runningTasks.length} generation tasks`
                  : "Waiting for background tasks",
          });
        }
        timerRef.current = setTimeout(() => void tick(), TASK_POLL_INTERVAL_MS);
      } else {
        const failedCount = visibleTasks.filter((t) => t.status === "failed").length;
        if (hasConversationWork) setActivity({
          state: failedCount > 0 ? "attention" : "idle",
          message:
            failedCount > 0
              ? `Generation finished; ${failedCount} tasks failed`
              : "All generation tasks completed",
        });
        pollingRef.current = false;
      }
      // 先完成本轮状态写入，再唤醒 Agent，避免“生成结束”覆盖新一轮“正在思考”。
      for (const callback of callbacks) callback();
    };
    void tick();
  }, [projectSlug, enabled, scoped, pushAssistant, updateMessage, setActivity, bumpRefresh]);

  useEffect(() => {
    if (!projectSlug || !enabled) return;
    let cancelled = false;
    initialLoadingRef.current = true;
    void listTasks(projectSlug)
      .then((initial) => {
        if (!cancelled) {
          setTasks(initial);
          const runningIds = initial
            .filter((task) => task.status === "running")
            .map((task) => task.id);
          initialLoadingRef.current = false;
          // 已落盘的任务由 useAgentChat 从本会话 pendingTaskIds 登记；
          // 发现其它会话的 running 只负责驱动，不能把它认领进当前会话。
          if (runningIds.length > 0) pollTasks(scoped ? [] : runningIds);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        initialLoadingRef.current = false;
        // 初始加载在途时注册的批次（如 retry / agent 的 start-3d-batch 回报）若初始列表
        // 里没有任何 running 任务，上面的 then 分支不会发起轮询；这里补发一次，否则批次
        // 永不结算、onSettled 永不触发。pollTasks 内部会自行检查 cancelledRef / 已有轮询。
        if (activeBatchesRef.current.size > 0 && !pollingRef.current) pollTasks();
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, enabled, scoped, pollTasks]);

  return { tasks, pollTasks, onThumbnailGenerated };
}
