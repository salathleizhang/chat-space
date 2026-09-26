import { CheckIcon } from "@phosphor-icons/react/Check";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { GlobeHemisphereWestIcon } from "@phosphor-icons/react/GlobeHemisphereWest";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { XIcon } from "@phosphor-icons/react/X";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  libraryUrl,
  type LibraryAsset,
  type ProjectPlan,
} from "../../shared/lib/libraryApi";
import { fetchEnvLlmProviders } from "../../shared/lib/capabilitiesClient";
import type { AskUserAnswer, AskUserQuestion } from "../../shared/lib/chatClient";
import { ACCEPTED_IMAGE_TYPES, imageFilesFromClipboard } from "../../shared/lib/imageAttachment";
import type { SessionSummary } from "../../shared/lib/sessionsClient";
import {
  Badge,
  Button,
  Input,
  Panel,
  Select,
  ThinkingIndicator,
  Tooltip,
} from "../../shared/ui";
import {
  IMAGE_GENERATE_MODEL_PRESETS,
  LLM_MODEL_PRESETS,
  type LlmModelPreset,
  type LlmProviderId,
  loadImageGenerateModelSettings,
  loadLlmSettings,
  saveLlmSettings,
  saveImageGenerateModelSettings,
  THREE_D_MODEL_PRESETS,
  loadThreeDModelSettings,
  saveThreeDModelSettings,
} from "../../shared/storage/apiKeys";
import { PlanCard } from "./PlanCard";
import { followScrollToBottom } from "./followScroll";
import { AgentAutoTurnCard } from "./AgentAutoTurnCard";
import { AgentMarkdown } from "./AgentMarkdown";
import { AskUserCard } from "./AskUserCard";
import { GeneratedMessageImages } from "./GeneratedMessageImages";
import { LiquidMetalSendButton } from "./LiquidMetalSendButton";
import { UploadedMessageImages } from "./UploadedMessageImages";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 已提交且尚未完成自动跟进的后台任务；随会话保存以支持恢复。 */
  pendingTaskIds?: string[];
  /** 等待工作台截图的资产；恢复后继续自检。 */
  pendingInspectionAssetSlug?: string;
  /** 消息携带的库内图片（用户附件或工具生成图），逻辑路径 */
  images?: string[];
  /**
   * 这一轮是 Agent 自己续跑（自检、身份确认、后台任务完成）时本轮拿到的产物。
   * 它不是用户输入：渲染成 Agent 侧卡片，而不是用户气泡。
   */
  autoTurn?: AgentAutoTurn;
  /** 用户发送这条消息时选中的资产快照；切换当前选择后历史指向不漂移 */
  assets?: ChatAssetAttachment[];
  /** 这一轮 assistant 回复内发生的工具轨迹，按调用顺序排列。 */
  activities?: AgentMessageActivity[];
  /** 这一轮对话顶部唯一的 Agent 状态；步骤节点本身只使用圆点。 */
  agentStatus?: AgentMessageStatus;
  /**
   * ask-user 提问卡片：待回答时渲染成可点选卡片，回答后由 questionAnswer
   * 记录用户选了什么、卡片转为只读。刷新或切换会话后仍可点选——卡片不依赖
   * 任何服务端状态。
   */
  pendingQuestion?: AskUserQuestion;
  questionAnswer?: AskUserAnswer;
  /** 待回答的问题被用户跳过（直接打字回了别的）；卡片置灰但保留在历史里 */
  supersededQuestion?: boolean;
}

/** Agent 自发续跑的本轮产物；图片路径来自资产库，落盘后随会话保存。 */
export interface AgentAutoTurn {
  kind: "inspection" | "identify" | "tasks";
  label: string;
  images?: string[];
}

export interface AgentMessageStatus {
  label: string;
  /** waiting = 已把问题交给用户，等卡片被点选或用户直接输入 */
  status: "running" | "waiting" | "completed" | "failed";
}

export interface AgentMessageActivity {
  id: string;
  /** 内部工具 id，仅用于把完成事件匹配回对应记录，不直接展示。 */
  toolName?: string;
  /** 工具开始时，assistant 已输出正文的 UTF-16 偏移；用于还原文字与工具的顺序。 */
  contentOffset?: number;
  label: string;
  status: "running" | "completed" | "failed";
}

