import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { toErrorMessage } from "../common/errors";
import { withServerCredentials } from "../config";
import { ChatStreamRequestSchema, type ChatStreamEvent } from "../dto/chat";
import { streamChat, type ChatDelta } from "../services/chatService";
import { currentCloudContext } from "../cloud/context";

export const chatRoutes = new Hono();
export const CHAT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 这一条增量之后必须中止本轮 agent run。目前只有一种情况：ask-user 已经把问题
 * 交给用户，本轮不允许再执行任何工具——模型完全可能把「问用户」和付费生成放在
 * 同一条回复里，光靠提示词纪律挡不住。
 *
 * 抽成具名判断是为了让这条安全不变量有唯一的出处：路由照着它中止，测试照着它
 * 断言，将来新增"需要等用户"的增量也只需要改这里。
 */
export function endsAgentTurn(delta: ChatDelta): boolean {
  return delta.type === "tool-result" && Boolean(delta.question);
}

type HeartbeatStream = {
  aborted: boolean;
  closed: boolean;
  write(input: string): Promise<unknown>;
};

/**
 * 慢视觉推理在第一枚模型 token 前也可能停顿数分钟。标准 SSE 注释不会进入业务事件，
 * 但会让 Bun、浏览器和中间代理都知道这条连接仍然存活。
 */
export function startChatHeartbeat(
  stream: HeartbeatStream,
  intervalMs = CHAT_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) return;
    void stream.write(": keep-alive\n\n");
  }, intervalMs);
  return () => clearInterval(timer);
}

chatRoutes.post("/stream", async (c) => {
  const request = ChatStreamRequestSchema.parse(withServerCredentials(await c.req.json()));

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    const stopHeartbeat = startChatHeartbeat(stream);
    stream.onAbort(() => {
      stopHeartbeat();
      controller.abort();
    });
    const emit = (event: ChatStreamEvent) =>
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) });

    try {
      for await (const delta of streamChat(request, controller.signal)) {
        // 流式响应创建后工具仍会注册任务；必须在通知用户之前确认队列事实已持久化。
        await Promise.all(currentCloudContext()?.pending ?? []);
        if (delta.type === "text") await emit({ type: "delta", text: delta.text });
        else if (delta.type === "reasoning")
          await emit({ type: "reasoning", text: delta.text });
        else if (delta.type === "tool")
          await emit({
            type: "tool",
            name: delta.name,
            toolCallId: delta.toolCallId,
            args: delta.args,
          });
        else
          await emit({
            type: delta.type,
            name: delta.name,
            toolCallId: delta.toolCallId,
            ...(delta.type === "tool-error" && delta.message
              ? { message: delta.message }
              : {}),
            ...(delta.type === "tool-result" && delta.images
              ? { images: delta.images }
              : {}),
            ...(delta.type === "tool-result" && delta.taskIds
              ? { taskIds: delta.taskIds }
              : {}),
            ...(delta.type === "tool-result" && delta.plan
              ? { plan: delta.plan }
              : {}),
            ...(delta.type === "tool-result" && delta.question
              ? { question: delta.question }
              : {}),
          });
        /*
          ask-user 已把问题交给用户：中止这一轮 agent run，保证提问之后不可能再有
          工具（尤其是付费生成）被执行。中止放在问题写进 SSE 之后，才是一次干净的
          提问结束而不是半途断流；catch 里的 aborted 判断会顺带吞掉中止引发的异常。
        */
        if (endsAgentTurn(delta)) controller.abort();
      }
      await emit({ type: "done" });
    } catch (err) {
      if (!controller.signal.aborted) {
        await emit({ type: "error", message: toErrorMessage(err) });
      }
    } finally {
      stopHeartbeat();
    }
  });
});
