import { describe, expect, test } from "bun:test";
import { flush, renderHook } from "../../test-utils";
import type { ChatMessage } from "../../widgets/AgentDock";
import type { GeneratedReference } from "../../shared/lib/libraryApi";
import { useReferenceImageSurfacing } from "./useReferenceImageSurfacing";

const assistant = (id: string, images?: string[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  ...(images && images.length > 0 ? { images } : {}),
});

const user = (id: string): ChatMessage => ({ id, role: "user", content: "hi" });

/** 会话开始的基准时刻：所有"历史图/本轮新图"都相对它取时间。 */
const SESSION_START = Date.parse("2026-10-02T12:00:00.000Z");

/** 生成时间相对会话开始的毫秒偏移（负数 = 早于会话，历史图）。 */
function ref(path: string, offsetMs: number): GeneratedReference {
  return { path, generatedAt: new Date(SESSION_START + offsetMs).toISOString() };
}

/** 记账式 updateMessage：只记录被挂图的调用，不真的改消息列表。 */
function surfacingSpy() {
  const calls: Array<{ id: string; updater: (message: ChatMessage) => ChatMessage }> = [];
  const updateMessage = (id: string, updater: (message: ChatMessage) => ChatMessage) => {
    calls.push({ id, updater });
  };
  /** 第 n 次挂图：写进哪条消息、追加了哪些图（默认在空白助手消息上求值）。 */
  const attached = (call: number, base?: ChatMessage) => {
    const { id, updater } = calls[call]!;
    return { id, images: updater(base ?? assistant(id)).images ?? [] };
  };
  return { updateMessage, calls, attached };
}

interface Props {
  ready: boolean;
  loaded: boolean;
  referenceImages: GeneratedReference[];
  sessionStartedAt?: number;
  messages: ChatMessage[];
}

async function mount(props: Props, spy: ReturnType<typeof surfacingSpy>) {
  return renderHook((current: Props) => {
    useReferenceImageSurfacing({ ...current, updateMessage: spy.updateMessage });
  }, props);
}

