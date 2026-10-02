import { CHAT_BASE_URL, toFriendlyErrorMessage } from "./sse";
import type { LlmProviderId } from "../storage/apiKeys";
import type { ProjectPlan } from "./libraryApi";

/**
 * 消息部件：图片以资产库逻辑路径引用、chat 侧内联为 data URI；
 * 资产附件只传稳定 slug，由 chat 侧从当前项目状态解析。
 */
export type OutgoingContentPart =
  | { type: "text"; text: string }
  | { type: "image"; path: string }
  | { type: "asset"; assetSlug: string };

/**
 * ask-user 提问卡片：Agent 需要用户本人做决定（付费同意、方案取舍、对象确认）
 * 时给出的可点选问题。选项内容完全由模型决定，前端只负责渲染与回传。
 */
export interface AskUserOption {
  /** 稳定 id，回传时用它标识选中项 */
  id: string;
  /** 按钮文字，例如「同意」「停止」 */
  label: string;
  /** 第二行说明，例如将调用哪个平台、大概做什么 */
  description?: string;
  tone?: "default" | "primary" | "danger";
  recommended?: boolean;
}

export interface AskUserQuestion {
  questionId: string;
  /** 卡片角标，例如「付费确认」 */
  header?: string;
  question: string;
  /** 需要展开说明的清单，例如这一轮会跑哪些付费步骤 */
  details?: string[];
  options: AskUserOption[];
  multiSelect: boolean;
  /** 是否给一个自由输入逃生口 */
  allowOther: boolean;
}

/**
 * 用户在卡片上作出的选择。它作为请求顶层字段回传，不是一条用户消息：
 * 用户点的是卡片，历史里不该因此多出一条用户气泡。
 */
export interface AskUserAnswer {
  questionId: string;
  /** 原问题文本；服务端不保存提问状态，必须随答案一起回传 */
  question: string;
  optionIds: string[];
  /** 与 optionIds 一一对应的可读文字 */
  labels: string[];
  /** allowOther 的自由输入 */
  text?: string;
}

export interface OutgoingChatMessage {
  role: "user" | "assistant" | "system";
  content: string | OutgoingContentPart[];
}

export interface LlmRequestConfig {
  provider?: LlmProviderId;
  baseUrl?: string;
  model?: string;
}

interface StreamHandlers {
  onDelta: (text: string) => void;
  /** agent 工具调用透明度：调用了哪个工具（付费操作对用户可见）；
   *  inspect-asset 等客户端协作工具靠 args 驱动 app 侧动作 */
  onTool?: (
    name: string,
    toolCallId?: string,
    args?: Record<string, unknown>,
  ) => void;
  /** 服务端工具执行完成/失败，用于停止消息内对应的活动动画。 */
  onToolResult?: (
    name: string,
    toolCallId?: string,
    images?: string[],
    taskIds?: string[],
    plan?: ProjectPlan,
    question?: AskUserQuestion,
  ) => void;
  onToolError?: (name: string, toolCallId?: string, message?: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * Agent 自发续跑：客户端协作工具（四视角自检、参考图身份确认、后台任务完成、
 * 图片产物落盘）拿到的产物，或"计划还有没做完的步骤"这一条无产物指令。它由服务端
 * 注入本轮上下文，**不进入 messages**——因此不会在会话记录里冒充一条用户消息，也不会
 * 在后续每一轮被重复内联回传。
 */
export interface ChatResume {
  kind: "inspection" | "identify" | "tasks" | "plan" | "reference";
  /** 面向模型的续跑指令；不是用户说的话 */
  text: string;
  /** 库内逻辑路径；服务端内联为图片部件 */
  images?: string[];
}

/** 本轮请求的附加字段：生成偏好、会话计划快照、Agent 自发续跑的产物。 */
export interface ChatTurnOptions {
  /** 不是凭证，是 AgentDock 第二个下拉选中的具体 3D 模型（留空 = 交给 agent 判断），
      字段名与 dto/chat.ts 的 threeDModel 对齐 */
  threeDModel?: string;
  /** 不是凭证，是 AgentDock 图片生成模型偏好；省略 = 交给 agent 自动选择 */
  imageGenerateModel?: string;
  /** 当前会话的计划快照；服务端把它注入下一轮上下文。 */
  plan?: ProjectPlan;
  /** Agent 自发续跑的本轮上下文；与 messages 并列，不进历史。 */
  resume?: ChatResume;
  /** ask-user 卡片的点选结果；同样不进 messages，界面只在卡片里显示。 */
  answer?: AskUserAnswer;
  /**
   * 当前会话开始的时刻（epoch ms）。服务端不知道会话边界，而"上一轮生成的参考图
   * 不许静默复用"必须按会话判断（见 chat 侧 referenceResolution.ts）。新建会话是按下
   * 按钮那一刻，恢复出来的会话是它的 `createdAt`。
   */
  sessionStartedAt?: number;
}

/**
 * 调用 chat 服务的 SSE 流式对话接口，把增量回调给上层。
 *
 * `signal` 不是可选的锦上添花：没有它，一轮对话一旦发出就无法收回——用户想叫停
 * 只能干等，离开工作台或切项目后读取循环还会继续跑到自然结束，并持续往已卸载的
 * 组件里回调 onDelta/onError（与 useTaskPolling 那个泄漏同一类根因：异步生命周期
 * 没有挂在组件上）。中止后本函数**静默返回**，既不回调 onError 也不回调 onDone——
 * 主动中止不是错误，不该在对话里留下一条报错。
 */
export async function streamChat(
  projectSlug: string,
  messages: OutgoingChatMessage[],
  llm: LlmRequestConfig,
  handlers: StreamHandlers,
  options?: ChatTurnOptions,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch(`${CHAT_BASE_URL}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectSlug,
        messages,
        llm,
        ...options,
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      handlers.onError(body?.error?.message ?? `Chat service returned ${response.status}`);
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const dataLine = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const event = JSON.parse(dataLine.slice(5)) as
          | { type: "delta"; text: string }
          | {
              type: "tool";
              name: string;
              toolCallId?: string;
              args?: Record<string, unknown>;
            }
          | {
              type: "tool-result";
              name: string;
              toolCallId?: string;
              images?: string[];
              taskIds?: string[];
              plan?: ProjectPlan;
              question?: AskUserQuestion;
            }
          | {
              type: "tool-error";
              name: string;
              toolCallId?: string;
              message?: string;
            }
          | { type: "done" }
          | { type: "error"; message: string };

        if (event.type === "delta") handlers.onDelta(event.text);
        else if (event.type === "tool")
          handlers.onTool?.(event.name, event.toolCallId, event.args);
        else if (event.type === "tool-result")
          handlers.onToolResult?.(
            event.name,
            event.toolCallId,
            event.images,
            event.taskIds,
            event.plan,
            event.question,
          );
        else if (event.type === "tool-error")
          handlers.onToolError?.(event.name, event.toolCallId, event.message);
        else if (event.type === "error") {
          handlers.onError(event.message);
          return;
        } else if (event.type === "done") {
          handlers.onDone();
          return;
        }
      }
    }

    if (!signal?.aborted) {
      handlers.onError("The connection to the local Chat service was interrupted. Please try again.");
    }
  } catch (err) {
    // 中止是调用方主动做的，不是故障：fetch 与 reader.read() 都会抛 AbortError，
    // 这里必须吞掉，否则用户点"停止"会在对话里收到一条莫名其妙的报错
    if (signal?.aborted || (err as { name?: string })?.name === "AbortError") return;
    handlers.onError(toFriendlyErrorMessage(err));
  }
}