export interface ChatAssetAttachment {
  assetSlug: string;
  name: string;
  thumbPath?: string;
  kind?: string;
}

export interface AgentActivity {
  /** waiting = 已把问题交给用户，界面提示"等你决定"而不是"正在工作" */
  state: "idle" | "working" | "waiting" | "attention";
  message: string;
}

interface AgentDockProps {
  messages: ChatMessage[];
  activity: AgentActivity;
  /**
   * 是否正在上传图片或运行对话流。后台生成任务轮询期间 activity 也是 working，
   * 但不应阻止用户继续对话。
   */
  streaming: boolean;
  onSend: (
    text: string,
    imageFiles?: File[],
    assets?: ChatAssetAttachment[],
  ) => void;
  /** 中止当前这轮生成（发送按钮在流式期间就是这个动作） */
  onStop: () => void;
  /** 保存当前对话并在同一项目内另起一条空会话 */
  onNewSession?: () => Promise<boolean>;
  activeSessionId?: string;
  sessions?: SessionSummary[];
  sessionsLoading?: boolean;
  sessionsError?: string | null;
  onOpenSessions?: () => void;
  onSelectSession?: (id: string) => Promise<boolean>;
  /** 工作台当前选中的资产；这里显示为输入框的模型附件 */
  selectedAssets?: LibraryAsset[];
  /** 从附件条移除 = 从工作台共享选择中移除 */
  onRemoveSelectedAsset?: (assetId: string) => void;
  /** 当前会话自己的 Agent 计划快照 */
  plan?: ProjectPlan | null;
  /** 首页携图创建项目时展开对话，直接显示上传与分析进度。 */
  initiallyExpanded?: boolean;
  /** 用户在 ask-user 卡片上作出的选择；答案作为下一条用户消息发给 agent。 */
  onAnswerQuestion?: (ownerMessageId: string, answer: AskUserAnswer) => void;
}

const SESSION_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** 计划卡展开动画 300ms；跟帧到内容高度稳定为止，这个值只是防止死循环的上限。 */
const PLAN_EXPAND_FOLLOW_MAX_MS = 1500;

