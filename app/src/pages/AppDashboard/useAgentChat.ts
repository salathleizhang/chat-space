import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { taskSubjectLabel } from "../../shared/lib/taskText";
import {
  streamChat,
  type AskUserAnswer,
  type ChatResume,
  type LlmRequestConfig,
  type OutgoingChatMessage,
  type OutgoingContentPart,
} from "../../shared/lib/chatClient";
import {
  fetchLibraryAssets,
  uploadInspection,
  uploadSceneInspection,
  type LibraryAsset,
  type ProjectPlan,
} from "../../shared/lib/libraryApi";
import { uploadSource } from "../../shared/lib/workflowClient";
import {
  loadImageGenerateModelSettings,
  loadLlmSettings,
  loadThreeDModelSettings,
} from "../../shared/storage/apiKeys";
import type {
  AgentActivity,
  AgentAutoTurn,
  AgentMessageStatus,
  ChatAssetAttachment,
  ChatMessage,
} from "../../widgets/AgentDock";
import type { InspectionRequest, InspectionTarget } from "../../shared/lib/inspection";
import {
  DEFAULT_SCENE_VIEW,
  INSPECTION_VIEW_LIBRARY,
  isInspectionViewId,
  resolveInspectionViews,
  type InspectionViewId,
} from "../../shared/lib/inspectionSheet";
import { nextId } from "./useChatMessages";
import {
  modelInfoFromTaskResult,
  modelInfoSuffix,
  type TaskSettlement,
} from "./useTaskPolling";

/** 检查批次 id：agent 的 toolCallId 优先（可溯源到那一次工具调用），否则现造一个。 */
function inspectionBatchId(toolCallId?: string) {
  return (
    (toolCallId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) ||
    `i-${Date.now().toString(36)}`
  );
}

/** 状态行文案：单模型与整场景是两件事，别都说成"检查模型"。 */
function inspectionStatusLabel(target: InspectionTarget) {
  return target === "scene" ? "Inspecting the scene" : "Inspecting generated model";
}

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
  "start-scene-job",
  "revise-scene-job",
  "retry-scene-job-nodes",
  "start-3d-batch",
  "start-world-task",
  "start-skybox-task",
  "generate-texture",
  "retopologize",
  "rig-model",
  "segment-parts",
  "generate-character",
  "unwrap-uv",
]);

/** 完成后会立刻在 source/ 落盘图片，需要同步刷新图片库。 */
const IMAGE_OUTPUT_TOOLS = new Set([
  "generate-reference-images",
  "generate-clean-plate",
  "generate-skybox",
  "edit-reference-image",
]);

/**
 * 一轮结束时若有图片生成工具还没回结果（用户点了停止，或流断了），补几次项目状态
 * 刷新：那几个调用仍在服务端跑，落盘时机从几秒到两分钟不等，所以是递减频率的有限
 * 几次，而不是一条常驻轮询。0 那一档让同步落盘的图立刻可见。
 */
const IMAGE_CATCH_UP_DELAYS_MS = [0, 5_000, 15_000, 45_000, 120_000];

/**
 * 只读查询工具：它们不产生用户可见的动作，也不落任何产物，只把状态交回给模型。
 * 时间线是"这一步做了什么"的记录，查询本身不是一步——展示出来会和它正在等的那个
 * 生成步骤抢同一块地方，读起来像多了一步"checking generation progress"。
 * 失败仍然落一行：查不到状态是要让用户看见的，不该静默。
 *
 * ask-user 属于另一类静默：它的可见产物就是那张提问卡片，再在时间线上补一个
 * "asking for your decision" 节点等于把同一步说两遍。
 */
const SILENT_ACTIVITY_TOOLS = new Set(["list-generation-tasks", "get-scene-job", "ask-user"]);

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
  "inspect",
  "resume-generation",
  "repair-assets",
]);

/**
 * 计划续跑的止损：连续这么多次自动续跑都没有推进计划，就不再自己往下做，
 * 把界面交回给用户。判定"推进"的依据是这一轮里有 update-plan 的结果——
 * 计划在动就清零，所以 10 步的计划可以一路跑完，而模型原地打转时最多多跑两轮。
 */
const PLAN_AUTO_TURN_MAX_STALLS = 2;

