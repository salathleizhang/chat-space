import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { deferred, flush, renderHook } from "../../test-utils";
import type {
  SessionMessage,
  SessionSummary,
  StoredSession,
} from "../../shared/lib/sessionsClient";
import type { ProjectPlan } from "../../shared/lib/libraryApi";
import type { ChatMessage } from "../../widgets/AgentDock";

const fetchLatestSession = mock(async (_slug: string): Promise<StoredSession | null> => null);
const fetchSessions = mock(async (_slug: string): Promise<SessionSummary[]> => []);
const fetchSession = mock(async (_id: string): Promise<StoredSession | null> => null);
const saveSession = mock(
  async (
    _projectSlug: string,
    _id: string,
    _title: string,
    _messages: SessionMessage[],
    _plan?: ProjectPlan | null,
  ): Promise<void> => {},
);
mock.module("../../shared/lib/sessionsClient", () => ({
  fetchLatestSession,
  fetchSessions,
  fetchSession,
  saveSession,
}));

const { useSessionPersistence } = await import("./useSessionPersistence");

/** 防抖是 800ms，越过它才看得到落盘 */
const PAST_DEBOUNCE = 900;

function session(
  slug: string,
  messages: ChatMessage[],
  plan?: ProjectPlan,
): StoredSession {
  return {
    id: `s-${slug}`,
    projectSlug: slug,
    title: slug,
    messages,
    ...(plan ? { plan } : {}),
    updatedAt: "",
  };
}

const SESSION_PLAN: ProjectPlan = {
  schemaVersion: 1,
  title: "生成机械狗",
  steps: [{ id: "step-1", content: "生成模型", status: "in_progress" }],
  updatedAt: "2026-08-01T06:00:00.000Z",
};

/** 模拟 AppDashboard：messages 的 state 住在父组件，hook 只拿到值和 setter */
function parent(initial: ChatMessage[] = []) {
  let messages = initial;
  const setMessages = mock((next: ChatMessage[]) => {
    messages = next;
  });
  return {
    setMessages,
    get messages() {
      return messages;
    },
    set messages(next: ChatMessage[]) {
      messages = next;
    },
    mount: (slug: string) =>
      renderHook(
        (current: string) => useSessionPersistence(current, messages, setMessages),
        slug,
      ),
  };
}

beforeEach(() => {
  fetchLatestSession.mockReset();
  fetchSessions.mockReset();
  fetchSession.mockReset();
  saveSession.mockReset();
  fetchLatestSession.mockImplementation(async () => null);
  fetchSessions.mockImplementation(async () => []);
  fetchSession.mockImplementation(async () => null);
  saveSession.mockImplementation(async () => {});
});

