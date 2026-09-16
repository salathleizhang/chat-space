import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  "edit-reference-image",
]);

const TOOL_ACTIVITY_MESSAGES: Readonly<Record<string, string>> = {
  "update-plan": "正在更新计划",
  "generate-reference-images": "正在生成参考图",
  "edit-reference-image": "正在修改参考图",
  "analyze-scene": "正在分析当前场景",
  analyzeSceneTool: "正在分析当前场景",
  "analyze-reference": "正在分析参考图",
  analyzeReferenceTool: "正在分析参考图",
  "confirm-reference-assets": "正在确认参考图资产",
  confirmReferenceAssetsTool: "正在确认参考图资产",
  "generate-plate": "正在生成场景底图",
  "run-one-shot": "正在生成完整场景",
  "start-3d-batch": "正在启动 3D 生成",
  "start-world-task": "正在生成 3D 世界",
  "start-skybox-task": "正在生成天空盒",
  "generate-texture": "正在生成贴图",
  retopologize: "正在重拓扑",
  "rig-model": "正在绑定骨骼",
  "generate-animation": "正在生成动画",
  "segment-parts": "正在拆分模型",
  "generate-character": "正在生成角色",
  "unwrap-uv": "正在展开 UV",
  "build-cad-model": "正在构建 CAD 模型",
  "get-cad-source": "正在读取 CAD 源码",
  "inspect-asset": "正在检查资产",
  "identify-asset": "正在确认资产身份",
  "list-generation-tasks": "正在读取生成进度",
  "resume-generation": "正在继续生成",
  "repair-assets": "正在修复资产",
  "fal-wildcard-search": "正在调用扩展能力",
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
  return TOOL_ACTIVITY_MESSAGES[name] ?? `正在调用 ${name} 工具`;
}

function completedToolActivityMessage(name: string) {
  const running = toolActivityMessage(name);
  return running.startsWith("正在") ? `已${running.slice(2)}` : `${running}已完成`;
}

function failedToolActivityMessage(name: string) {
  const running = toolActivityMessage(name);
  return running.startsWith("正在") ? `${running.slice(2)}失败` : `${running}失败`;
}

