import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentActivity, ChatMessage } from "../../widgets/AgentDock";

export const INITIAL_MESSAGES: ChatMessage[] = [];

export const nextId = () => `msg-${crypto.randomUUID()}`;

/** 对话消息与 agent 执行状态的共享状态 + 读写辅助 */
export function useChatMessages() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [activity, setActivity] = useState<AgentActivity>({
    state: "idle",
    message: "等待你的指令",
  });
  /**
   * 最新消息列表的同步读取通道：`send` / 自检回传都要在推入新消息**之前**拿到当前
   * 完整历史，而它们跑在事件回调与 SSE 回调里，读不到那一刻的 state 闭包。
   *
   * 同步动作放在 layout effect 而不是渲染期（`messagesRef.current = messages` 那种写法）：
   * 渲染期赋值对被并发丢弃的那次渲染同样生效，ref 会记下一份从未提交的历史。
   * 用 layout effect 则是"提交了才算数"，且它在 commit 阶段同步跑完——比 useEffect
   * 早，不会被上面那些回调抢在前面读到旧值。
   */
  const messagesRef = useRef<ChatMessage[]>(INITIAL_MESSAGES);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const pushMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const pushAssistant = useCallback(
    (content: string, images?: string[]) => {
      const id = nextId();
      pushMessage({
        id,
        role: "assistant",
        content,
        ...(images && images.length > 0 ? { images } : {}),
        agentStatus: content.startsWith("⚠️")
          ? { label: "执行失败", status: "failed" }
          : { label: "已完成", status: "completed" },
      });
      // 后台 3D 任务会在缩略图稍后渲染完成时回填同一条消息。
      return id;
    },
    [pushMessage],
  );

  const updateMessage = useCallback(
    (id: string, updater: (message: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message))),
    [],
  );

  const appendTo = useCallback(
    (id: string, updater: (content: string) => string) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: updater(m.content) } : m)),
      ),
    [],
  );

  /**
   * 报错的唯一出口：同时写瞬时状态行与对话记录。
   *
   * 两条反馈通道的契约是——**瞬时进度**（正在上传 / 正在思考 / 正在执行某工具）
   * 只走 `activity`，可以被下一个状态顶掉；**错误**必须同时落进对话，因为状态行
   * 天然是易失的，只写那里就是静默失败：用户过几秒回头看，屏幕上什么都没有，
   * 也无从知道刚才为什么没成。
   */
  const reportError = useCallback(
    (message: string) => {
      setActivity({ state: "attention", message });
      pushAssistant(`⚠️ ${message}`);
    },
    [pushAssistant],
  );

  return {
    messages,
    setMessages,
    messagesRef,
    activity,
    setActivity,
    pushMessage,
    pushAssistant,
    updateMessage,
    appendTo,
    reportError,
  };
}