describe("参考图落盘即进对话", () => {
  test("恢复出来的历史会话：补挂会话开始之后才落盘的参考图，按生成顺序", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        sessionStartedAt: SESSION_START,
        // 项目状态是新→旧
        referenceImages: [
          ref("projects/p/source/2-sofa-ref.jpg", 60_000),
          ref("projects/p/source/2-chair-ref.jpg", 30_000),
        ],
        messages: [user("m1"), assistant("m2", ["projects/p/assets/sofa/.thumb.png"])],
      },
      spy,
    );
    await flush();

    expect(spy.calls).toHaveLength(1);
    expect(spy.attached(0, assistant("m2", ["projects/p/assets/sofa/.thumb.png"]))).toEqual({
      id: "m2",
      // 原有的缩略图保留，参考图按旧→新追加
      images: [
        "projects/p/assets/sofa/.thumb.png",
        "projects/p/source/2-chair-ref.jpg",
        "projects/p/source/2-sofa-ref.jpg",
      ],
    });

    await h.unmount();
  });

  test("早于会话开始的参考图属于上一轮，一律不贴", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [ref("projects/p/source/2-sofa-ref.jpg", -3_600_000)],
        messages: [],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    // 这一轮之后新落盘的图才该出现
    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: [
        ref("projects/p/source/3-new-ref.jpg", 5_000),
        ref("projects/p/source/2-sofa-ref.jpg", -3_600_000),
      ],
      messages: [assistant("m1")],
    });
    await flush();
    expect(spy.attached(0)).toEqual({
      id: "m1",
      images: ["projects/p/source/3-new-ref.jpg"],
    });

    await h.unmount();
  });

  /**
   * 2026-10-02 用户报的正是这一条：新建会话后，上一轮的参考图被挂到了新会话的第一条
   * 助手消息上。根因是旧口径拿"第一次观测到的清单"当基线，而项目状态会在后台任务落盘
   * 时重扫——基线恰好落在"还没读到图"的窗口里时基线就是空集，之后每张历史图都是"新"的。
   * 这里刻意复现那个时序：基线时清单为空，之后旧图才随重扫出现。
   */
  test("基线时清单为空、旧图随后才被扫出来：仍然不贴（新会话不该倒上一轮的图）", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [],
        messages: [],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    // 新会话里用户先说话、助手已回复；项目状态随后才扫出上一轮那张图
    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: [ref("projects/p/source/0-chair-ref.jpg", -7_200_000)],
      messages: [user("u1"), assistant("a1")],
    });
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.unmount();
  });

  /**
   * 反向的时序同样要挡住：项目状态在会话恢复落定**之前**就带着旧图到位。
   * 旧口径在这里会把"界面上暂时没有消息"读成"新会话"，把整份项目历史倒出来。
   */
  test("进入项目时项目状态先到、带旧图，会话随后才恢复成空：旧图不贴", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: false,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [ref("projects/p/source/0-chair-ref.jpg", -7_200_000)],
        messages: [],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: [ref("projects/p/source/0-chair-ref.jpg", -7_200_000)],
      messages: [],
    });
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.unmount();
  });

  test("SSE 已经贴过的参考图不会重复贴第二遍", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [ref("projects/p/source/2-sofa-ref.jpg", 10_000)],
        messages: [assistant("m1", ["projects/p/source/2-sofa-ref.jpg"])],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);
    await h.unmount();
  });

  test("同一批参考图只挂一次（状态刷新不会反复追加）", async () => {
    const spy = surfacingSpy();
    const references = [ref("projects/p/source/2-sofa-ref.jpg", 10_000)];
    const h = await mount(
      { ready: true, loaded: true, sessionStartedAt: SESSION_START, referenceImages: references, messages: [assistant("m1")] },
      spy,
    );
    await flush();
    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: references,
      messages: [assistant("m1")],
    });
    await flush();
    expect(spy.calls).toHaveLength(1);
    await h.unmount();
  });

  test("还没有助手消息时不记成已展示，等消息出现再补", async () => {
    const spy = surfacingSpy();
    const references = [ref("projects/p/source/2-sofa-ref.jpg", 10_000)];
    const h = await mount(
      { ready: true, loaded: true, sessionStartedAt: SESSION_START, referenceImages: references, messages: [user("m1")] },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: references,
      messages: [user("m1"), assistant("m2")],
    });
    await flush();
    expect(spy.attached(0)).toEqual({
      id: "m2",
      images: ["projects/p/source/2-sofa-ref.jpg"],
    });

    await h.unmount();
  });

  test("会话还没恢复完时什么都不做", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: false,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [ref("projects/p/source/2-sofa-ref.jpg", 10_000)],
        messages: [],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);
    await h.unmount();
  });

  /**
   * 项目状态扫描完成前 `referenceImages` 恒为空。若此时定基线，扫描结果一到、
   * "本会话新落盘"的图就会被当成历史图漏掉。
   */
  test("项目状态还没扫完时不定基线", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      { ready: true, loaded: false, sessionStartedAt: SESSION_START, referenceImages: [], messages: [] },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    // 扫描结果落地：这是本会话产出的图（晚于会话开始），要贴
    await h.rerender({
      ready: true,
      loaded: true,
      sessionStartedAt: SESSION_START,
      referenceImages: [ref("projects/p/source/2-sofa-ref.jpg", 10_000)],
      messages: [assistant("m1")],
    });
    await flush();
    expect(spy.attached(0)).toEqual({
      id: "m1",
      images: ["projects/p/source/2-sofa-ref.jpg"],
    });

    await h.unmount();
  });

  /**
   * 会话开始时间读不出来（历史会话文件没有 createdAt）时，按"全部算历史"处理：
   * 宁可少贴，也不要把上一轮的图倒进当前会话。
   */
  test("拿不到会话开始时间时一律不贴", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        referenceImages: [ref("projects/p/source/2-sofa-ref.jpg", 10_000)],
        messages: [assistant("m1")],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);
    await h.unmount();
  });

  /**
   * 请求侧写与浏览器会话是同一台机器的同一个系统时钟，但侧写时间字段缺省/损坏时
   * 不能让整批图消失：按"会话开始"算，等于承认它晚于基线。
   */
  test("侧写时间缺失时不整批丢掉，按可解析处理", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        sessionStartedAt: SESSION_START,
        referenceImages: [{ path: "projects/p/source/2-sofa-ref.jpg", generatedAt: "not-a-date" }],
        messages: [assistant("m1")],
      },
      spy,
    );
    await flush();
    expect(spy.attached(0)).toEqual({
      id: "m1",
      images: ["projects/p/source/2-sofa-ref.jpg"],
    });
    await h.unmount();
  });
});
