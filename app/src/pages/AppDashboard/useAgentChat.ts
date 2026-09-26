import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { taskSubjectLabel } from "../../shared/lib/taskText";
import {
  streamChat,
  type LlmRequestConfig,
  type OutgoingChatMessage,
  type OutgoingContentPart,
} from "../../shared/lib/chatClient";
import {
  fetchLibraryAssets,
  uploadInspection,
  type LibraryAsset,
  type ProjectPlan,
} from "../../shared/lib/libraryApi";
import { uploadSource } from "../../shared/lib/workflowClient";
import {
  loadImageGenerateModelSettings,
  loadLlmSettings,
  loadThreeDProviderSettings,
} from "../../shared/storage/apiKeys";
import type {
  AgentActivity,
  ChatAssetAttachment,
  ChatMessage,
} from "../../widgets/AgentDock";
import type { InspectionRequest } from "../../widgets/ModelPreviewWindow";
import { nextId } from "./useChatMessages";
import type { TaskSettlement } from "./useTaskPolling";

/** Agent 凭证与模型端点均由本机服务决定；网页只发送显示偏好。 */
function llmConfig(): LlmRequestConfig {
  const settings = loadLlmSettings();
  return {
    provider: settings.provider || undefined,
    baseUrl: settings.baseUrl.trim() || undefined,
    model: settings.model.trim() || undefined,
  };
}

/** 启动即返回、靠 useTaskPolling 逐个回报的生成任务工具 */
const TASK_STARTING_TOOLS = new Set([
  "workflow-one-shot-scene",
  "start-3d-batch",
  "start-world-task",
  "start-skybox-task",
  "generate-texture",
  "retopologize",
  "rig-model",
  "generate-animation",
  "segment-parts",
  "generate-character",
  "unwrap-uv",
]);

/** 完成后会立刻在 source/ 落盘图片，需要同步刷新图片库。 */
const IMAGE_OUTPUT_TOOLS = new Set([
  "generate-reference-images",
  "generate-skybox",
  "edit-reference-image",
]);

/**
 * 只读查询工具：它们不产生用户可见的动作，也不落任何产物，只把状态交回给模型。
 * 时间线是"这一步做了什么"的记录，查询本身不是一步——展示出来会和它正在等的那个
 * 生成步骤抢同一块地方，读起来像多了一步"checking generation progress"。
 * 失败仍然落一行：查不到状态是要让用户看见的，不该静默。
 */
const SILENT_ACTIVITY_TOOLS = new Set(["list-generation-tasks"]);

/**
 * 生产步骤不进时间线：长耗时生成（3D / 世界 / 天空盒 / 后处理…）以及紧随其后的
 * 自检，用户只需要看到状态行里的"正在生成"和最终产物，不需要看到一步步的工具节点
 * （先一个 generator、再一个 check）。
 *
 * 与 SILENT_ACTIVITY_TOOLS 的区别：这里的工具仍然驱动状态行——它就是在生成；
 * 失败也照旧落一行（见 onToolError），不静默。任务化生成共用 TASK_STARTING_TOOLS，
 * 将来新增的生成工具自动跟着收进去。
 */
const BACKGROUND_ACTIVITY_TOOLS = new Set([
  ...TASK_STARTING_TOOLS,
  "build-cad-model",
  "inspect-asset",
  "resume-generation",
  "repair-assets",
]);

const TOOL_ACTIVITY_MESSAGES: Readonly<Record<string, string>> = {
  "update-plan": "Updating plan",
  "generate-reference-images": "Generating image",
  "generate-skybox": "Generating skybox",
  "edit-reference-image": "Editing reference image",
  "analyze-scene": "Analyzing current scene",
  analyzeSceneTool: "Analyzing current scene",
  "analyze-reference": "Analyzing reference image",
  analyzeReferenceTool: "Analyzing reference image",
  "generate-plate": "Generating scene base image",
  "workflow-one-shot-scene": "Generating complete scene",
  "start-3d-batch": "Starting 3D generation",
  "start-world-task": "Generating 3D world",
  "start-skybox-task": "Generating skybox",
  "generate-texture": "Generating textures",
  retopologize: "Retopologizing model",
  "rig-model": "Rigging model",
  "generate-animation": "Generating animation",
  "segment-parts": "Segmenting model",
  "generate-character": "Generating character",
  "unwrap-uv": "Unwrapping UVs",
  "build-cad-model": "Building CAD model",
  "get-cad-source": "Reading CAD source",
  "inspect-asset": "Inspecting asset",
  "identify-asset": "Identifying asset",
  "list-generation-tasks": "Checking generation progress",
  "resume-generation": "Resuming generation",
  "repair-assets": "Repairing assets",
};

