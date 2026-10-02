import { describe, expect, test } from "bun:test";
import { flush, renderHook } from "../../test-utils";
import type { ChatMessage } from "../../widgets/AgentDock";
import { useReferenceImageSurfacing } from "./useReferenceImageSurfacing";

const assistant = (id: string, images?: string[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  ...(images && images.length > 0 ? { images } : {}),
});

const user = (id: string): ChatMessage => ({ id, role: "user", content: "hi" });

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
  referenceImages: string[];
  messages: ChatMessage[];
}

async function mount(props: Props, spy: ReturnType<typeof surfacingSpy>) {
  return renderHook((current: Props) => {
    useReferenceImageSurfacing({ ...current, updateMessage: spy.updateMessage });
  }, props);
}

describe("参考图落盘即进对话", () => {
  test("恢复出来的历史会话：补挂会话里没出现过的参考图，按生成顺序", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        // 项目状态是新→旧
        referenceImages: ["projects/p/source/2-sofa-ref.jpg", "projects/p/source/2-chair-ref.jpg"],
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

  test("空会话把进入工作台时已有的参考图当作基线，不倒历史图", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      { ready: true, loaded: true, referenceImages: ["projects/p/source/2-sofa-ref.jpg"], messages: [] },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    // 这一轮之后新落盘的图才该出现
    await h.rerender({
      ready: true,
      loaded: true,
      referenceImages: [
        "projects/p/source/3-new-ref.jpg",
        "projects/p/source/2-sofa-ref.jpg",
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

  test("SSE 已经贴过的参考图不会重复贴第二遍", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      {
        ready: true,
        loaded: true,
        referenceImages: ["projects/p/source/2-sofa-ref.jpg"],
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
    const h = await mount(
      { ready: true, loaded: true, referenceImages: ["projects/p/source/2-sofa-ref.jpg"], messages: [assistant("m1")] },
      spy,
    );
    await flush();
    await h.rerender({
      ready: true,
      loaded: true,
      referenceImages: ["projects/p/source/2-sofa-ref.jpg"],
      messages: [assistant("m1")],
    });
    await flush();
    expect(spy.calls).toHaveLength(1);
    await h.unmount();
  });

  test("还没有助手消息时不记成已展示，等消息出现再补", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      { ready: true, loaded: true, referenceImages: ["projects/p/source/2-sofa-ref.jpg"], messages: [user("m1")] },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.rerender({
      ready: true,
      loaded: true,
      referenceImages: ["projects/p/source/2-sofa-ref.jpg"],
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
        referenceImages: ["projects/p/source/2-sofa-ref.jpg"],
        messages: [],
      },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);
    await h.unmount();
  });

  /**
   * 项目状态扫描完成前 `referenceImages` 恒为空，此时定基线会把"还没读到"当成
   * "项目里本来没有图"，于是扫描结果一到、历史参考图就被整套倒进新对话里。
   */
  test("项目状态还没扫完时不定基线", async () => {
    const spy = surfacingSpy();
    const h = await mount(
      { ready: true, loaded: false, referenceImages: [], messages: [] },
      spy,
    );
    await flush();
    expect(spy.calls).toHaveLength(0);

    // 扫描结果落地：这是一个空会话，已有的参考图算"早就有的"，不该倒出来
    await h.rerender({
      ready: true,
      loaded: true,
      referenceImages: ["projects/p/source/2-sofa-ref.jpg"],
      messages: [],
    });
    await flush();
    expect(spy.calls).toHaveLength(0);

    await h.unmount();
  });
});