function SessionMenu({
  messages,
  streaming,
  activeSessionId,
  sessions,
  loading,
  error,
  onOpen,
  onNew,
  onSelect,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  activeSessionId?: string;
  sessions: SessionSummary[];
  loading: boolean;
  error?: string | null;
  onOpen?: () => void;
  onNew?: () => Promise<boolean>;
  onSelect?: (id: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const measure = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
      top: rect.bottom + 6,
    });
  };

  useEffect(() => {
    if (!open) return;
    measure();
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", measure);
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const firstUser = messages.find((message) => message.role === "user");
  const localTitle = firstUser?.content.slice(0, 40) || "New conversation";
  const activeSaved = sessions.find((session) => session.id === activeSessionId);
  const items = sessions.map((session) =>
    session.id === activeSessionId
      ? { ...session, title: localTitle, messageCount: messages.length }
      : session,
  );
  if (activeSessionId && !activeSaved) {
    items.unshift({
      id: activeSessionId,
      title: localTitle,
      updatedAt: "",
      createdAt: "",
      messageCount: messages.length,
    });
  }

  const toggle = () => {
    setOpen((current) => {
      if (!current) {
        measure();
        onOpen?.();
      }
      return !current;
    });
  };

  return (
    <div ref={anchorRef} className="inline-flex">
      <Tooltip content="Conversations" side="left">
        <Button
          variant="secondary"
          shape="circle"
          size="lg"
          aria-label="Conversations"
          aria-haspopup="menu"
          aria-expanded={open}
          data-selected={open ? "true" : undefined}
          className="control-edge-lit border border-line hover:border-ink-faint"
          onClick={toggle}
        >
          <ChatsCircleIcon size={18} weight="regular" />
        </Button>
      </Tooltip>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Conversation list"
            style={{ left: position.left, top: position.top }}
            className="fixed z-50 flex w-72 origin-top-right flex-col gap-1 rounded-surface border border-line bg-surface-raised p-2 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-150 ease-spring starting:opacity-0 starting:scale-95 motion-reduce:starting:scale-100"
          >
            <button
              type="button"
              role="menuitem"
              disabled={
                streaming || switchingId !== null || messages.length === 0 || !onNew
              }
              className="flex h-[54px] w-full items-center gap-2 rounded-inset px-4 text-left text-xs text-ink transition-transform duration-150 ease-spring hover:bg-fill disabled:pointer-events-none disabled:opacity-40 motion-safe:active:scale-[0.97]"
              onClick={() => {
                if (!onNew) return;
                setSwitchingId("__new__");
                void onNew()
                  .then((created) => {
                    setSwitchingId(null);
                    if (created) setOpen(false);
                  })
                  .catch(() => setSwitchingId(null));
              }}
            >
              <PlusIcon size={14} weight="regular" />
              <span className="font-medium">New conversation</span>
            </button>
            <div className="agent-dock-scrollbar flex max-h-60 flex-col gap-1 overflow-y-auto">
              {loading && items.length === 0 ? (
                <p className="px-3 py-4 text-xs text-ink-subtle">Loading conversations…</p>
              ) : (
                items.map((session) => {
                  const current = session.id === activeSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      role="menuitem"
                      aria-current={current ? "true" : undefined}
                      aria-disabled={current || streaming || switchingId !== null || !onSelect}
                      disabled={streaming || switchingId !== null || !onSelect}
                      className={`flex h-[54px] w-full items-center gap-2 rounded-inset px-4 text-left transition-transform duration-150 ease-spring hover:bg-fill disabled:pointer-events-none disabled:opacity-40 motion-safe:active:scale-[0.97] ${
                        current ? "text-ink" : "text-ink-subtle"
                      }`}
                      onClick={() => {
                        if (current || !onSelect) return;
                        setSwitchingId(session.id);
                        void onSelect(session.id)
                          .then((switched) => {
                            setSwitchingId(null);
                            if (switched) setOpen(false);
                          })
                          .catch(() => setSwitchingId(null));
                      }}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-subtle">
                        {current && <CheckIcon size={14} weight="bold" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {session.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-ink-faint">
                          {session.messageCount} messages
                          {session.updatedAt
                            ? ` · ${SESSION_TIME_FORMATTER.format(new Date(session.updatedAt))}`
                            : " · Current"}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {error && <p className="px-3 py-2 text-xs text-signal">{error}</p>}
          </div>,
          document.body,
        )}
    </div>
  );
}

function AssetAttachmentChip({
  asset,
  onRemove,
}: {
  asset: Omit<ChatAssetAttachment, "thumbPath"> & {
    id?: string;
    thumbPath?: string | null;
  };
  onRemove?: () => void;
}) {
  const PlaceholderIcon =
    asset.kind === "skybox" ? GlobeHemisphereWestIcon : CubeIcon;
  return (
    <div
      data-asset-attachment
      className="flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-field px-px"
    >
      {asset.thumbPath ? (
        <img
          src={libraryUrl(asset.thumbPath)}
          alt=""
          className="h-10 w-10 shrink-0 rounded-media object-contain"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-media text-ink-faint">
          <PlaceholderIcon size={18} weight="regular" />
        </div>
      )}
      <span className="max-w-24 truncate text-xs text-ink-strong">{asset.name}</span>
      {onRemove && (
        <Button
          variant="ghost"
          shape="circle"
          size="xs"
          icon={XIcon}
          aria-label={`Remove model ${asset.name}`}
          onClick={onRemove}
        />
      )}
    </div>
  );
}

/**
 * 消息历史 + 计划卡：独立成 memo 组件，避免输入框打字（text/imageFiles/model
 * 局部状态）时把整条消息历史（含图片）跟着重新 map 一遍——历史只在 messages/
 * plan/expanded 真正变化时才需要重渲染。
 */
const MessageHistory = memo(function MessageHistory({
  messages,
  plan,
  expanded,
  activity,
  streaming,
  onAnswerQuestion,
}: {
  messages: ChatMessage[];
  plan?: ProjectPlan | null;
  expanded: boolean;
  activity: AgentActivity;
  streaming: boolean;
  onAnswerQuestion?: (ownerMessageId: string, answer: AskUserAnswer) => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 用户是不是正贴着底部看；自己往上翻过就不算，后续长高不再拽他回去。 */
  const pinnedRef = useRef(true);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };

  useEffect(() => {
    if (!expanded) return;
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [expanded, messages, activity]);

  /**
   * 历史里的内容会长高：计划卡展开、图片解码完成、工具轨迹补行。容器本身是定高的，
   * 不跟就会把末尾那截切在底边外——计划卡正好长在历史末尾，展开后必须能看全。
   * 只跟随「本来就贴底」的情况；用户翻上去读旧消息时不动他的滚动位置。
   */
  useEffect(() => {
    const node = scrollRef.current;
    const content = contentRef.current;
    if (!node || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /**
   * 点开计划是明确的「我要看」：卡片长在历史末尾，展开后新露出来的步骤会落到容器外，
   * 必须跟到底。这里不依赖「本来就贴底」的判断，也不依赖 ResizeObserver 的投递时机——
   * 浏览器为保持画面稳定会做滚动锚定，它调整 scrollTop 产生的滚动事件会把贴底判定
   * 翻成 false，后续长高就都不跟了。跟帧细节见 followScrollToBottom。
   */
  const handlePlanToggle = useCallback((open: boolean) => {
    if (!open) return;
    pinnedRef.current = true;
    const node = scrollRef.current;
    if (!node) return;
    followScrollToBottom(
      node,
      (callback) => requestAnimationFrame(callback),
      () => performance.now(),
      PLAN_EXPAND_FOLLOW_MAX_MS,
    );
  }, []);

  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }

  const renderTurnStatus = (status: AgentMessageStatus, key?: string) => (
    <div
      key={key}
      data-agent-turn-status={status.status}
      className="flex min-w-0 items-center gap-2.5 py-0.5"
    >
      <ThinkingIndicator
        size={28}
        animated={status.status === "running"}
        className={status.status === "completed" ? "opacity-50" : ""}
      />
      <span
        className={`truncate text-xs font-medium ${
          status.status === "failed"
            ? "text-signal"
            : status.status === "waiting"
              ? "text-accent"
              : "text-ink-subtle"
        }`}
      >
        {status.label}
      </span>
    </div>
  );

  const renderAssistantMessage = (message: ChatMessage, messageIndex: number) => {
    const toolActivities = (message.activities ?? []).filter(
      (item): item is AgentMessageActivity & { toolName: string } =>
        Boolean(item.toolName),
    );
    const isCurrentStream = messageIndex === lastAssistantIndex && streaming;
    const fallbackStatus: AgentMessageStatus | undefined = toolActivities.length
      ? toolActivities.some((item) => item.status === "running")
        ? {
            label: toolActivities.find((item) => item.status === "running")!.label,
            status: "running",
          }
        : toolActivities.some((item) => item.status === "failed")
          ? { label: "Execution failed", status: "failed" }
          : { label: "Completed", status: "completed" }
      : undefined;
    const turnStatus: AgentMessageStatus | undefined =
      messageIndex === lastAssistantIndex &&
      (activity.state === "working" || activity.state === "waiting")
        ? {
            label: activity.message,
            status: activity.state === "waiting" ? "waiting" : "running",
          }
        : message.agentStatus ?? fallbackStatus;
    const timelineRows: Array<
      | { key: string; kind: "tool"; activity: AgentMessageActivity }
      | { key: string; kind: "text-node"; text: string; running: boolean }
      | { key: string; kind: "text"; text: string }
    > = [];

    if (toolActivities.length > 0) {
      let previousOffset = 0;
      const positionedTools = toolActivities.map((item) => {
        const rawOffset = item.contentOffset ?? previousOffset;
        const contentOffset = Math.max(
          previousOffset,
          Math.min(message.content.length, rawOffset),
        );
        previousOffset = contentOffset;
        return { ...item, contentOffset };
      });
      const intro = message.content
        .slice(0, positionedTools[0]!.contentOffset)
        .trim();
      if (intro) {
        timelineRows.push({
          key: "intro",
          kind: "text-node",
          text: intro,
          running: false,
        });
      }

      positionedTools.forEach((item, index) => {
        timelineRows.push({ key: item.id, kind: "tool", activity: item });
        const nextOffset =
          positionedTools[index + 1]?.contentOffset ?? message.content.length;
        const text = message.content.slice(item.contentOffset, nextOffset).trim();
        if (!text) return;
        if (index < positionedTools.length - 1) {
          timelineRows.push({ key: `between-${item.id}`, kind: "text", text });
        } else {
          timelineRows.push({
            key: "final",
            kind: "text-node",
            text,
            running: isCurrentStream,
          });
        }
      });
    } else if (isCurrentStream) {
      const text = message.content.trim();
      if (text) {
        timelineRows.push({
          key: "streaming-text",
          kind: "text-node",
          text,
          running: true,
        });
      }
    }

    const hasRail = timelineRows.length > 1;
    return (
      <div
        key={`${message.id}-${messageIndex}`}
        data-agent-message
        className="max-w-full text-sm leading-relaxed text-ink"
      >
        {turnStatus && (
          <div className="mb-2">{renderTurnStatus(turnStatus)}</div>
        )}
        {message.autoTurn && (
          <AgentAutoTurnCard attachment={message.autoTurn} />
        )}
        {timelineRows.length > 0 && (
          <div
            data-agent-tool-timeline
            {...(hasRail ? { "data-agent-activity-rail": "" } : {})}
            className="mb-2 flex flex-col"
          >
            {timelineRows.map((row, index) => {
              const isNode = row.kind !== "text";
              return (
                <div
                  key={row.key}
                  {...(isNode ? { "data-agent-timeline-node": "" } : {})}
                  {...(row.kind === "text-node"
                    ? {
                        "data-agent-text-node": row.running
                          ? "running"
                          : "completed",
                      }
                    : {})}
                  {...(row.kind === "text" ? { "data-agent-inline-text": "" } : {})}
                  {...(row.kind === "tool"
                    ? { "data-agent-message-activity": row.activity.status }
                    : {})}
                  className="grid min-h-6 grid-cols-[20px_minmax(0,1fr)] gap-x-2.5"
                >
                  <div aria-hidden="true" className="relative min-h-6">
                    {hasRail && index > 0 && (
                      <span className="absolute left-2.5 top-0 h-3 w-px bg-hairline" />
                    )}
                    {hasRail && index < timelineRows.length - 1 && (
                      <span className="absolute bottom-0 left-2.5 top-3 w-px bg-hairline" />
                    )}
                    {isNode && (
                      <span
                        data-agent-step-dot={
                          row.kind === "tool"
                            ? row.activity.status
                            : row.running
                              ? "running"
                              : "completed"
                        }
                        className={`absolute left-1.5 top-2 h-2 w-2 rounded-full ${
                          row.kind === "tool"
                            ? row.activity.status === "running"
                              ? "bg-accent"
                              : row.activity.status === "failed"
                                ? "bg-signal"
                                : "bg-ink-faint"
                            : row.running
                              ? "bg-signal"
                              : "bg-ink-faint"
                        }`}
                      />
                    )}
                  </div>
                  <div
                    className={`min-w-0 py-0.5 ${
                      row.kind === "tool"
                        ? `truncate text-xs font-medium ${
                            row.activity.status === "failed"
                              ? "text-signal"
                              : "text-ink-subtle"
                          }`
                        : ""
                    }`}
                  >
                    {row.kind === "tool" ? (
                      row.activity.label
                    ) : (
                      <AgentMarkdown>{row.text}</AgentMarkdown>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {toolActivities.length === 0 && !isCurrentStream && message.content ? (
          <AgentMarkdown>{message.content}</AgentMarkdown>
        ) : null}
        {message.images && message.images.length > 0 && (
          <GeneratedMessageImages paths={message.images} />
        )}
        {message.pendingQuestion && (
          <AskUserCard
            question={message.pendingQuestion}
            answer={message.questionAnswer}
            /*
              用户没点卡片、直接用文字回了别的：卡片置灰但保留在历史里，
              让「Agent 问过什么、我没选」这件事仍然可追溯。
            */
            superseded={!message.questionAnswer && message.supersededQuestion}
            onAnswer={(answer) => onAnswerQuestion?.(message.id, answer)}
          />
        )}
      </div>
    );
  };

  return (
    <div
      id="agent-dock-history"
      ref={scrollRef}
      onScroll={handleScroll}
      className="agent-dock-scrollbar h-[min(48vh,28rem)] overflow-y-auto"
    >
      <div ref={contentRef} className="flex flex-col gap-3 p-4">
        {messages.map((message, messageIndex) =>
          message.role === "user" ? (
            <div
              key={`${message.id}-${messageIndex}`}
              className="max-w-[85%] self-end rounded-control bg-fill px-3 py-2 text-sm text-ink"
            >
              {message.content}
              {message.assets && message.assets.length > 0 && (
                <div className="mt-2 max-w-full overflow-x-auto">
                  <div className="flex w-max gap-1.5">
                    {message.assets.map((asset) => (
                      <AssetAttachmentChip
                        key={asset.assetSlug}
                        asset={asset}
                      />
                    ))}
                  </div>
                </div>
              )}
              {message.images && message.images.length > 0 && (
                <UploadedMessageImages paths={message.images} />
              )}
            </div>
          ) : renderAssistantMessage(message, messageIndex),
        )}
        {lastAssistantIndex === -1 &&
          (activity.state === "working" || activity.state === "waiting") &&
          renderTurnStatus(
            {
              label: activity.message,
              status: activity.state === "waiting" ? "waiting" : "running",
            },
            "live-agent",
          )}
        {plan && <PlanCard plan={plan} onToggle={handlePlanToggle} />}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
});

export function AgentDock({
  messages,
  activity,
  streaming,
  onSend,
  onStop,
  onNewSession,
  activeSessionId,
  sessions = [],
  sessionsLoading = false,
  sessionsError,
  onOpenSessions,
  onSelectSession,
  selectedAssets = [],
  onRemoveSelectedAsset,
  plan,
  initiallyExpanded = false,
  onAnswerQuestion,
}: AgentDockProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [text, setText] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [model, setModel] = useState(() => loadLlmSettings().model);
  const [llmProvider, setLlmProvider] = useState<LlmProviderId | "">(
    () => loadLlmSettings().provider,
  );
  const [envLlmProviders, setEnvLlmProviders] = useState<LlmProviderId[] | null>(
    null,
  );
  const [threeDModel, setThreeDModel] = useState(
    () => loadThreeDModelSettings().model,
  );
  const [imageGenerateModel, setImageGenerateModel] = useState(
    () => loadImageGenerateModelSettings().model,
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    const urls = imageFiles.map((file) => URL.createObjectURL(file));
    setImagePreviewUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [imageFiles]);

  useEffect(() => {
    let cancelled = false;
    void fetchEnvLlmProviders().then((providers) => {
      if (!cancelled) setEnvLlmProviders(providers);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeLlmProviders = useMemo(
    () => new Set(envLlmProviders ?? []),
    [envLlmProviders],
  );
  /**
   * 能力接口不可达时保留全部选项，避免把可能来自 env 的有效选择破坏掉；
   * 接口成功后只展示真正已激活的厂商模型。
   */
  const modelOptions: LlmModelPreset[] = useMemo(
    () =>
      envLlmProviders === null
        ? LLM_MODEL_PRESETS
        : LLM_MODEL_PRESETS.filter(
            (preset) => !preset.provider || activeLlmProviders.has(preset.provider),
          ),
    [activeLlmProviders, envLlmProviders],
  );
  const visibleModel = modelOptions.some((preset) => preset.value === model)
    ? model
    : "";
  const selectedProviderIsActive =
    !llmProvider || activeLlmProviders.has(llmProvider);

  useEffect(() => {
    if (
      envLlmProviders === null ||
      selectedProviderIsActive
    ) {
      return;
    }
    setModel("");
    setLlmProvider("");
    saveLlmSettings({ provider: "", baseUrl: "", model: "" });
  }, [envLlmProviders, llmProvider, selectedProviderIsActive]);

  /** 预设声明了端点就连 baseUrl 一起落盘：模型 id 与端点是一对，只换一半会把
      豆包的 id 发到 OpenAI 端点（反之亦然），必然报模型不存在 */
  const handleModelChange = (value: string) => {
    setModel(value);
    const preset = modelOptions.find((option) => option.value === value);
    const provider = preset?.provider ?? "";
    setLlmProvider(provider);
    saveLlmSettings({
      provider,
      model: value,
      baseUrl: preset?.baseUrl ?? "",
    });
  };

  const handleThreeDModelChange = (value: string) => {
    setThreeDModel(value);
    saveThreeDModelSettings({ model: value });
  };

  const handleImageGenerateModelChange = (value: string) => {
    setImageGenerateModel(value);
    saveImageGenerateModelSettings({ model: value });
  };

  const submit = () => {
    const trimmed = text.trim();
    // UI 这道只是可供性，真正的"同时至多一条流"不变量在 useAgentChat.startStream
    if (streaming || (!trimmed && imageFiles.length === 0)) return;
    const assets =
      selectedAssets.length > 0
        ? selectedAssets.map(({ assetSlug, name, thumbPath, kind }) => ({
            assetSlug,
            name,
            ...(thumbPath ? { thumbPath } : {}),
            kind,
          }))
        : undefined;
    onSend(trimmed, imageFiles.length > 0 ? imageFiles : undefined, assets);
    setText("");
    setImageFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const startNewSession = async () => {
    if (streaming || messages.length === 0 || !onNewSession) return false;
    const created = await onNewSession();
    if (!created) return false;
    setExpanded(true);
    setText("");
    setImageFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    return true;
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
  };

  const handleDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(event.dataTransfer.files).filter((candidate) =>
      ACCEPTED_IMAGE_TYPES.includes(candidate.type),
    );
    if (files.length > 0) setImageFiles((current) => [...current, ...files]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    setImageFiles((current) => [...current, ...files]);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center">
      <div className="relative w-[min(48rem,calc(100%-2rem))]">
        <Panel
          data-agent-dock-panel
          variant="liquid"
          className="animate-chrome-enter-center pointer-events-auto relative w-full overflow-hidden"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
        {expanded && (
          <div
            data-agent-session-control
            className="animate-chrome-enter pointer-events-auto absolute top-3 right-4 z-20"
          >
            <SessionMenu
              messages={messages}
              streaming={streaming}
              activeSessionId={activeSessionId}
              sessions={sessions}
              loading={sessionsLoading}
              error={sessionsError}
              onOpen={onOpenSessions}
              onNew={startNewSession}
              onSelect={onSelectSession}
            />
          </div>
        )}
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-fill-active text-sm text-ink">
            Drop to upload image
          </div>
        )}
        <div className="relative flex items-center">
          <button
            type="button"
            className="group flex w-full items-center justify-center py-2.5"
            aria-label={expanded ? "Collapse agent" : "Expand agent"}
            aria-expanded={expanded}
            aria-controls="agent-dock-history"
            onClick={() => setExpanded((value) => !value)}
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-9 rounded-full bg-ink-faint transition-[width,transform,background-color] duration-150 ease-spring group-hover:w-12 group-hover:bg-ink-subtle motion-safe:group-active:scale-90"
            />
          </button>
        </div>

        {!expanded &&
          (activity.state === "working" || activity.state === "waiting") && (
          <div
            data-agent-status={activity.state === "waiting" ? "waiting" : "working"}
            role="status"
            aria-live="polite"
            className="mx-5 flex h-10 min-w-0 items-center gap-3"
          >
            <ThinkingIndicator size={28} animated={activity.state === "working"} />
            <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.16em] text-ink-faint">
              Agent
            </span>
            <span
              className={`min-w-0 truncate text-xs font-medium ${
                activity.state === "waiting" ? "text-accent" : "text-ink-subtle"
              }`}
            >
              {activity.message}
            </span>
            {plan && plan.steps.some((s) => s.status === "in_progress") && (
              <div className="ml-auto shrink-0">
                <Badge>
                  Plan {plan.steps.filter((s) => s.status === "completed").length}/
                  {plan.steps.length}
                </Badge>
              </div>
            )}
          </div>
        )}

        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-spring motion-reduce:duration-100 ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <MessageHistory
              messages={messages}
              plan={plan}
              expanded={expanded}
              activity={activity}
              streaming={streaming}
              onAnswerQuestion={onAnswerQuestion}
            />
          </div>
        </div>

        {expanded && sessionsError && (
          <p role="alert" className="mx-5 mb-2 text-xs text-signal">
            ⚠️ {sessionsError}
          </p>
        )}

        <form
          className={`flex flex-col gap-2 transition-[margin,padding,border-color,background-color] duration-300 ease-spring ${
            expanded
              ? "m-2 rounded-inset border border-line bg-fill p-4"
              : "border border-transparent p-5"
          }`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {selectedAssets.length > 0 && (
            <div
              className="max-w-full overflow-x-auto"
              aria-label="Selected model attachments"
            >
              <div className="flex w-max gap-1.5">
                {selectedAssets.map((asset) => (
                  <AssetAttachmentChip
                    key={asset.id}
                    asset={asset}
                    onRemove={
                      onRemoveSelectedAsset
                        ? () => onRemoveSelectedAsset(asset.id)
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          )}
          {imageFiles.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-1 py-2">
                {imageFiles.map((file, index) => (
                  <div key={index} className="relative h-16 w-16 shrink-0">
                    {imagePreviewUrls[index] && (
                      <img
                        src={imagePreviewUrls[index]}
                        alt={file.name}
                        className="h-16 w-16 rounded-media bg-field object-contain ring-2 ring-ink-strong"
                      />
                    )}
                    <Button
                      variant="primary"
                      shape="circle"
                      size="xs"
                      icon={XIcon}
                      aria-label={`Remove image ${file.name}`}
                      className="absolute top-0 right-0"
                      onClick={() => setImageFiles((current) => current.filter((_, i) => i !== index))}
                    />
                  </div>
                ))}
              </div>
              <span className="hidden truncate text-[11px] text-ink-subtle sm:block">
                {imageFiles.length} {imageFiles.length === 1 ? "image" : "images"} attached
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []).filter((file) => ACCEPTED_IMAGE_TYPES.includes(file.type));
              if (files.length > 0) setImageFiles((current) => [...current, ...files]);
              event.target.value = "";
            }}
          />
          <Input
            variant="plain"
            size="lg"
            className="w-full"
            aria-label="Generation instructions"
            placeholder={
              imageFiles.length > 0
                ? "Additional details (optional)"
                : selectedAssets.length > 0
                  ? "Describe what to do with the selected models"
                  : "Describe a model to generate or edit"
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={handlePaste}
          />
          <div
            className={`flex items-center justify-between gap-2 ${expanded ? "-mx-2 -mb-2" : ""}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Tooltip content="Upload an image to start creating">
                <Button
                  variant="secondary"
                  shape="circle"
                  size="lg"
                  icon={PlusIcon}
                  aria-label="Upload image"
                  className="control-edge-lit border border-line hover:border-ink-faint"
                  onClick={() => fileInputRef.current?.click()}
                />
              </Tooltip>
              <Select
                value={visibleModel}
                options={modelOptions}
                onChange={handleModelChange}
                aria-label="Choose chat model"
              />
              <Select
                value={threeDModel}
                options={THREE_D_MODEL_PRESETS}
                onChange={handleThreeDModelChange}
                aria-label="Choose 3D generation model"
              />
              <Select
                value={imageGenerateModel}
                options={IMAGE_GENERATE_MODEL_PRESETS}
                onChange={handleImageGenerateModelChange}
                aria-label="Choose image generation model"
              />
            </div>
            {/*
              流式期间变成"停止"而不是变灰：一轮生成可能跑几十秒并调用付费工具，
              用户看出方向不对时必须能收回。把按钮禁用掉是把人锁在一个他已经知道
              错了的过程里，比允许并发更糟。
            */}
            {streaming ? (
              <Tooltip content="Stop this generation">
                <LiquidMetalSendButton
                  intent="stop"
                  type="button"
                  aria-label="Stop generation"
                  onClick={onStop}
                />
              </Tooltip>
            ) : (
              <LiquidMetalSendButton
                aria-label={imageFiles.length > 0 ? "Send images" : "Send instructions"}
              />
            )}
          </div>
        </form>
        </Panel>
      </div>
    </div>
  );
}