/**
 * Mastra 的工具事件名来自 Agent `tools` 记录的键。旧版本有些工具用导出变量名
 * 注册，因而会发出 updatePlanTool / generateReferenceImagesTool；新版本统一使用
 * createTool 的 kebab-case id。这里继续兼容旧服务与尚未结束的旧 SSE 流。
 */
function canonicalToolName(name: string) {
  if (!name.endsWith("Tool")) return name;
  return name
    .slice(0, -4)
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** 把内部工具 id 翻译成创作动作；新工具在映射补齐前仍有清楚的兜底状态。 */
function toolActivityMessage(name: string) {
  return TOOL_ACTIVITY_MESSAGES[name] ?? `Running ${name} tool`;
}

function completedToolActivityMessage(name: string) {
  const running = toolActivityMessage(name);
  return `Completed: ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
}

function failedToolActivityMessage(name: string) {
  const running = toolActivityMessage(name);
  return `Failed: ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
}

interface UseAgentChatOptions {
  projectSlug: string;
  sessionId?: string;
  sessionReady?: boolean;
  messagesRef: { current: ChatMessage[] };
  pushMessage: (message: ChatMessage) => void;
  pushAssistant: (content: string) => void;
  updateMessage: (id: string, updater: (message: ChatMessage) => ChatMessage) => void;
  appendTo: (id: string, updater: (content: string) => string) => void;
  setActivity: (activity: AgentActivity) => void;
  pollTasks: (
    taskIds?: string[],
    onSettled?: (settlement: TaskSettlement) => void,
  ) => void;
  bumpRefresh: () => void;
  /** 当前会话自己的计划快照；每轮请求都显式带回服务端。 */
  sessionPlan?: ProjectPlan | null;
  /** update-plan 工具返回完整计划后直接保存当前会话快照。 */
  onPlanUpdated?: (plan: ProjectPlan) => void;
}

/**
 * agent 对话的核心编排：SSE 流驱动、视觉自检回路、参考图身份识别回路——
 * 这几条线彼此通过"流结束后自动发下一条带图用户消息"串联（inspect-asset/
 * identify-asset 都是本轮不等待、流结束后再回传），因此放在同一个 hook 里
 * 维护共享的 streaming/pending 状态，而不拆成互不相关的几个 hook。
 *
 * 图片上传统一走对话（2026-07 起不再有独立的手动 uncover workflow 与
 * 「自动模式」开关）：上传后把图片和指令拼成一条带图用户消息交给 agent，
 * 只有明确进入参考图资产提取时，才依次调用 analyze-reference →
 * one-shot-scene Workflow 内确认对象并生成；普通图片直接由多模态 agent 阅读，
 * 粒度全靠对话里的指令决定。
 */
export function useAgentChat({
  projectSlug,
  sessionId = projectSlug,
  sessionReady = true,
  messagesRef,
  pushMessage,
  pushAssistant,
  updateMessage,
  appendTo,
  setActivity,
  pollTasks,
  bumpRefresh,
  sessionPlan,
  onPlanUpdated,
}: UseAgentChatOptions) {
  const sessionPlanRef = useRef(sessionPlan ?? null);
  useLayoutEffect(() => {
    sessionPlanRef.current = sessionPlan ?? null;
  }, [sessionPlan]);
  /** 预览小窗：双击打开（inspection=null）或 agent 自检（inspection 带批次 id） */
  const [preview, setPreview] = useState<{
    asset: LibraryAsset;
    inspection: InspectionRequest | null;
  } | null>(null);
  /** 已上传待回传的自检截图：等当前 SSE 流结束后自动作为带图用户消息发出 */
  const pendingInspectionRef = useRef<{ assetSlug: string; path: string } | null>(null);
  /** 待回传的候选资产参考图（identify-asset 工具事件）：同样等当前流结束后发出 */
  const pendingIdentifyRef = useRef<{ assetSlug: string; path: string }[] | null>(null);
  /** 后台生成完成结果：等当前流结束后作为新一轮上下文交回 Agent，驱动其继续。 */
  const pendingTaskSettlementsRef = useRef<(TaskSettlement & { ownerId: string })[]>([]);
  // 一次 HTTP 回复结束不等于创作完成；任务、截图和续跑之间共享等待状态。
  const backgroundTasksRef = useRef(new Map<string, string>());
  const inspectionWaitRef = useRef<{ ownerId: string; assetSlug: string } | null>(null);
  const identifyingRef = useRef(false);
  const registeredTasksRef = useRef(new Set<string>());
  const registeredInspectionsRef = useRef(new Set<string>());
  const generationEpochRef = useRef(0);
  const [waiting, setWaiting] = useState(false);
  const hasPendingWork = () => backgroundTasksRef.current.size > 0 ||
    inspectionWaitRef.current !== null || identifyingRef.current;
  const syncWaiting = () => setWaiting(hasPendingWork());
  const sessionRef = useRef(sessionId);
  useLayoutEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    generationEpochRef.current += 1;
    backgroundTasksRef.current.clear();
    registeredTasksRef.current.clear();
    registeredInspectionsRef.current.clear();
    inspectionWaitRef.current = null;
    identifyingRef.current = false;
    pendingTaskSettlementsRef.current = [];
    pendingInspectionRef.current = null;
    pendingIdentifyRef.current = null;
    setWaiting(false);
  }, [sessionId]);
  /**
   * 是否有一条 SSE 流在跑。ref 供各处同步判断（回传排队要在回调里立刻读到），
   * state 供 UI 渲染。实际流与后台等待分开记录，自动续跑可以开启下一条流，
   * 但工作台在整个生成/自检链结束前持续显示运行，并保留停止入口。
   */
  const streamingRef = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const uploadingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const markStreaming = (value: boolean) => {
    streamingRef.current = value;
    setStreaming(value);
  };
  /** 当前这条流的中止句柄；null 表示没有流在跑 */
  const abortRef = useRef<AbortController | null>(null);
  /** 停止按钮需要把当前消息里的动画同时冻结。 */
  const activeAssistantIdRef = useRef<string | null>(null);
  /** Promise cleanup 后仍可能兑现；卸载后禁止 continuation 再写 UI 或启动流。 */
  const activeRef = useRef(true);

  /**
   * 用户主动叫停。一轮生成可能跑几十秒并调用付费工具，看出方向不对时必须能收回——
   * 这也是发送按钮在流式期间变成"停止"而不是变灰的原因：把用户锁在一个他已经
   * 知道错了的过程里，比允许并发更糟。
   */
  const stopStream = () => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
      uploadingRef.current = false;
      setUploading(false);
      setActivity({ state: "idle", message: "Upload stopped" });
      return;
    }
    generationEpochRef.current += 1;
    const pendingOwners = new Set(backgroundTasksRef.current.values());
    if (inspectionWaitRef.current) pendingOwners.add(inspectionWaitRef.current.ownerId);
    for (const id of pendingOwners) {
      updateMessage(id, (message) => ({
        ...message,
        pendingTaskIds: undefined,
        pendingInspectionAssetSlug: undefined,
        agentStatus: { label: "Follow-up stopped", status: "failed" },
      }));
    }
    backgroundTasksRef.current.clear();
    inspectionWaitRef.current = null;
    identifyingRef.current = false;
    pendingTaskSettlementsRef.current = [];
    pendingInspectionRef.current = null;
    pendingIdentifyRef.current = null;
    setPreview((current) => current ? { ...current, inspection: null } : current);
    syncWaiting();
    abortRef.current?.abort();
    abortRef.current = null;
    markStreaming(false);
    const assistantId = activeAssistantIdRef.current;
    activeAssistantIdRef.current = null;
    if (assistantId) {
      updateMessage(assistantId, (message) => ({
        ...message,
        agentStatus: { label: "Stopped", status: "failed" },
        activities: message.activities?.map((item) =>
          item.status === "running"
            ? { ...item, label: "Stopped", status: "failed" as const }
            : item,
        ),
      }));
    }
    setActivity({ state: "idle", message: "Agent stopped; submitted background tasks may still finish" });
  };

  /**
   * 卸载时中止在途流，并丢弃尚未回传的自检、参考图和后台任务结果。
   */
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      generationEpochRef.current += 1;
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      uploadingRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      activeAssistantIdRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
      pendingInspectionRef.current = null;
      pendingIdentifyRef.current = null;
      pendingTaskSettlementsRef.current = [];
      backgroundTasksRef.current.clear();
      registeredTasksRef.current.clear();
      registeredInspectionsRef.current.clear();
      inspectionWaitRef.current = null;
      identifyingRef.current = false;
    };
  }, []);

  /** 普通图片消息：上传落盘 → 带真实图片部件交给多模态 agent；不预设参考图意图。 */
  const startImageMessage = async (
    files: File[],
    note: string,
    assets?: ChatAssetAttachment[],
    controller?: AbortController,
  ) => {
    try {
      const imagePaths: string[] = [];
      for (const file of files) {
        if (!activeRef.current || controller?.signal.aborted) return;
        setActivity({ state: "working", message: `Uploading ${file.name} (${imagePaths.length + 1}/${files.length})` });
        imagePaths.push(await uploadSource(projectSlug, file, controller?.signal));
      }
      if (!activeRef.current || controller?.signal.aborted) return;

      const instruction = note || (files.length === 1 ? "Please review this image." : "Please review these images.");
      const userMessage: ChatMessage = {
        id: nextId(),
        role: "user",
        content: instruction,
        images: imagePaths,
        ...(assets && assets.length > 0 ? { assets } : {}),
      };
      const history = toOutgoingHistory([...messagesRef.current, userMessage]);
      pushMessage(userMessage);
      startStream(history);
    } catch (err) {
      if (!activeRef.current || controller?.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setActivity({ state: "attention", message });
      pushAssistant(`⚠️ ${message}`);
    } finally {
      if (activeRef.current && uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        uploadingRef.current = false;
        setUploading(false);
      }
    }
  };

  /**
   * UI 消息 → 对话请求消息：图片与资产附件都展开成一等消息部件。
   * 资产只发 slug，显示名/缩略图只是 UI 快照，服务端会按当前项目真实状态解析。
   */
  const toOutgoingHistory = (list: ChatMessage[]): OutgoingChatMessage[] =>
    list.flatMap<OutgoingChatMessage>(({ role, content, images, assets }) => {
      const hasText = content.trim().length > 0;

      /*
       * 旧会话里可能残留早期实现创建的空 assistant 占位气泡。它对上下文没有信息量，
       * 却会被 chat DTO 的 `content.min(1)` 拒绝，表现为下一次发送时报
       * `messages.N.content: Too small`。在请求边界过滤一次，已落盘的旧会话也能自愈。
       */
      if (role !== "user") {
        return hasText ? [{ role, content }] : [];
      }

      const hasAttachments =
        (assets && assets.length > 0) || (images && images.length > 0);
      if (!hasAttachments) {
        return hasText ? [{ role, content }] : [];
      }

      const parts: OutgoingContentPart[] = [
        ...(assets ?? []).map(({ assetSlug }) => ({
          type: "asset" as const,
          assetSlug,
        })),
        ...(hasText ? [{ type: "text" as const, text: content }] : []),
        ...(images ?? []).map((path) => ({ type: "image" as const, path })),
      ];
      return parts.length > 0 ? [{ role, content: parts }] : [];
    });

  /** agent 自检请求（inspect-asset 工具事件）：打开小窗并触发四视角截图 */
  const failInspection = (message: string) => {
    const owner = inspectionWaitRef.current;
    inspectionWaitRef.current = null;
    syncWaiting();
    if (owner) updateMessage(owner.ownerId, (current) => ({
      ...current,
      pendingInspectionAssetSlug: undefined,
      agentStatus: { label: "Inspection failed", status: "failed" },
    }));
    setActivity({ state: "attention", message });
    pushAssistant(`⚠️ ${message}`);
  };

  const startInspection = async (assetSlug: string, toolCallId?: string, ownerId = activeAssistantIdRef.current) => {
    if (!projectSlug || !ownerId) return;
    const epoch = generationEpochRef.current;
    inspectionWaitRef.current = { ownerId, assetSlug };
    registeredInspectionsRef.current.add(ownerId);
    updateMessage(ownerId, (message) => ({
      ...message,
      pendingInspectionAssetSlug: assetSlug,
      agentStatus: { label: "Inspecting generated model", status: "running" },
    }));
    syncWaiting();
    setActivity({ state: "working", message: "Inspecting generated model" });
    let assets: LibraryAsset[];
    try {
      assets = await fetchLibraryAssets(projectSlug);
    } catch (err) {
      if (activeRef.current && epoch === generationEpochRef.current) {
        failInspection(`Inspection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!activeRef.current || epoch !== generationEpochRef.current) return;
    const asset = assets.find((a) => a.assetSlug === assetSlug);
    if (!asset?.modelPath) {
      failInspection(`Inspection failed: asset "${assetSlug}" has no renderable model output.`);
      return;
    }
    const id =
      (toolCallId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) ||
      `i-${Date.now().toString(36)}`;
    setPreview({ asset, inspection: { id } });
  };

  /** 截图完成：上传落盘，等当前流结束后作为带图用户消息回传给 agent */
  const handleInspectionCaptured = useCallback(
    (id: string, pngBase64: string | null) => {
      const current = preview;
      const epoch = generationEpochRef.current;
      if (!inspectionWaitRef.current || current?.inspection?.id !== id) return;
      setPreview((p) => (p ? { ...p, inspection: null } : p));
      if (!current) return;
      if (!pngBase64) {
        failInspection("Inspection screenshot failed: the model did not render in the preview.");
        return;
      }
      void uploadInspection(
        current.asset.projectSlug,
        current.asset.assetSlug,
        id,
        pngBase64,
      )
        .then((path) => {
          if (!activeRef.current || epoch !== generationEpochRef.current) return;
          pendingInspectionRef.current = { assetSlug: current.asset.assetSlug, path };
          if (!streamingRef.current) flushPendingInspection();
        })
        .catch((err) => {
          if (!activeRef.current || epoch !== generationEpochRef.current) return;
          failInspection(`Failed to upload inspection image: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [preview, pushAssistant],
  );

  /**
   * 把已落盘的检查图作为带图用户消息发出，触发 agent 的自检轮。
   * 返回是否真的发出了一轮——调用方据此串行化，见 onDone 的说明。
   */
  const flushPendingInspection = (): boolean => {
    // 守卫与 startStream 同款：已有流在跑时不清队、不 push，否则排队内容丢失、消息成孤儿气泡
    if (streamingRef.current) return false;
    const pending = pendingInspectionRef.current;
    if (!pending) return false;
    pendingInspectionRef.current = null;
    const owner = inspectionWaitRef.current;
    inspectionWaitRef.current = null;
    syncWaiting();
    if (owner) updateMessage(owner.ownerId, (message) => ({
      ...message, pendingInspectionAssetSlug: undefined,
      agentStatus: { label: "Inspection images ready", status: "completed" },
    }));
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: `[Inspection screenshots] ${pending.assetSlug}: four views (top left: ISO, top right: FRONT, bottom left: RIGHT, bottom right: TOP). Check each view.`,
      images: [pending.path],
    };
    const history = toOutgoingHistory([...messagesRef.current, userMessage]);
    pushMessage(userMessage);
    startStream(history);
    return true;
  };

  /**
   * agent 身份识别请求（identify-asset 工具事件）：候选资产的参考图已经在
   * 资产库磁盘上，不需要开视口渲染，直接按 slug 查出参考图逻辑路径即可。
   */
  const startIdentify = async (assetSlugs: string[]) => {
    if (!projectSlug) return;
    const epoch = generationEpochRef.current;
    identifyingRef.current = true;
    syncWaiting();
    let assets: LibraryAsset[];
    try {
      assets = await fetchLibraryAssets(projectSlug);
    } catch (err) {
      if (activeRef.current && epoch === generationEpochRef.current) {
        identifyingRef.current = false;
        syncWaiting();
        pushAssistant(`⚠️ Asset identification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!activeRef.current || epoch !== generationEpochRef.current) return;
    // slug → asset 建一次表，避免对每个候选 slug 都线性扫一遍 assets
    const bySlug = new Map(assets.map((a) => [a.assetSlug, a]));
    const found = assetSlugs
      .map((slug) => bySlug.get(slug))
      .filter((a): a is LibraryAsset => Boolean(a && a.sourceImages.length > 0));
    if (found.length === 0) {
      identifyingRef.current = false;
      syncWaiting();
      pushAssistant("⚠️ Asset identification failed: no candidate assets have reference images.");
      return;
    }
    pendingIdentifyRef.current = found.map((a) => ({
      assetSlug: a.assetSlug,
      path: a.sourceImages[0]!,
    }));
    if (!streamingRef.current) flushPendingIdentify();
  };

  /** 把候选资产的参考图依次作为带图用户消息发出，触发 agent 的身份确认轮 */
  const flushPendingIdentify = (): boolean => {
    if (streamingRef.current) return false;
    const pending = pendingIdentifyRef.current;
    if (!pending || pending.length === 0) return false;
    pendingIdentifyRef.current = null;
    identifyingRef.current = false;
    syncWaiting();
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: `[Candidate asset reference images] In order: ${pending.map((p) => p.assetSlug).join(", ")}. Confirm each identity against its reference image.`,
      images: pending.map((p) => p.path),
    };
    const history = toOutgoingHistory([...messagesRef.current, userMessage]);
    pushMessage(userMessage);
    startStream(history);
    return true;
  };

  /** 把已结束的后台任务合成一条系统式用户消息，重新唤醒同一会话里的 Agent。 */
  const flushPendingTaskSettlements = (): boolean => {
    if (streamingRef.current) return false;
    const settlements = pendingTaskSettlementsRef.current;
    if (settlements.length === 0) return false;
    pendingTaskSettlementsRef.current = [];
    for (const settlement of settlements) {
      const ids = new Set(settlement.tasks.map((task) => task.id));
      for (const id of ids) backgroundTasksRef.current.delete(id);
      updateMessage(settlement.ownerId, (message) => ({
        ...message,
        pendingTaskIds: message.pendingTaskIds?.filter((id) => !ids.has(id)),
        agentStatus: { label: "Generation finished; continuing", status: "completed" },
      }));
    }
    syncWaiting();
    const tasks = settlements.flatMap((settlement) => settlement.tasks);
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: [
        "[Background tasks finished]",
        ...tasks.map((task) =>
          task.status === "succeeded"
            ? `- ${taskSubjectLabel(task.subject)}: succeeded`
            : `- ${taskSubjectLabel(task.subject)}: failed (${task.error ?? "Unknown error"})`,
        ),
        "Continue the original request automatically: inspect successful model outputs as needed, then deliver the result. Do not ask the user to check back or repeat successful paid generation. Continue the existing plan without recreating it.",
      ].join("\n"),
    };
    const history = toOutgoingHistory([...messagesRef.current, userMessage]);
    pushMessage(userMessage);
    startStream(history);
    return true;
  };

  const queueTaskSettlement = (settlement: TaskSettlement & { ownerId: string }) => {
    pendingTaskSettlementsRef.current.push(settlement);
    // 轮询回报消息也是本 tick 才写入 React；推迟后再取完整历史。
    setTimeout(() => {
      if (activeRef.current && !streamingRef.current) {
        flushPendingTaskSettlements();
      }
    }, 0);
  };

  const trackTasks = (ownerId: string, taskIds: string[]) => {
    const freshIds = taskIds.filter((id) => !registeredTasksRef.current.has(id));
    if (freshIds.length === 0) return;
    const epoch = generationEpochRef.current;
    for (const id of freshIds) {
      registeredTasksRef.current.add(id);
      backgroundTasksRef.current.set(id, ownerId);
    }
    syncWaiting();
    if (!streamingRef.current) {
      setActivity({ state: "working", message: "Generating; will continue automatically" });
    }
    updateMessage(ownerId, (message) => ({
      ...message,
      pendingTaskIds: [...new Set([...(message.pendingTaskIds ?? []), ...freshIds])],
      agentStatus: { label: "Generating; will continue automatically", status: "running" },
    }));
    pollTasks(freshIds, (settlement) => {
      if (!activeRef.current || epoch !== generationEpochRef.current) return;
      updateMessage(ownerId, (message) => ({
        ...message,
        agentStatus: { label: "Checking generation results", status: "running" },
      }));
      queueTaskSettlement({ ...settlement, ownerId });
    });
  };

  /** 驱动一轮 agent 对话流（send 与自检回传共用） */
  const startStream = (history: OutgoingChatMessage[]) => {
    if (!activeRef.current) return;
    /*
      不变量：同一会话同时至多一条活跃流。这道守卫必须在这里，不能只靠按钮 disabled
      ——那只是给人看的可供性，挡不住回车快捷键、程序化调用、以及以后任何一个新的
      调用方。两条流并发的后果是实打实的：`send` 是先取 messagesRef 再 push 消息，
      第二条流的历史里既没有第一条用户消息也没有它的回复，两边带着分叉的上下文
      各跑一轮、回复交错写进两个气泡，且都可能各自调用一次付费生成工具。
      拒绝时明说，不静默——调用方可能已经把用户消息推进列表了。
    */
    if (streamingRef.current) {
      pushAssistant("⚠️ The previous request is still running. Wait for it to finish or stop it before sending another.");
      return;
    }
    const llm = llmConfig();
    const assistantId = nextId();
    let toolSequence = 0;
    let replying = false;
    let streamedContent = "";
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      agentStatus: { label: "Thinking", status: "running" },
    });
    activeAssistantIdRef.current = assistantId;
    setActivity({ state: "working", message: "Thinking" });
    markStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    void streamChat(
      projectSlug,
      history,
      llm,
      {
        onDelta: (delta) => {
          if (!activeRef.current || controller.signal.aborted) return;
          if (!delta) return;
          streamedContent += delta;
          if (!replying) {
            replying = true;
            setActivity({ state: "working", message: "Responding" });
            updateMessage(assistantId, (message) => ({
              ...message,
              agentStatus: { label: "Responding", status: "running" },
            }));
          }
          appendTo(assistantId, (content) => content + delta);
        },
        onTool: (name, toolCallId, args) => {
          if (!activeRef.current || controller.signal.aborted) return;
          name = canonicalToolName(name);
          const label = toolActivityMessage(name);
          const activityId = toolCallId ?? `tool-${assistantId}-${++toolSequence}`;
          replying = false;
          // 只读查询不占时间线，也不顶掉状态行里正在跑的生成进度
          if (!SILENT_ACTIVITY_TOOLS.has(name)) {
            const hiddenStep = BACKGROUND_ACTIVITY_TOOLS.has(name);
            setActivity({ state: "working", message: label });
            updateMessage(assistantId, (message) => ({
              ...message,
              agentStatus: { label, status: "running" },
              activities: hiddenStep
                ? message.activities
                : [
                    ...(message.activities ?? []),
                    {
                      id: activityId,
                      toolName: name,
                      contentOffset: streamedContent.length,
                      label,
                      status: "running",
                    },
                  ],
            }));
          }
          if (name === "inspect-asset" && typeof args?.assetSlug === "string") {
            void startInspection(args.assetSlug, toolCallId);
          } else if (
            name === "identify-asset" &&
            Array.isArray(args?.assetSlugs) &&
            args.assetSlugs.every((slug): slug is string => typeof slug === "string")
          ) {
            void startIdentify(args.assetSlugs);
          }
        },
        onToolResult: (name, toolCallId, images, taskIds, updatedPlan) => {
          if (!activeRef.current || controller.signal.aborted) return;
          name = canonicalToolName(name);
          replying = false;
          updateMessage(assistantId, (message) => {
            const nextImages = images?.filter(
              (path) => !message.images?.includes(path),
            );
            return {
              ...message,
              ...(nextImages && nextImages.length > 0
                ? { images: [...(message.images ?? []), ...nextImages] }
                : {}),
              agentStatus: { label: "Thinking", status: "running" },
              activities: message.activities?.map((item) =>
                (toolCallId ? item.id === toolCallId : item.toolName === name) &&
                item.status === "running"
                  ? {
                      ...item,
                      label: completedToolActivityMessage(name),
                      status: "completed" as const,
                    }
                  : item,
              ),
            };
          });
          setActivity({ state: "working", message: "Thinking" });
          if (name === "update-plan" && updatedPlan) {
            sessionPlanRef.current = updatedPlan;
            onPlanUpdated?.(updatedPlan);
          }
          if (IMAGE_OUTPUT_TOOLS.has(name)) bumpRefresh();
          if (TASK_STARTING_TOOLS.has(name) && taskIds && taskIds.length > 0) {
            trackTasks(assistantId, taskIds);
          }
        },
        onToolError: (name, toolCallId, errorMessage) => {
          if (!activeRef.current || controller.signal.aborted) return;
          name = canonicalToolName(name);
          const failureLabel = failedToolActivityMessage(name);
          const label = errorMessage
            ? `${failureLabel}: ${errorMessage}`
            : failureLabel;
          updateMessage(assistantId, (message) => {
            let matched = false;
            const activities = (message.activities ?? []).map((item) => {
              if (
                (toolCallId ? item.id === toolCallId : item.toolName === name) &&
                item.status === "running"
              ) {
                matched = true;
                return { ...item, label, status: "failed" as const };
              }
              return item;
            });
            if (!matched) {
              activities.push({
                id: toolCallId ?? `tool-error-${assistantId}-${++toolSequence}`,
                toolName: name,
                contentOffset: streamedContent.length,
                label,
                status: "failed",
              });
            }
            return {
              ...message,
              agentStatus: { label: "Thinking", status: "running" },
              activities,
            };
          });
          setActivity({ state: "working", message: "Thinking" });
        },
        onError: (message) => {
          if (!activeRef.current || controller.signal.aborted) return;
          abortRef.current = null;
          activeAssistantIdRef.current = null;
          markStreaming(false);
          setActivity({ state: "attention", message });
          updateMessage(assistantId, (assistant) => ({
            ...assistant,
            agentStatus: { label: "Execution failed", status: "failed" },
            activities: assistant.activities?.map((item) =>
              item.status === "running"
                ? { ...item, label: "Execution failed", status: "failed" as const }
                : item,
            ),
          }));
          // 错误同时落进对话气泡：状态行会被下一个状态顶掉，只写那里等于静默失败
          appendTo(assistantId, (content) =>
            content ? `${content}\n\n⚠️ ${message}` : `⚠️ ${message}`,
          );
          // 工具已提交的后台工作仍可能成功；流出错也必须释放排队的完成通知。
          setTimeout(() => {
            if (!activeRef.current || controller.signal.aborted) return;
            if (!flushPendingInspection() && !flushPendingIdentify()) flushPendingTaskSettlements();
          }, 0);
        },
        onDone: () => {
          if (!activeRef.current || controller.signal.aborted) return;
          abortRef.current = null;
          activeAssistantIdRef.current = null;
          markStreaming(false);
          updateMessage(assistantId, (message) => {
            const activities = message.activities?.map((item) =>
              item.status === "running"
                ? {
                    ...item,
                    label: item.toolName
                      ? failedToolActivityMessage(item.toolName)
                      : item.label,
                    status: "failed" as const,
                  }
                : item,
            );
            const hasFailedStep = activities?.some(
              (item) => item.status === "failed",
            );
            return {
              ...message,
              agentStatus: hasFailedStep
                ? { label: "Some steps failed", status: "failed" }
                : hasPendingWork()
                  ? { label: inspectionWaitRef.current ? "Inspecting generated model" : "Generating; will continue automatically", status: "running" }
                : { label: "Completed", status: "completed" },
              activities,
            };
          });
          setActivity(
            hasPendingWork()
              ? { state: "working", message: inspectionWaitRef.current
                  ? "Inspecting generated model"
                  : "Generating; will continue automatically" }
              : { state: "idle", message: "Agent finished responding" },
          );
          // agent 可能更新了计划或产出了资产：刷新派生状态
          bumpRefresh();
          /*
            两条回传只能串行发，不能都发：agent 完全可能在同一轮里既调 inspect-asset
            又调 identify-asset，两个 flush 各自 startStream 就会并发拉起两条 SSE 流；
            而且第二条的 history 取自 messagesRef，此时还没包含第一条刚 push 的消息，
            两条流会带着分叉的历史打给 agent、回复交错写进两个气泡。
            这里只发第一条——它的 onDone 会再走到这里，把剩下那条接着发出去。

            推迟一个宏任务再发：最后几个 delta 和 done 常落在同一个网络 chunk 里、
            被同步连续处理，此刻 appendTo 的 setState 还没提交，messagesRef 里的
            assistant 回复缺尾巴（短回复甚至整段是空的）——等 React 提交完再取
            history 才是完整的。项目切换/卸载时 pending 队列已被 cleanup 清空，
            这个延迟回调届时是 no-op，不会往新项目里发。
          */
          setTimeout(() => {
            if (!activeRef.current || controller.signal.aborted) return;
            if (!flushPendingInspection() && !flushPendingIdentify()) {
              flushPendingTaskSettlements();
            }
          }, 0);
        },
      },
      {
        threeDProvider: loadThreeDProviderSettings().provider || undefined,
        imageGenerateModel:
          loadImageGenerateModelSettings().model || undefined,
        plan: sessionPlanRef.current ?? undefined,
      },
      controller.signal,
    );
  };

  const send = (
    text: string,
    imageFiles?: File[],
    assets?: ChatAssetAttachment[],
  ) => {
    // 提前拦一道：拦在这里才不会推入一条注定得不到回复的用户消息
    // （startStream 里那道是真正的不变量，两者不重复，职责不同）
    if (streamingRef.current || uploadingRef.current || hasPendingWork()) return;
    if (imageFiles && imageFiles.length > 0) {
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      uploadingRef.current = true;
      setUploading(true);
      void startImageMessage(imageFiles, text, assets, controller);
      return;
    }
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: text,
      ...(assets && assets.length > 0 ? { assets } : {}),
    };
    const history = toOutgoingHistory([...messagesRef.current, userMessage]);
    pushMessage(userMessage);
    startStream(history);
  };

  // 只恢复当前会话明确记录的任务；不把其他会话的项目任务接到这里。
  useEffect(() => {
    if (!sessionReady) return;
    for (const message of messagesRef.current) {
      if (message.role !== "assistant") continue;
      if (message.pendingTaskIds?.length) trackTasks(message.id, message.pendingTaskIds);
      if (message.pendingInspectionAssetSlug && !registeredInspectionsRef.current.has(message.id)) {
        void startInspection(message.pendingInspectionAssetSlug, undefined, message.id);
      }
    }
  });

  const openPreview = useCallback(
    (asset: LibraryAsset) => setPreview({ asset, inspection: null }),
    [],
  );
  const closePreview = useCallback(() => {
    if (inspectionWaitRef.current) failInspection("Inspection stopped because the preview was closed");
    setPreview(null);
  }, [pushAssistant, updateMessage, setActivity]);
  /**
   * 只在小窗正开着这个资产时关掉。用函数式 setState 读最新值，而不是让调用方拿
   * `preview` 去比对——那样调用方的 `useCallback` 就得把 `preview` 记进依赖，
   * 每次开关预览小窗都重建回调，把 `ModelList` 的 `memo` 一并戳穿。
   */
  const closePreviewFor = useCallback(
    (assetId: string) => setPreview((p) => (p?.asset.id === assetId ? null : p)),
    [],
  );

  return {
    preview,
    openPreview,
    closePreview,
    closePreviewFor,
    handleInspectionCaptured,
    send,
    stopStream,
    streaming: streaming || uploading || waiting,
  };
}
