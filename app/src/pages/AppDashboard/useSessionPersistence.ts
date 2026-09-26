import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchLatestSession,
  fetchSession,
  fetchSessions,
  saveSession,
  type SessionSummary,
  type StoredSession,
} from "../../shared/lib/sessionsClient";
import type { ProjectPlan } from "../../shared/lib/libraryApi";
import type { ChatMessage } from "../../widgets/AgentDock";

function sessionErrorMessage(prefix: string, err: unknown) {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

function restoredMessages(session: StoredSession): ChatMessage[] {
  return session.messages.map((message) => ({
    ...message,
    agentStatus:
      message.pendingTaskIds?.length || message.pendingInspectionAssetSlug
        ? { label: "Resuming generation", status: "running" as const }
        : message.agentStatus?.status === "running"
        ? { label: "Execution interrupted", status: "failed" as const }
        : message.agentStatus,
    activities: message.activities?.map((item) =>
      item.status === "running"
        ? { ...item, label: "Execution interrupted", status: "failed" as const }
        : item,
    ),
  }));
}

function storedMessages(messages: ChatMessage[]) {
  return messages.map(({ id, role, content, images, assets, autoTurn, activities, agentStatus, pendingTaskIds, pendingInspectionAssetSlug, pendingQuestion, questionAnswer, supersededQuestion }) => ({
    id,
    role,
    content,
    ...(images?.length ? { images } : {}),
    ...(assets?.length ? { assets } : {}),
    ...(autoTurn ? { autoTurn } : {}),
    ...(activities?.length ? { activities } : {}),
    ...(agentStatus ? { agentStatus } : {}),
    ...(pendingTaskIds?.length ? { pendingTaskIds } : {}),
    ...(pendingInspectionAssetSlug ? { pendingInspectionAssetSlug } : {}),
    ...(pendingQuestion ? { pendingQuestion } : {}),
    ...(questionAnswer ? { questionAnswer } : {}),
    ...(supersededQuestion ? { supersededQuestion: true } : {}),
  }));
}

/** 会话标题取用户真正说过的话；Agent 自发续跑的产物不是用户输入。 */
function sessionTitle(messages: ChatMessage[]) {
  return messages.find((message) => message.role === "user" && !message.autoTurn)?.content.slice(0, 40) || "New conversation";
}

/** 恢复当前项目最近会话 + 防抖落盘（决策 8：会话落盘在 chat 侧，换浏览器不丢） */
export function useSessionPersistence(
  projectSlug: string,
  messages: ChatMessage[],
  setMessages: (messages: ChatMessage[]) => void,
) {
  /** 当前会话自己的计划快照；项目 plan.json 只在本会话实际更新计划后才会进入这里。 */
  const [sessionPlan, setSessionPlan] = useState<ProjectPlan | null>(null);
  const sessionIdRef = useRef(`s-${projectSlug}-${Date.now().toString(36)}`);
  const [activeSessionId, setActiveSessionId] = useState(sessionIdRef.current);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  /** 会话正文恢复/切换的代次；不能与“只刷新菜单摘要”共用，否则打开菜单会取消恢复。 */
  const sessionLoadSeqRef = useRef(0);
  const sessionListSeqRef = useRef(0);
  const sessionRestoredRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 恢复请求返回那一刻要读"此刻界面上有没有消息"，state 闭包读不到，走 ref */
  const liveMessagesRef = useRef(messages);
  useLayoutEffect(() => {
    liveMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!projectSlug) return;
    sessionRestoredRef.current = false;
    setSessionReady(false);
    const restoreSeq = ++sessionLoadSeqRef.current;
    let cancelled = false;

    void fetchLatestSession(projectSlug).then((session) => {
      if (cancelled || restoreSeq !== sessionLoadSeqRef.current) return;
      /*
        恢复只在界面还是空的时候做：用户在恢复请求返回前抢先发出的消息不能被
        历史覆盖掉——那样消息从界面上凭空消失，流式回复还会写进一个已不存在的
        气泡。抢发时放弃恢复（历史仍在磁盘上），新对话用挂载时的新会话 id 另存，
        不动旧会话。
      */
      if (session && session.messages.length > 0 && liveMessagesRef.current.length === 0) {
        sessionIdRef.current = session.id;
        setActiveSessionId(session.id);
        setSessionPlan(session.plan ?? null);
        const restored = restoredMessages(session);
        liveMessagesRef.current = restored;
        setMessages(restored);
      } else if (liveMessagesRef.current.length === 0) {
        setSessionPlan(null);
      }
      sessionRestoredRef.current = true;
      setSessionReady(true);
    }).catch((err: unknown) => {
      if (cancelled || restoreSeq !== sessionLoadSeqRef.current) return;
      // 历史读取失败不能永久关住自动保存；用户仍可开始一条新会话，但必须看见故障。
      sessionRestoredRef.current = true;
      setSessionReady(true);
      if (liveMessagesRef.current.length === 0) setSessionPlan(null);
      setSessionsError(sessionErrorMessage("Failed to restore conversation", err));
    });

    return () => {
      cancelled = true;
    };
  }, [projectSlug, setMessages]);

  /** 防抖窗口内还没落盘的那次保存（执行/冲刷后置 null），供卸载冲刷调用 */
  const pendingSaveRef = useRef<(() => void) | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    const requestSeq = ++sessionListSeqRef.current;
    try {
      const list = await fetchSessions(projectSlug);
      if (mountedRef.current && requestSeq === sessionListSeqRef.current) {
        setSessions(list);
      }
    } catch (err) {
      if (mountedRef.current && requestSeq === sessionListSeqRef.current) {
        setSessionsError(sessionErrorMessage("Failed to load conversations", err));
      }
    } finally {
      if (mountedRef.current && requestSeq === sessionListSeqRef.current) {
        setSessionsLoading(false);
      }
    }
  }, [projectSlug]);

  // 防抖保存会话
  useEffect(() => {
    // 空对话不落盘；有内容就存，哪怕只有一条（原来的 `<= 1` 会把单条消息的会话丢掉）
    if (!sessionRestoredRef.current || messages.length === 0) return;
    const sessionId = sessionIdRef.current;
    const save = () => {
      pendingSaveRef.current = null;
      void saveSession(
        projectSlug,
        sessionId,
        sessionTitle(messages),
        storedMessages(messages),
        sessionPlan,
      ).catch((err: unknown) => {
        if (mountedRef.current) {
          setSessionsError(sessionErrorMessage("Failed to autosave conversation", err));
        }
      });
    };
    pendingSaveRef.current = save;
    const timer = setTimeout(save, 800);
    return () => clearTimeout(timer);
  }, [messages, projectSlug, sessionPlan]);

  // 卸载时立即冲刷最后 800ms 内还没执行的防抖保存。
  useEffect(
    () => () => {
      pendingSaveRef.current?.();
    },
    [],
  );

  /**
   * 当前项目内另起一条对话：先把旧会话的最新快照立即写盘，再换 id、清空消息。
   * 新会话保持“空对话不落盘”的纪律，直到用户真的发出第一条消息才会出现文件。
   */
  const startNewSession = useCallback(async () => {
    if (messages.length === 0) return false;

    const requestSeq = ++sessionLoadSeqRef.current;
    const snapshotMessages = liveMessagesRef.current;
    try {
      await saveSession(
        projectSlug,
        sessionIdRef.current,
        sessionTitle(messages),
        storedMessages(messages),
        sessionPlan,
      );
    } catch (err) {
      if (mountedRef.current && requestSeq === sessionLoadSeqRef.current) {
        sessionRestoredRef.current = true;
        setSessionsError(sessionErrorMessage("Failed to save before creating a conversation", err));
      }
      return false;
    }
    if (!mountedRef.current || requestSeq !== sessionLoadSeqRef.current) {
      return false;
    }
    // 用户在新建的保存窗口内抢发了消息：放弃清空，新消息继续属于当前会话。
    if (liveMessagesRef.current !== snapshotMessages) {
      sessionRestoredRef.current = true;
      return false;
    }
    pendingSaveRef.current = null;
    sessionIdRef.current = `s-${projectSlug}-${Date.now().toString(36)}`;
    setActiveSessionId(sessionIdRef.current);
    sessionRestoredRef.current = true;
    liveMessagesRef.current = [];
    setSessionPlan(null);
    setMessages([]);
    return true;
  }, [messages, projectSlug, sessionPlan, setMessages]);

  const switchSession = useCallback(
    async (id: string) => {
      if (id === sessionIdRef.current) return true;
      const requestSeq = ++sessionLoadSeqRef.current;
      const snapshotMessages = liveMessagesRef.current;
      sessionRestoredRef.current = false;
      setSessionsError(null);

      let session: StoredSession | null;
      try {
        if (messages.length > 0) {
          await saveSession(
            projectSlug,
            sessionIdRef.current,
            sessionTitle(messages),
            storedMessages(messages),
            sessionPlan,
          );
        }

        session = await fetchSession(id);
      } catch (err) {
        if (!mountedRef.current || requestSeq !== sessionLoadSeqRef.current) return false;
        sessionRestoredRef.current = true;
        setSessionsError(sessionErrorMessage("Failed to switch conversations", err));
        return false;
      }
      if (!mountedRef.current || requestSeq !== sessionLoadSeqRef.current) return false;
      if (!session || (session.projectSlug && session.projectSlug !== projectSlug)) {
        sessionRestoredRef.current = true;
        setSessionsError("Could not load this conversation");
        return false;
      }
      // 用户在切换的 save/fetch 窗口内抢发了消息：放弃覆盖，新消息继续属于当前会话
      //（稍后防抖保存），否则会像恢复路径要防的那样被 setMessages 凭空抹掉。
      if (liveMessagesRef.current !== snapshotMessages) {
        sessionRestoredRef.current = true;
        return false;
      }

      pendingSaveRef.current = null;
      sessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      const restored = restoredMessages(session);
      liveMessagesRef.current = restored;
      setMessages(restored);
      setSessionPlan(session.plan ?? null);
      sessionRestoredRef.current = true;
      return true;
    },
    [messages, projectSlug, sessionPlan, setMessages],
  );

  return {
    activeSessionId,
    sessions,
    sessionsLoading,
    sessionsError,
    sessionReady,
    refreshSessions,
    switchSession,
    sessionPlan,
    setSessionPlan,
    startNewSession,
  };
}