interface UseAgentChatOptions {
  projectSlug: string;
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
 * confirm-reference-assets → 按需 run-one-shot；普通图片直接由多模态 agent 阅读，
 * 粒度全靠对话里的指令决定。
 */
export function useAgentChat({
  projectSlug,
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
  const pendingTaskSettlementsRef = useRef<TaskSettlement[]>([]);
  /**
   * 是否有一条 SSE 流在跑。ref 供各处同步判断（回传排队要在回调里立刻读到），
   * state 供 UI 渲染——刻意不复用 `activity.state === "working"`：后台生成任务
   * 轮询期间它同样是 working，拿它当判据会在一次几分钟的模型生成期间把输入锁死。
   */
  const streamingRef = useRef(false);
  const [streaming, setStreaming] = useState(false);
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
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    markStreaming(false);
    const assistantId = activeAssistantIdRef.current;
    activeAssistantIdRef.current = null;
    if (assistantId) {
      updateMessage(assistantId, (message) => ({
        ...message,
        agentStatus: { label: "已停止", status: "failed" },
        activities: message.activities?.map((item) =>
          item.status === "running"
            ? { ...item, label: "已停止", status: "failed" as const }
            : item,
        ),
      }));
    }
    setActivity({ state: "idle", message: "已停止本轮生成" });
  };

  /**
   * 卸载时中止在途流，并丢弃尚未回传的自检、参考图和后台任务结果。
   */
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      activeAssistantIdRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
      pendingInspectionRef.current = null;
      pendingIdentifyRef.current = null;
      pendingTaskSettlementsRef.current = [];
    };
  }, []);

  /** 普通图片消息：上传落盘 → 带真实图片部件交给多模态 agent；不预设参考图意图。 */
  const startImageMessage = async (
    file: File,
    note: string,
    assets?: ChatAssetAttachment[],
  ) => {
    try {
      setActivity({ state: "working", message: `正在上传 ${file.name}` });
      const imagePath = await uploadSource(projectSlug, file);
      if (!activeRef.current) return;

      const instruction = note || "请查看这张图片。";
      const userMessage: ChatMessage = {
        id: nextId(),
        role: "user",
        content: instruction,
        images: [imagePath],
        ...(assets && assets.length > 0 ? { assets } : {}),
      };
      const history = toOutgoingHistory([...messagesRef.current, userMessage]);
      pushMessage(userMessage);
      startStream(history);
    } catch (err) {
      if (!activeRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setActivity({ state: "attention", message });
      pushAssistant(`⚠️ ${message}`);
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
  const startInspection = async (assetSlug: string, toolCallId?: string) => {
    if (!projectSlug) return;
    let assets: LibraryAsset[];
    try {
      assets = await fetchLibraryAssets(projectSlug);
    } catch (err) {
      if (activeRef.current) {
        pushAssistant(`⚠️ 自检失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!activeRef.current) return;
    const asset = assets.find((a) => a.assetSlug === assetSlug);
    if (!asset?.modelPath) {
      pushAssistant(`⚠️ 自检失败：资产「${assetSlug}」没有可渲染的模型产物。`);
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
      setPreview((p) => (p ? { ...p, inspection: null } : p));
      if (!current) return;
      if (!pngBase64) {
        pushAssistant("⚠️ 自检截图失败：模型未能在小窗中完成渲染。");
        return;
      }
      void uploadInspection(
        current.asset.projectSlug,
        current.asset.assetSlug,
        id,
        pngBase64,
      )
        .then((path) => {
          if (!activeRef.current) return;
          pendingInspectionRef.current = { assetSlug: current.asset.assetSlug, path };
          if (!streamingRef.current) flushPendingInspection();
        })
        .catch((err) => {
          if (!activeRef.current) return;
          pushAssistant(
            `⚠️ 检查图上传失败：${err instanceof Error ? err.message : String(err)}`,
          );
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
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: `【自检截图】${pending.assetSlug} 的四视角检查图（左上 ISO / 右上 FRONT / 左下 RIGHT / 右下 TOP），请逐视角检查。`,
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
    let assets: LibraryAsset[];
    try {
      assets = await fetchLibraryAssets(projectSlug);
    } catch (err) {
      if (activeRef.current) {
        pushAssistant(`⚠️ 身份识别失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!activeRef.current) return;
    // slug → asset 建一次表，避免对每个候选 slug 都线性扫一遍 assets
    const bySlug = new Map(assets.map((a) => [a.assetSlug, a]));
    const found = assetSlugs
      .map((slug) => bySlug.get(slug))
      .filter((a): a is LibraryAsset => Boolean(a && a.sourceImages.length > 0));
    if (found.length === 0) {
      pushAssistant("⚠️ 身份识别失败：候选资产都没有参考图。");
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
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: `【候选资产参考图】按顺序对应：${pending.map((p) => p.assetSlug).join("、")}，请对照参考图确认身份。`,
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
    const tasks = settlements.flatMap((settlement) => settlement.tasks);
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: [
        "【后台任务已结束】",
        ...tasks.map((task) =>
          task.status === "succeeded"
            ? `- ${task.subject}：成功`
            : `- ${task.subject}：失败（${task.error ?? "未知错误"}）`,
        ),
        "请从当前计划的下一未完成步骤继续；不要重新创建或改写计划结构。",
      ].join("\n"),
    };
    const history = toOutgoingHistory([...messagesRef.current, userMessage]);
    pushMessage(userMessage);
    startStream(history);
    return true;
  };

  const queueTaskSettlement = (settlement: TaskSettlement) => {
    pendingTaskSettlementsRef.current.push(settlement);
    // 轮询回报消息也是本 tick 才写入 React；推迟后再取完整历史。
    setTimeout(() => {
      if (activeRef.current && !streamingRef.current) {
        flushPendingTaskSettlements();
      }
    }, 0);
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
      pushAssistant("⚠️ 上一轮还在进行中。请等它结束，或点停止按钮中断后再发。");
      return;
    }
    const llm = llmConfig();
    const assistantId = nextId();
    let toolSequence = 0;
    let replying = false;
    let streamedContent = "";
    let pendingBackgroundBatches = 0;
    let pendingModelCount = 0;
    let backgroundTaskFailed = false;
    pushMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      agentStatus: { label: "正在思考", status: "running" },
    });
    activeAssistantIdRef.current = assistantId;
    setActivity({ state: "working", message: "正在思考" });
    markStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    void streamChat(
      projectSlug,
      history,
      llm,
      {
        onDelta: (delta) => {
          if (!delta) return;
          streamedContent += delta;
          if (!replying) {
            replying = true;
            setActivity({ state: "working", message: "正在回复" });
            updateMessage(assistantId, (message) => ({
              ...message,
              agentStatus: { label: "正在回复", status: "running" },
            }));
          }
          appendTo(assistantId, (content) => content + delta);
        },
        onTool: (name, toolCallId, args) => {
          name = canonicalToolName(name);
          const label = toolActivityMessage(name);
          const activityId = toolCallId ?? `tool-${assistantId}-${++toolSequence}`;
          replying = false;
          setActivity({ state: "working", message: label });
          updateMessage(assistantId, (message) => ({
            ...message,
            agentStatus: { label, status: "running" },
            activities: [
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
              agentStatus: { label: "正在思考", status: "running" },
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
          setActivity({ state: "working", message: "正在思考" });
          if (name === "update-plan" && updatedPlan) {
            sessionPlanRef.current = updatedPlan;
            onPlanUpdated?.(updatedPlan);
          }
          if (IMAGE_OUTPUT_TOOLS.has(name)) bumpRefresh();
          if (TASK_STARTING_TOOLS.has(name) && taskIds && taskIds.length > 0) {
            pendingBackgroundBatches += 1;
            if (name === "start-3d-batch") pendingModelCount += taskIds.length;
            pollTasks(taskIds, (settlement) => {
              pendingBackgroundBatches -= 1;
              if (name === "start-3d-batch") {
                pendingModelCount = Math.max(0, pendingModelCount - settlement.tasks.length);
              }
              backgroundTaskFailed ||= settlement.tasks.some(
                (task) => task.status === "failed",
              );
              updateMessage(assistantId, (message) => ({
                ...message,
                agentStatus: backgroundTaskFailed
                  ? { label: "后台任务失败", status: "failed" }
                  : { label: "后台任务已结束", status: "completed" },
              }));
              queueTaskSettlement(settlement);
            });
          }
        },
        onToolError: (name, toolCallId, errorMessage) => {
          name = canonicalToolName(name);
          const failureLabel = failedToolActivityMessage(name);
          const label = errorMessage
            ? `${failureLabel}：${errorMessage}`
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
              agentStatus: { label: "正在思考", status: "running" },
              activities,
            };
          });
          setActivity({ state: "working", message: "正在思考" });
        },
        onError: (message) => {
          abortRef.current = null;
          activeAssistantIdRef.current = null;
          markStreaming(false);
          setActivity({ state: "attention", message });
          updateMessage(assistantId, (assistant) => ({
            ...assistant,
            agentStatus: { label: "执行失败", status: "failed" },
            activities: assistant.activities?.map((item) =>
              item.status === "running"
                ? { ...item, label: "执行失败", status: "failed" as const }
                : item,
            ),
          }));
          // 错误同时落进对话气泡：状态行会被下一个状态顶掉，只写那里等于静默失败
          appendTo(assistantId, (content) =>
            content ? `${content}\n\n⚠️ ${message}` : `⚠️ ${message}`,
          );
        },
        onDone: () => {
          abortRef.current = null;
          activeAssistantIdRef.current = null;
          markStreaming(false);
          updateMessage(assistantId, (message) => {
            const activities = message.activities?.map((item) =>
              item.status === "running"
                ? {
                    ...item,
                    label: item.toolName
                      ? completedToolActivityMessage(item.toolName)
                      : item.label,
                    status: "completed" as const,
                  }
                : item,
            );
            const hasFailedStep = activities?.some(
              (item) => item.status === "failed",
            );
            return {
              ...message,
              agentStatus: hasFailedStep || backgroundTaskFailed
                ? { label: "部分步骤失败", status: "failed" }
                : pendingBackgroundBatches > 0
                  ? { label: "后台任务进行中", status: "running" }
                : { label: "已完成", status: "completed" },
              activities,
            };
          });
          setActivity(
            pendingBackgroundBatches > 0
              ? {
                  state: "working",
                  message:
                    pendingModelCount > 1
                      ? `正在并行生成 ${pendingModelCount} 个模型`
                      : pendingModelCount === 1
                        ? "正在生成 1 个模型"
                        : "后台任务进行中",
                }
              : { state: "idle", message: "Agent 已完成回复" },
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
            if (!activeRef.current) return;
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
    imageFile?: File,
    assets?: ChatAssetAttachment[],
  ) => {
    // 提前拦一道：拦在这里才不会推入一条注定得不到回复的用户消息
    // （startStream 里那道是真正的不变量，两者不重复，职责不同）
    if (streamingRef.current) return;
    if (imageFile) {
      void startImageMessage(imageFile, text, assets);
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

  const openPreview = useCallback(
    (asset: LibraryAsset) => setPreview({ asset, inspection: null }),
    [],
  );
  const closePreview = useCallback(() => setPreview(null), []);
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
    streaming,
  };
}
