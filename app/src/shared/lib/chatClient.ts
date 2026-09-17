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
  ) => void;
  onToolError?: (name: string, toolCallId?: string, message?: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/** 浏览器只发送生成偏好；供应商凭证由本机服务注入。 */
export interface ProviderKeys {
  /** 不是凭证，是 AgentDock 第二个下拉的 3D 生成供应商偏好（留空 = 交给 agent 判断），
      字段名与 dto/chat.ts 的 threeDProvider 对齐 */
  threeDProvider?: string;
  /** 不是凭证，是 AgentDock 图片生成模型偏好；省略 = 交给 agent 自动选择 */
  imageGenerateModel?: string;
  /** 当前会话的计划快照；服务端把它注入下一轮上下文。 */
  plan?: ProjectPlan;
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
  providerKeys?: ProviderKeys,
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
        ...providerKeys,
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