const TOOL_ACTIVITY_MESSAGES: Readonly<Record<string, string>> = {
  "ask-user": "Asking for your decision",
  "update-plan": "Updating plan",
  "generate-reference-images": "Generating image",
  "generate-clean-plate": "Generating clean scene plate",
  "generate-skybox": "Generating skybox",
  "edit-reference-image": "Editing reference image",
  "analyze-scene": "Analyzing current scene",
  analyzeSceneTool: "Analyzing current scene",
  "analyze-reference": "Analyzing reference image",
  analyzeReferenceTool: "Analyzing reference image",
  "generate-plate": "Generating scene base image",
  "start-scene-job": "Generating complete scene",
  "revise-scene-job": "Updating complete scene",
  "retry-scene-job-nodes": "Rebuilding scene outputs",
  "get-scene-job": "Checking complete scene status",
  "start-3d-batch": "Starting 3D generation",
  "start-world-task": "Generating 3D world",
  "start-skybox-task": "Generating skybox",
  "generate-texture": "Generating textures",
  retopologize: "Retopologizing model",
  "rig-model": "Rigging model",
  "segment-parts": "Segmenting model",
  "generate-character": "Generating character",
  "unwrap-uv": "Unwrapping UVs",
  "build-cad-model": "Building CAD model",
  "get-cad-source": "Reading CAD source",
  "inspect": "Inspecting asset",
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
  // 旧服务与尚未结束的旧 SSE 流发的是 inspect-asset（只有单模型一种目标）；
  // 新工具是 inspect + target，两者在这里归一到同一个名字。
  if (name === "inspect-asset") return "inspect";
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
 * 这几条线彼此通过"流结束后自动让 Agent 继续下一轮"串联（inspect 的两种目标与
 * identify-asset 都是本轮不等待、流结束后再续跑），因此放在同一个 hook 里
 * 维护共享的 streaming/pending 状态，而不拆成互不相关的几个 hook。
 *
 * 续跑不是用户发言：产物（检查图、候选参考图、后台任务结果）走请求的 `resume`
 * 字段交给服务端注入本轮上下文，界面渲染成 Agent 侧卡片。让工作台代发一条带图
 * 用户消息也能跑通，但那条消息会冒充用户输入、被写进会话记录，还会在之后每一轮
 * 里被重复内联回传。
 *
 * 图片上传统一走对话（2026-07 起不再有独立的手动 uncover workflow 与
 * 「自动模式」开关）：上传后把图片和指令拼成一条带图用户消息交给 agent，
 * 只有明确进入参考图资产提取时，才依次调用 analyze-reference →
 * start-scene-job 内确认对象并创建可修订场景任务；普通图片直接由多模态 agent 阅读，
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
  /**
   * 整场景检查请求（inspect 工具，target=scene）：不开小窗，由主视口按机位截图。
   * 与 preview.inspection 是两条并列的通道——检查对象不同、执行者不同。
   */
  const [sceneInspection, setSceneInspection] = useState<InspectionRequest | null>(null);
  /** 已上传待交回 Agent 的检查截图：等当前 SSE 流结束后自动续跑下一轮 */
  const pendingInspectionRef = useRef<{
    target: InspectionTarget;
    assetSlug?: string;
    assetName?: string;
    /** 场景检查拍的是哪个机位（画面上有标注，续跑文案要跟它对齐） */
    view?: InspectionViewId;
    /** 资产检查拍了哪几个面 */
    views?: InspectionViewId[];
    path: string;
  } | null>(null);
  /** 待交回的候选资产参考图（identify-asset 工具事件）：同样等当前流结束后续跑 */
  const pendingIdentifyRef = useRef<{ assetSlug: string; path: string }[] | null>(null);
  /** 后台生成完成结果：等当前流结束后作为新一轮上下文交回 Agent，驱动其继续。 */
  const pendingTaskSettlementsRef = useRef<(TaskSettlement & { ownerId: string })[]>([]);
  // 一次 HTTP 回复结束不等于创作完成；任务、截图和续跑之间共享等待状态。
  const backgroundTasksRef = useRef(new Map<string, string>());
  const inspectionWaitRef = useRef<{
    ownerId: string;
    target: InspectionTarget;
    assetSlug?: string;
    view?: InspectionViewId;
  } | null>(null);
  const identifyingRef = useRef(false);
  /**
   * 本轮是否停在 ask-user 提问上。onDone 需要它来决定这一轮是"完成"还是
   * "等你决定"——提问后服务端会主动中止本轮，光看流结束分不出这两者。
   */
  const pendingQuestionRef = useRef(false);
  /**
   * 计划续跑的状态：本轮是不是计划续跑、期间计划有没有被推进过、连续无进展几轮。
   * 只有计划续跑自己置 active，任务/自检/参考图那几条链路不参与计数。
   */
  const planAutoTurnRef = useRef({ active: false, progressed: false, stalled: 0 });
  /**
   * 刚结束的这一轮里有没有工具（或上游）失败。
   *
   * 计划续跑据此让行：失败往往意味着要用户拍板（重试、换方案、付不付这笔钱），
   * 无人值守地自动重跑同一段付费步骤比停下来更糟。onToolError / onError 同步置位，
   * 每条新流开始时清零——和 planAutoTurnRef 一样属于"本轮"的状态。
   */
  const turnFailedRef = useRef(false);
  const registeredTasksRef = useRef(new Set<string>());
  const registeredInspectionsRef = useRef(new Set<string>());
  const generationEpochRef = useRef(0);
  /**
   * 本轮发起、还没拿到结果的图片生成工具（generate-reference-images 等）。
   *
   * 用户中途点"停止"时，服务端那几个在途调用**不会跟着停**：它们照旧跑完、把图写进
   * source/，但那一条 SSE 已经没人接收，图片也就永远进不了对话（2026-10-02 实测：
   * 16 张参考图全部落盘成功，界面上 16 条活动全是"Stopped"，对话里一张图都没有）。
   * 这里记着它们，是为了在这一轮结束时主动补几次项目状态刷新，让对账逻辑
   * （useReferenceImageSurfacing）不用等用户下一次操作才发现新图。
   */
  const pendingImageToolsRef = useRef(new Set<string>());
  const imageCatchUpTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [waiting, setWaiting] = useState(false);
  const hasPendingWork = () => backgroundTasksRef.current.size > 0 ||
    inspectionWaitRef.current !== null || identifyingRef.current;
  /**
   * 还有一条没被回答、也没被跳过的提问。
   *
   * 这是所有自动续跑的硬闸门。ask-user 之后服务端会主动中止本轮，于是本轮结束时
   * "流正常结束"与"干完了"长得一模一样；此时若后台任务恰好收尾、或自检图刚好上传完，
   * 续跑就会在用户还没点卡片时把 Agent 拉起来继续做——用户看到的是"我没回答它自己
   * 往下做了"。因此排队的工作在提问未决期间必须原地等，答案回来（或用户直接打字跳过）
   * 之后再发；排队内容不清空，只是不发。
   *
   * 同时查 messagesRef：刷新/恢复会话后 ref 是新的，只有消息上的提问卡片还在。
   */
  const hasUnansweredQuestion = () =>
    pendingQuestionRef.current ||
    messagesRef.current.some(
      (message) =>
        message.role === "assistant" &&
        Boolean(message.pendingQuestion) &&
        !message.questionAnswer &&
        !message.supersededQuestion,
    );
  /** 计划里还有没做完的步骤（cancelled 视为不用再做）。 */
  const hasUnfinishedPlan = () =>
    sessionPlanRef.current?.steps.some(
      (step) => step.status !== "completed" && step.status !== "cancelled",
    ) ?? false;

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
    setSceneInspection(null);
    identifyingRef.current = false;
    pendingTaskSettlementsRef.current = [];
    pendingInspectionRef.current = null;
    pendingIdentifyRef.current = null;
    pendingQuestionRef.current = false;
    planAutoTurnRef.current = { active: false, progressed: false, stalled: 0 };
    pendingImageToolsRef.current.clear();
    clearImageCatchUp();
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

  /** 取消还没到点的补刷新，避免卸载后继续请求项目状态。 */
  const clearImageCatchUp = () => {
    for (const timer of imageCatchUpTimersRef.current) clearTimeout(timer);
    imageCatchUpTimersRef.current = [];
  };

  /**
   * 本轮有图片生成工具没回结果时，补几次项目状态刷新。
   *
   * 那几个调用在服务端会继续跑完并把图写进 source/，界面唯一的发现通道是项目状态
   * 里的参考图清单（见 useReferenceImageSurfacing）；没有这一步的话，图片要等到
   * 用户下一次发言（onDone 才刷新）才现身。只在本轮结束时排一次，排完就清表。
   */
  const scheduleImageCatchUp = () => {
    if (pendingImageToolsRef.current.size === 0) return;
    pendingImageToolsRef.current.clear();
    clearImageCatchUp();
    for (const delay of IMAGE_CATCH_UP_DELAYS_MS) {
      imageCatchUpTimersRef.current.push(
        setTimeout(() => {
          if (activeRef.current) bumpRefresh();
        }, delay),
      );
    }
  };

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
        pendingSceneInspectionView: undefined,
        agentStatus: { label: "Follow-up stopped", status: "failed" },
      }));
    }
    backgroundTasksRef.current.clear();
    inspectionWaitRef.current = null;
    identifyingRef.current = false;
    pendingTaskSettlementsRef.current = [];
    pendingInspectionRef.current = null;
    pendingIdentifyRef.current = null;
    pendingQuestionRef.current = false;
    planAutoTurnRef.current = { active: false, progressed: false, stalled: 0 };
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
    /*
      被中止的图片生成会在服务端继续跑完并落盘（这里没有它们的返回事件），所以要主动
      补几次项目状态刷新，让新参考图自己冒出来——用户点了停止不等于放弃这些图，
      他下一步的判断（要不要继续 3D）正需要看到它们。
    */
    scheduleImageCatchUp();
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
      pendingQuestionRef.current = false;
      planAutoTurnRef.current = { active: false, progressed: false, stalled: 0 };
      // 卸载后不再补刷新：那些请求只会写进已经不在的界面
      clearImageCatchUp();
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
    list.flatMap<OutgoingChatMessage>(
      ({ role, content, images, assets }) => {
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
      },
    );

  /**
   * agent 检查请求（inspect 工具）：单模型走预览小窗的四视角截图，
   * 整场景走主视口的一个机位截图。两条通道共用回传（截图 → 落盘 → resume）。
   */
  const failInspection = (message: string) => {
    const owner = inspectionWaitRef.current;
    inspectionWaitRef.current = null;
    setSceneInspection(null);
    syncWaiting();
    if (owner) updateMessage(owner.ownerId, (current) => ({
      ...current,
      pendingInspectionAssetSlug: undefined,
      pendingSceneInspectionView: undefined,
      agentStatus: { label: "Inspection failed", status: "failed" },
    }));
    setActivity({ state: "attention", message });
    pushAssistant(`⚠️ ${message}`);
  };

  const startAssetInspection = async (
    assetSlug: string,
    toolCallId?: string,
    ownerId = activeAssistantIdRef.current,
    views?: InspectionViewId[],
  ) => {
    if (!projectSlug || !ownerId) return;
    const epoch = generationEpochRef.current;
    inspectionWaitRef.current = { ownerId, target: "asset", assetSlug };
    registeredInspectionsRef.current.add(ownerId);
    updateMessage(ownerId, (message) => ({
      ...message,
      pendingInspectionAssetSlug: assetSlug,
      pendingSceneInspectionView: undefined,
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
    setPreview({
      asset,
      inspection: {
        id: inspectionBatchId(toolCallId),
        target: "asset",
        ...(views && views.length > 0 ? { views } : {}),
      },
    });
  };

  /**
   * 整场景检查：不打开小窗，由主视口按请求里的机位拍一张。
   *
   * 机位由 agent 指定（它看得见上一张图，知道该换哪个方向）；这里不做自动取景的
   * 择优——"合适不合适"是看图之后才有的判断，只能由发起者下一轮再决定。
   */
  const startSceneInspection = (
    view?: InspectionViewId,
    toolCallId?: string,
    ownerId = activeAssistantIdRef.current,
  ) => {
    if (!projectSlug || !ownerId) return;
    const picked = view ?? DEFAULT_SCENE_VIEW;
    inspectionWaitRef.current = { ownerId, target: "scene", view: picked };
    registeredInspectionsRef.current.add(ownerId);
    updateMessage(ownerId, (message) => ({
      ...message,
      pendingInspectionAssetSlug: undefined,
      pendingSceneInspectionView: picked,
      agentStatus: { label: "Inspecting the scene", status: "running" },
    }));
    syncWaiting();
    setActivity({ state: "working", message: "Inspecting the scene" });
    setSceneInspection({
      id: inspectionBatchId(toolCallId),
      target: "scene",
      views: [picked],
    });
  };

  /** 截图完成：上传落盘，等当前流结束后作为 Agent 自己的自检产物继续下一轮 */
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
          pendingInspectionRef.current = {
            target: "asset",
            assetSlug: current.asset.assetSlug,
            assetName: current.asset.name,
            views: current.inspection?.views,
            path,
          };
          if (!streamingRef.current) flushPendingInspection();
        })
        .catch((err) => {
          if (!activeRef.current || epoch !== generationEpochRef.current) return;
          failInspection(`Failed to upload inspection image: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [preview, pushAssistant],
  );

  /** 整场景检查图完成：与单模型同一条回传路径，只是落盘在项目级目录。 */
  const handleSceneInspectionCaptured = useCallback(
    (id: string, pngBase64: string | null) => {
      const current = sceneInspection;
      const epoch = generationEpochRef.current;
      if (!inspectionWaitRef.current || current?.id !== id) return;
      setSceneInspection(null);
      if (!current) return;
      if (!pngBase64) {
        failInspection("Inspection screenshot failed: the scene did not render in the viewport.");
        return;
      }
      void uploadSceneInspection(projectSlug, id, pngBase64)
        .then((path) => {
          if (!activeRef.current || epoch !== generationEpochRef.current) return;
          pendingInspectionRef.current = {
            target: "scene",
            view: current.views?.[0] ?? DEFAULT_SCENE_VIEW,
            path,
          };
          if (!streamingRef.current) flushPendingInspection();
        })
        .catch((err) => {
          if (!activeRef.current || epoch !== generationEpochRef.current) return;
          failInspection(`Failed to upload inspection image: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [sceneInspection, projectSlug, pushAssistant],
  );

  /**
   * 让 Agent 看自己刚渲染出来的检查图并继续判断（单模型四视角，或整场景一个机位）。
   *
   * 检查图走 resume 而不是一条带图用户消息：图片在协议上仍然只能借 user 角色
   * 进模型，但服务端只把它接在本轮上下文末尾，工作台不写进会话记录，界面渲染成
   * Agent 侧的产物卡片——这一步的发起者是 Agent，不该留下用户发过图的痕迹。
   *
   * 返回是否真的发出了一轮——调用方据此串行化，见 onDone 的说明。
   */
  const flushPendingInspection = (): boolean => {
    // 守卫与 startStream 同款：已有流在跑时不清队、不 push，否则排队内容丢失、消息成孤儿气泡
    if (streamingRef.current) return false;
    // 提问未决：自检图先留在队里，等用户回答（或直接打字跳过）之后再交回模型
    if (hasUnansweredQuestion()) return false;
    const pending = pendingInspectionRef.current;
    if (!pending) return false;
    pendingInspectionRef.current = null;
    const owner = inspectionWaitRef.current;
    inspectionWaitRef.current = null;
    syncWaiting();
    if (owner) updateMessage(owner.ownerId, (message) => ({
      ...message,
      pendingInspectionAssetSlug: undefined,
      pendingSceneInspectionView: undefined,
      agentStatus: { label: "Inspection images ready", status: "completed" },
    }));
    const sceneCheck = pending.target === "scene";
    const view = pending.view ?? DEFAULT_SCENE_VIEW;
    const views = resolveInspectionViews(pending.views);
    startStream(toOutgoingHistory(messagesRef.current), {
      resume: {
        kind: "inspection",
        text: sceneCheck
          ? [
              `[Scene check] whole project scene, camera view "${view}" (${INSPECTION_VIEW_LIBRARY[view].label}).`,
              "Check this image against the user's intent for the scene as a whole.",
              `If this camera is unusable (scene out of frame, blocked, or too small to judge), call inspect again with target="scene" and one of iso/front/right/top/left/back/bottom as the new view — at most 3 camera changes — then report what you can and cannot see.`,
            ].join(" ")
          : `[Self-check] ${pending.assetSlug ?? ""}: ${views.length} view${views.length === 1 ? "" : "s"} (2×2 sheet, reading order: ${views.map((item) => item.label).join(" / ")}). Check each view.`,
        images: [pending.path],
      },
      autoTurn: {
        kind: "inspection",
        label: sceneCheck
          ? `Scene check · whole scene · ${INSPECTION_VIEW_LIBRARY[view].label}`
          : `Self-check · ${pending.assetName ?? pending.assetSlug ?? ""} · ${views.map((item) => item.label).join(" / ")}`,
        images: [pending.path],
      },
    });
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

  /** 把候选资产的参考图依次交回 Agent，触发身份确认轮（同样不是用户消息） */
  const flushPendingIdentify = (): boolean => {
    if (streamingRef.current) return false;
    // 提问未决：参考图先留在队里（同上）
    if (hasUnansweredQuestion()) return false;
    const pending = pendingIdentifyRef.current;
    if (!pending || pending.length === 0) return false;
    pendingIdentifyRef.current = null;
    identifyingRef.current = false;
    syncWaiting();
    const slugs = pending.map((p) => p.assetSlug).join(", ");
    startStream(toOutgoingHistory(messagesRef.current), {
      resume: {
        kind: "identify",
        text: `[Identity check] Candidate asset reference images, in order: ${slugs}. Confirm each identity against its reference image.`,
        images: pending.map((p) => p.path),
      },
      autoTurn: {
        kind: "identify",
        label: `Checking identities · ${slugs}`,
        images: pending.map((p) => p.path),
      },
    });
    return true;
  };

  /** 把已结束的后台任务交回同一会话的 Agent，让它继续原任务（不是用户消息）。 */
  const flushPendingTaskSettlements = (): boolean => {
    if (streamingRef.current) return false;
    // 提问未决：任务完成通知先留在队里（任务 id 也先留着，界面继续显示"还在生成"），
    // 等用户回答；否则 Agent 会拿着任务结果继续做，把还没回答的问题绕过去
    if (hasUnansweredQuestion()) return false;
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
    const failed = tasks.filter((task) => task.status !== "succeeded").length;
    /**
     * 3D 任务的结算行里带上服务端测到的面数与"是不是高模"：Agent 收到这条通知就要决定
     * 要不要弹降面卡片，数据在这一行给全，省掉一次 list-generation-tasks 往返。
     */
    const modelTaskSuffix = (task: (typeof tasks)[number]) =>
      task.workflowId === "3d" && task.status === "succeeded"
        ? modelInfoSuffix(task.result)
        : "";
    const highPoly = tasks.some(
      (task) =>
        task.workflowId === "3d" &&
        task.status === "succeeded" &&
        modelInfoFromTaskResult(task.result)?.highPoly === true,
    );
    startStream(toOutgoingHistory(messagesRef.current), {
      resume: {
        kind: "tasks",
        text: [
          "[Background tasks finished]",
          ...tasks.map((task) =>
            task.status === "succeeded"
              ? `- ${taskSubjectLabel(task.subject)}: succeeded${modelTaskSuffix(task)}`
              : `- ${taskSubjectLabel(task.subject)}: failed (${task.error ?? "Unknown error"})`,
          ),
          ...(highPoly
            ? [
                "At least one finished 3D model is high-poly. Before delivering it, ask the user once with ask-user whether to run the decimation tool (the Auto low-poly options plus a keep-high-poly option), and only call retopologize if they agree — see the high-poly rule in your instructions.",
              ]
            : []),
          "Continue the original request automatically: check the finished outputs, then deliver the result. Only call inspect if the user asked for a check or raised a question about the result — a finished single-model generation is delivered without a self-check. A finished complete-scene job ends with one whole-scene check (inspect with target=\"scene\"). Do not ask the user to check back or repeat successful paid generation. Continue the existing plan without recreating it.",
        ].join("\n"),
      },
      autoTurn: {
        kind: "tasks",
        label: failed > 0
          ? `Background generation finished · ${failed} of ${tasks.length} failed`
          : `Background generation finished · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      },
    });
    return true;
  };

  /**
   * 计划还没做完就自己接着做（Agent 自发续跑的一种，没有产物，只有一个指令块）。
   *
   * 一条计划常常跨多轮：模型做完第 3 步、回一句"第 3 步完成"就结束本轮，而没有任何
   * 排队工作会把它拉起来——界面落回"发送"，用户必须自己再点一次才继续，看起来就是
   * "每做完一步就停"。只要计划里还有没做完的步骤，就在这里自动开下一轮。
   *
   * 三道刹车，缺一不可：
   * - 提问未决不续跑（见 hasUnansweredQuestion）：用户还没决定，不能替他往下走；
   * - 有后台工作在跑不续跑：那条链路收尾时自己会开下一轮，现在开只会空跑一轮；
   * - 连续无进展不续跑（PLAN_AUTO_TURN_MAX_STALLS）：计划没动就是在原地打转。
   */
  const flushPlanContinuation = (): boolean => {
    if (streamingRef.current) return false;
    if (hasUnansweredQuestion()) return false;
    // 上一轮有失败：把方向盘交回用户，不自动重跑计划里的下一步
    if (turnFailedRef.current) return false;
    if (hasPendingWork()) return false;
    const plan = sessionPlanRef.current;
    if (!plan) return false;
    const remaining = plan.steps.filter(
      (step) => step.status !== "completed" && step.status !== "cancelled",
    );
    if (remaining.length === 0) return false;
    if (planAutoTurnRef.current.stalled >= PLAN_AUTO_TURN_MAX_STALLS) return false;
    const total = plan.steps.length;
    const next = remaining.find((step) => step.status === "in_progress") ?? remaining[0]!;
    planAutoTurnRef.current = {
      active: true,
      progressed: false,
      stalled: planAutoTurnRef.current.stalled,
    };
    startStream(toOutgoingHistory(messagesRef.current), {
      resume: {
        kind: "plan",
        text: [
          `[Plan continues] ${plan.title ? `"${plan.title}"` : "The current plan"} still has ${remaining.length} of ${total} steps unfinished.`,
          `Next up: ${next.id} — ${next.content}.`,
          "Keep executing the plan automatically, step by step, without asking the user to confirm routine progress; record each finished step with update-plan before you end this turn.",
          "If a decision only the user can make is needed (a paid action, choosing between options, confirming an object), call ask-user and stop.",
        ].join(" "),
      },
      autoTurn: {
        kind: "plan",
        label: `Continuing plan · ${total - remaining.length}/${total} steps done`,
      },
    });
    return true;
  };

  /** 上一轮如果是计划续跑，按"计划有没有被推进"结算停滞计数。 */
  const finishPlanAutoTurn = () => {
    const state = planAutoTurnRef.current;
    if (!state.active) return;
    state.active = false;
    state.stalled = state.progressed ? 0 : state.stalled + 1;
    state.progressed = false;
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

  /**
   * 驱动一轮 agent 对话流（send 与三种自动续跑共用）。
   *
   * `resume` 是 Agent 自发续跑时本轮要看的产物：它不进 messages，由服务端接在
   * 上下文末尾；`autoTurn` 是同一次续跑在界面上的展示形态（Agent 侧卡片）。
   * `answer` 是用户点卡片作出的选择：同样不进 messages，界面上只在卡片里显示。
   */
  const startStream = (
    history: OutgoingChatMessage[],
    turn: {
      resume?: ChatResume;
      autoTurn?: AgentAutoTurn;
      answer?: AskUserAnswer;
    } = {},
  ) => {
    const { resume, autoTurn, answer } = turn;
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
    turnFailedRef.current = false;
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      ...(autoTurn ? { autoTurn } : {}),
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
          // 记在途的图片生成：这一轮结束时若还没回结果，就补几次项目状态刷新（见 scheduleImageCatchUp）
          if (IMAGE_OUTPUT_TOOLS.has(name)) {
            pendingImageToolsRef.current.add(toolCallId ?? name);
          }
          // inspect 的两种目标在状态行里是两件事：检查一个模型 vs 检查整个场景。
          const label = name === "inspect" && args?.target === "scene"
            ? inspectionStatusLabel("scene")
            : toolActivityMessage(name);
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
          if (name === "inspect") {
            // views 只保留认识的 id：模型给错名字时退化成默认视角，而不是让整条链路失败。
            const views = Array.isArray(args?.views)
              ? args.views.filter((view): view is InspectionViewId => isInspectionViewId(view))
              : undefined;
            if (args?.target === "scene") {
              void startSceneInspection(views?.[0], toolCallId);
            } else if (typeof args?.assetSlug === "string") {
              void startAssetInspection(args.assetSlug, toolCallId, undefined, views);
            }
          } else if (
            name === "identify-asset" &&
            Array.isArray(args?.assetSlugs) &&
            args.assetSlugs.every((slug): slug is string => typeof slug === "string")
          ) {
            void startIdentify(args.assetSlugs);
          }
        },
        onToolResult: (name, toolCallId, images, taskIds, updatedPlan, question) => {
          if (!activeRef.current || controller.signal.aborted) return;
          name = canonicalToolName(name);
          replying = false;
          if (question) pendingQuestionRef.current = true;
          const status: AgentMessageStatus = question
            ? { label: "Waiting for your decision", status: "waiting" }
            : { label: "Thinking", status: "running" };
          updateMessage(assistantId, (message) => {
            const nextImages = images?.filter(
              (path) => !message.images?.includes(path),
            );
            return {
              ...message,
              ...(nextImages && nextImages.length > 0
                ? { images: [...(message.images ?? []), ...nextImages] }
                : {}),
              ...(question
                ? { pendingQuestion: question, supersededQuestion: undefined }
                : {}),
              agentStatus: status,
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
          setActivity(
            question
              ? { state: "waiting", message: "Waiting for your decision" }
              : { state: "working", message: "Thinking" },
          );
          if (name === "update-plan" && updatedPlan) {
            sessionPlanRef.current = updatedPlan;
            onPlanUpdated?.(updatedPlan);
            // 计划续跑期间改了计划 = 有进展，止损计数清零
            if (planAutoTurnRef.current.active) planAutoTurnRef.current.progressed = true;
          }
          if (IMAGE_OUTPUT_TOOLS.has(name)) {
            pendingImageToolsRef.current.delete(toolCallId ?? name);
            bumpRefresh();
          }
          if (TASK_STARTING_TOOLS.has(name) && taskIds && taskIds.length > 0) {
            trackTasks(assistantId, taskIds);
          }
        },
        onToolError: (name, toolCallId, errorMessage) => {
          if (!activeRef.current || controller.signal.aborted) return;
          name = canonicalToolName(name);
          // 明确失败的工具不会再产出图片，不必为它补刷新
          if (IMAGE_OUTPUT_TOOLS.has(name)) {
            pendingImageToolsRef.current.delete(toolCallId ?? name);
          }
          turnFailedRef.current = true;
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
          // 计划续跑这轮失败了：按"没有推进"结账，别让计数卡在 active 上
          turnFailedRef.current = true;
          finishPlanAutoTurn();
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
          // 流出错时在途的图片生成同样会跑完落盘，补刷新让它们进对话
          scheduleImageCatchUp();
        },
        onDone: () => {
          if (!activeRef.current || controller.signal.aborted) return;
          abortRef.current = null;
          activeAssistantIdRef.current = null;
          markStreaming(false);
          // 正常结束的轮次里图片工具都已回结果（表已清空），这里是给"没回结果"兜底
          scheduleImageCatchUp();
          /*
            提问后服务端会主动中止本轮，所以流同样是正常结束的——光看"流结束"分不出
            "干完了"和"在等你决定"。pendingQuestionRef 在 onToolResult 里同步置位，
            这里据此把状态行与结束提示分开。
          */
          const waitingForAnswer = pendingQuestionRef.current;
          // 先结账上一轮是不是"计划续跑且没有推进"，再判断这一轮还该不该接着跑
          finishPlanAutoTurn();
          const working = hasPendingWork();
          const failedTurn = turnFailedRef.current;
          /*
            计划还有没做完的步骤时，这一轮不该显示"Completed"：要么马上自动开下一轮
            （planContinues），要么已经连跑几轮没进展、停下来等用户说一句（planPaused）。
            两者都不是"干完了"。
          */
          const planContinues =
            !waitingForAnswer &&
            !working &&
            !failedTurn &&
            hasUnfinishedPlan() &&
            planAutoTurnRef.current.stalled < PLAN_AUTO_TURN_MAX_STALLS;
          const planPaused =
            !waitingForAnswer &&
            !working &&
            !failedTurn &&
            hasUnfinishedPlan() &&
            !planContinues;
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
              agentStatus: waitingForAnswer
                ? { label: "Waiting for your decision", status: "waiting" }
                : hasFailedStep
                  ? { label: "Some steps failed", status: "failed" }
                  : working
                    ? { label: inspectionWaitRef.current
                        ? inspectionStatusLabel(inspectionWaitRef.current.target)
                        : "Generating; will continue automatically", status: "running" }
                    : planContinues
                      ? { label: "Continuing plan", status: "running" }
                      : planPaused
                        ? { label: "Plan paused; unfinished steps remain", status: "completed" }
                        : { label: "Completed", status: "completed" },
              activities,
            };
          });
          setActivity(
            waitingForAnswer
              ? { state: "waiting", message: "Waiting for your decision" }
              : working
                ? { state: "working", message: inspectionWaitRef.current
                    ? inspectionStatusLabel(inspectionWaitRef.current.target)
                    : "Generating; will continue automatically" }
                : planContinues
                  ? { state: "working", message: "Continuing plan" }
                  : planPaused
                    ? { state: "attention", message: "Plan paused; unfinished steps remain" }
                    : { state: "idle", message: "Agent finished responding" },
          );
          // agent 可能更新了计划或产出了资产：刷新派生状态
          bumpRefresh();
          /*
            两条回传只能串行发，不能都发：agent 完全可能在同一轮里既调 inspect
            又调 identify-asset，两个 flush 各自 startStream 就会并发拉起两条 SSE 流；
            而且第二条的 history 取自 messagesRef，此时还没包含第一条刚 push 的消息，
            两条流会带着分叉的历史打给 agent、回复交错写进两个气泡。
            这里只发第一条——它的 onDone 会再走到这里，把剩下那条接着发出去。
            三条都没有时，才轮到"计划还没做完就接着做"。

            推迟一个宏任务再发：最后几个 delta 和 done 常落在同一个网络 chunk 里、
            被同步连续处理，此刻 appendTo 的 setState 还没提交，messagesRef 里的
            assistant 回复缺尾巴（短回复甚至整段是空的）——等 React 提交完再取
            history 才是完整的。项目切换/卸载时 pending 队列已被 cleanup 清空，
            这个延迟回调届时是 no-op，不会往新项目里发。
          */
          setTimeout(() => {
            if (!activeRef.current || controller.signal.aborted) return;
            if (
              !flushPendingInspection() &&
              !flushPendingIdentify() &&
              !flushPendingTaskSettlements()
            ) {
              flushPlanContinuation();
            }
          }, 0);
        },
      },
      {
        threeDModel: loadThreeDModelSettings().model || undefined,
        imageGenerateModel:
          loadImageGenerateModelSettings().model || undefined,
        plan: sessionPlanRef.current ?? undefined,
        ...(resume ? { resume } : {}),
        ...(answer ? { answer } : {}),
      },
      controller.signal,
    );
  };

  /**
   * 用户没点卡片、直接在输入框里回了别的：把还挂着的提问标成"已忽略"。
   *
   * 不删除问题本身——「Agent 问过什么、我当时没选」在历史里仍然可追溯；
   * 卡片只是置灰，不再可点。用户想真正回答时仍可以点旧卡片，那会另起一轮。
   */
  const supersedePendingQuestions = () => {
    for (const message of messagesRef.current) {
      if (message.role !== "assistant") continue;
      if (!message.pendingQuestion || message.questionAnswer) continue;
      updateMessage(message.id, (current) => ({
        ...current,
        supersededQuestion: true,
      }));
    }
    pendingQuestionRef.current = false;
  };

  const send = (
    text: string,
    imageFiles?: File[],
    assets?: ChatAssetAttachment[],
  ) => {
    // 提前拦一道：拦在这里才不会推入一条注定得不到回复的用户消息
    // （startStream 里那道是真正的不变量，两者不重复，职责不同）
    if (streamingRef.current || uploadingRef.current || hasPendingWork()) return;
    supersedePendingQuestions();
    // 用户重新开口 = 新的意图，计划续跑的止损计数从头开始
    planAutoTurnRef.current = { active: false, progressed: false, stalled: 0 };
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

  /**
   * 用户在 ask-user 卡片上作出选择。
   *
   * 回答走请求的 `answer` 字段，**不推一条用户消息**：用户点的是卡片，不是发言，
   * 历史里不该因此多出一条气泡、会话标题也不该被"同意"占掉。界面上只在卡片内部
   * 把状态转成"已选择：X"，服务端把答案接在本轮上下文末尾交给模型。
   */
  const answerQuestion = (ownerMessageId: string, answer: AskUserAnswer) => {
    /*
      这里**不看** hasPendingWork()：提问未决期间自动续跑全被闸住了，如果连回答也要等
      后台任务跑完，用户就会卡在一个既不能回答、Agent 又不动的死局里（任务完成通知
      同样在队里等着，只有回答才能解锁）。回答之后的 onDone 会把排队的工作接着发出去。
    */
    if (streamingRef.current || uploadingRef.current) return;
    pendingQuestionRef.current = false;
    planAutoTurnRef.current = { active: false, progressed: false, stalled: 0 };
    updateMessage(ownerMessageId, (message) => ({
      ...message,
      questionAnswer: answer,
      supersededQuestion: undefined,
      agentStatus: { label: "Answered", status: "completed" },
    }));
    setActivity({ state: "working", message: "Thinking" });
    startStream(toOutgoingHistory(messagesRef.current), { answer });
  };

  // 只恢复当前会话明确记录的任务；不把其他会话的项目任务接到这里。
  useEffect(() => {
    if (!sessionReady) return;
    for (const message of messagesRef.current) {
      if (message.role !== "assistant") continue;
      if (message.pendingTaskIds?.length) trackTasks(message.id, message.pendingTaskIds);
      if (message.pendingInspectionAssetSlug && !registeredInspectionsRef.current.has(message.id)) {
        void startAssetInspection(message.pendingInspectionAssetSlug, undefined, message.id);
      } else if (
        message.pendingSceneInspectionView &&
        !registeredInspectionsRef.current.has(message.id)
      ) {
        startSceneInspection(
          isInspectionViewId(message.pendingSceneInspectionView)
            ? message.pendingSceneInspectionView
            : undefined,
          undefined,
          message.id,
        );
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
    sceneInspection,
    handleInspectionCaptured,
    handleSceneInspectionCaptured,
    send,
    answerQuestion,
    stopStream,
    streaming: streaming || uploading || waiting,
  };
}