describe("useSessionPersistence", () => {
  /**
   * 清场只在"确实换了项目"时做。首次进入时 messages 本来就是空的，无条件清空
   * 只会误伤用户在恢复请求返回前抢先发出的第一条消息——chat 服务没起时
   * `fetchLatestSession` 要等到连接被拒才 resolve，这个窗口不算短。
   */
  test("首次进入项目不清空消息", async () => {
    const p = parent();
    const h = await p.mount("fresh");

    // 恢复请求还在路上，用户已经发出第一条
    p.messages = [{ id: "m1", role: "user", content: "抢先发的" }];
    await h.rerender("fresh");
    await flush();

    expect(p.setMessages).not.toHaveBeenCalled();
    expect(p.messages).toHaveLength(1);

    await h.unmount();
  });

  test("恢复会话时冻结遗留的 running 动画", async () => {
    fetchLatestSession.mockImplementation(async () =>
      session("stale", [
        {
          id: "a1",
          role: "assistant",
          content: "",
          agentStatus: { label: "正在生成贴图", status: "running" },
          activities: [
            { id: "tool-1", label: "正在生成贴图", status: "running" },
          ],
        },
      ]),
    );
    const p = parent();
    const h = await p.mount("stale");
    await flush();

    expect(p.messages[0]?.activities?.[0]).toMatchObject({
      label: "执行已中断",
      status: "failed",
    });
    expect(p.messages[0]?.agentStatus).toEqual({
      label: "执行已中断",
      status: "failed",
    });
    await h.unmount();
  });

  test("只有一条消息的会话也会落盘（原来的 length <= 1 会丢掉它）", async () => {
    const p = parent();
    const h = await p.mount("solo");
    await flush();

    p.messages = [{ id: "m1", role: "assistant", content: "⚠️ 还没有配置 LLM API key" }];
    await h.rerender("solo");
    await flush(PAST_DEBOUNCE);

    expect(saveSession.mock.calls.some(([slug]) => slug === "solo")).toBe(true);

    await h.unmount();
  });

  test("模型附件快照随会话落盘", async () => {
    const p = parent();
    const h = await p.mount("attached");
    await flush();

    p.messages = [
      {
        id: "m1",
        role: "user",
        content: "把它改成红色",
        assets: [
          {
            assetSlug: "chair",
            name: "休闲椅",
            thumbPath: "projects/attached/assets/chair/.thumb-0-chair.png",
            kind: "model",
          },
        ],
      },
    ];
    await h.rerender("attached");
    await flush(PAST_DEBOUNCE);

    const saved = saveSession.mock.calls.find(([slug]) => slug === "attached");
    expect(saved?.[3][0]?.assets).toEqual(p.messages[0]!.assets);

    await h.unmount();
  });

  test("assistant 工具执行记录随会话落盘", async () => {
    const p = parent();
    const h = await p.mount("activity");
    await flush();

    p.messages = [
      {
        id: "a1",
        role: "assistant",
        content: "处理完成",
        agentStatus: { label: "已完成", status: "completed" },
        activities: [
          {
            id: "tool-1",
            toolName: "generate-texture",
            contentOffset: 0,
            label: "已生成贴图",
            status: "completed",
          },
        ],
      },
    ];
    await h.rerender("activity");
    await flush(PAST_DEBOUNCE);

    const saved = saveSession.mock.calls.find(([slug]) => slug === "activity");
    expect(saved?.[3][0]?.activities).toEqual(p.messages[0]!.activities);
    expect(saved?.[3][0]?.agentStatus).toEqual(p.messages[0]!.agentStatus);

    await h.unmount();
  });

  test("空对话不落盘", async () => {
    const p = parent();
    const h = await p.mount("empty");
    await flush(PAST_DEBOUNCE);

    expect(saveSession).not.toHaveBeenCalled();

    await h.unmount();
  });

  test("有历史会话时沿用它的 id，不新开一条", async () => {
    fetchLatestSession.mockImplementation(async () =>
      session("keep", [{ id: "m1", role: "user", content: "旧消息" }]),
    );

    const p = parent();
    const h = await p.mount("keep");
    await flush();
    await h.rerender("keep");

    p.messages = [...p.messages, { id: "m2", role: "user", content: "新消息" }];
    await h.rerender("keep");
    await flush(PAST_DEBOUNCE);

    const saves = saveSession.mock.calls.filter(([slug]) => slug === "keep");
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.at(-1)![1]).toBe("s-keep");

    await h.unmount();
  });

  test("恢复会话时只恢复该会话保存的计划快照", async () => {
    fetchLatestSession.mockImplementation(async () =>
      session(
        "planned",
        [{ id: "m1", role: "user", content: "生成机械狗" }],
        SESSION_PLAN,
      ),
    );

    const p = parent();
    const h = await p.mount("planned");
    await flush();

    expect(h.result.current.sessionPlan).toEqual(SESSION_PLAN);
    await h.unmount();
  });

  test("切换会话时恢复对应消息与计划，并先保存当前会话", async () => {
    fetchLatestSession.mockImplementation(async () =>
      session("current", [{ id: "m1", role: "user", content: "当前会话" }]),
    );
    fetchSession.mockImplementation(async (id) =>
      id === "s-old"
        ? {
            ...session(
              "old",
              [{ id: "m2", role: "user", content: "旧会话消息" }],
              SESSION_PLAN,
            ),
            id: "s-old",
            projectSlug: "current",
          }
        : null,
    );

    const p = parent();
    const h = await p.mount("current");
    await flush();
    await h.rerender("current");
    saveSession.mockClear();

    let switched = false;
    await act(async () => {
      switched = await h.result.current.switchSession("s-old");
    });

    expect(switched).toBe(true);
    expect(saveSession.mock.calls[0]![1]).toBe("s-current");
    expect(p.messages[0]?.content).toBe("旧会话消息");
    expect(h.result.current.activeSessionId).toBe("s-old");
    expect(h.result.current.sessionPlan).toEqual(SESSION_PLAN);
    await h.unmount();
  });

  test("首次恢复晚于手动切换返回时，不覆盖用户刚切到的会话", async () => {
    const latest = deferred<StoredSession | null>();
    fetchLatestSession.mockImplementationOnce(async () => latest.promise);
    fetchSession.mockImplementationOnce(async () => ({
      ...session("manual", [{ id: "m2", role: "user", content: "手动选择的会话" }]),
      id: "s-manual",
      projectSlug: "race",
    }));

    const p = parent();
    const h = await p.mount("race");

    let switched = false;
    await act(async () => {
      switched = await h.result.current.switchSession("s-manual");
    });
    expect(switched).toBe(true);
    expect(p.messages[0]?.content).toBe("手动选择的会话");

    latest.resolve(
      session("race", [{ id: "m1", role: "user", content: "迟到的默认会话" }]),
    );
    await flush();

    expect(h.result.current.activeSessionId).toBe("s-manual");
    expect(p.messages[0]?.content).toBe("手动选择的会话");
    await h.unmount();
  });

  test("首次恢复在途时打开会话菜单，不会误取消正文恢复", async () => {
    const latest = deferred<StoredSession | null>();
    fetchLatestSession.mockImplementationOnce(async () => latest.promise);

    const p = parent();
    const h = await p.mount("menu-race");
    await act(async () => h.result.current.refreshSessions());

    latest.resolve(
      session("menu-race", [{ id: "m1", role: "user", content: "应该恢复的会话" }]),
    );
    await flush();

    expect(p.messages[0]?.content).toBe("应该恢复的会话");
    expect(h.result.current.activeSessionId).toBe("s-menu-race");
    await h.unmount();
  });

  test("新建会话：立即保存旧对话、清空界面，并让下一条消息使用新 id", async () => {
    fetchLatestSession.mockImplementation(async () =>
      session("new-chat", [{ id: "m1", role: "user", content: "旧会话内容" }]),
    );

    const p = parent();
    const h = await p.mount("new-chat");
    await flush();
    await h.rerender("new-chat");
    saveSession.mockClear();

    await act(async () => h.result.current.setSessionPlan(SESSION_PLAN));
    await act(async () => h.result.current.startNewSession());

    expect(p.messages).toEqual([]);
    expect(h.result.current.sessionPlan).toBeNull();
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession.mock.calls[0]![1]).toBe("s-new-chat");
    expect(saveSession.mock.calls[0]![3][0]?.content).toBe("旧会话内容");
    expect(saveSession.mock.calls[0]![4]).toEqual(SESSION_PLAN);

    p.messages = [{ id: "m2", role: "user", content: "新会话内容" }];
    await h.rerender("new-chat");
    await flush(PAST_DEBOUNCE);

    const latestSave = saveSession.mock.calls.at(-1)!;
    expect(latestSave[1]).not.toBe("s-new-chat");
    expect(latestSave[3][0]?.content).toBe("新会话内容");

    await h.unmount();
  });

  test("新建会话前保存失败：保留当前对话并显示错误", async () => {
    const current = [{ id: "m1", role: "user" as const, content: "不能丢的内容" }];
    fetchLatestSession.mockImplementation(async () => session("keep", current));
    saveSession.mockImplementationOnce(async () => {
      throw new Error("磁盘不可写");
    });
    const p = parent();
    const h = await p.mount("keep");
    await flush();
    await h.rerender("keep");

    let created = true;
    await act(async () => {
      created = await h.result.current.startNewSession();
    });

    expect(created).toBe(false);
    expect(p.messages).toEqual(current);
    expect(h.result.current.sessionsError).toContain("磁盘不可写");
    await h.unmount();
  });

  test("切换会话前保存失败：不离开当前会话", async () => {
    const current = [{ id: "m1", role: "user" as const, content: "当前内容" }];
    fetchLatestSession.mockImplementation(async () => session("current", current));
    saveSession.mockImplementationOnce(async () => {
      throw new Error("保存失败");
    });
    const p = parent();
    const h = await p.mount("current");
    await flush();
    await h.rerender("current");

    let switched = true;
    await act(async () => {
      switched = await h.result.current.switchSession("s-other");
    });

    expect(switched).toBe(false);
    expect(h.result.current.activeSessionId).toBe("s-current");
    expect(p.messages).toEqual(current);
    expect(h.result.current.sessionsError).toContain("保存失败");
    expect(fetchSession).not.toHaveBeenCalled();
    await h.unmount();
  });
});
