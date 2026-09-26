import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LibraryAsset, PlanStep, ProjectPlan } from "../../shared/lib/libraryApi";
import {
  AgentDock,
  type AgentActivity,
  type ChatAssetAttachment,
} from "./index";

/**
 * 这里盯的是 AgentDock 作为"并发第二道闸门"的行为。真正的不变量在
 * `useAgentChat.startStream`（见那边的测试），本组件这层只是可供性——但可供性
 * 写错了照样会让用户以为自己发出去了，所以同样要锁住。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];
const originalFetch = globalThis.fetch;

const IDLE: AgentActivity = { state: "idle", message: "等待你的指令" };
const CHAIR: LibraryAsset = {
  id: "demo/chair",
  projectSlug: "demo",
  assetSlug: "chair",
  name: "休闲椅",
  kind: "model",
  modelPath: "projects/demo/assets/chair/0-chair.glb",
  modelExt: "glb",
  mtlPath: null,
  spzPath: null,
  hdrPath: null,
  modelPaths: ["projects/demo/assets/chair/0-chair.glb"],
  sourceImages: [],
  files: ["0-chair.glb"],
  thumbPath: "projects/demo/assets/chair/.thumb-0-chair.png",
  createdAt: "2026-07-30T00:00:00.000Z",
};

async function render(props: Partial<Parameters<typeof AgentDock>[0]> = {}) {
  const onSend = mock(
    (_t: string, _f?: File[], _assets?: ChatAssetAttachment[]) => {},
  );
  const onStop = mock(() => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(AgentDock, {
        messages: [],
        activity: IDLE,
        streaming: false,
        onSend,
        onStop,
        ...props,
      } as never),
    );
  });
  return { container, onSend, onStop, root };
}

/** 同一个 root 上换 props 重渲染：用来模拟 SSE 推进计划状态时的连续更新。 */
async function rerender(
  root: Root,
  props: Partial<Parameters<typeof AgentDock>[0]> = {},
) {
  await act(async () => {
    root.render(
      createElement(AgentDock, {
        messages: [],
        activity: IDLE,
        streaming: false,
        onSend: mock(() => {}),
        onStop: mock(() => {}),
        ...props,
      } as never),
    );
  });
}

const inputOf = (c: HTMLElement) => c.querySelector("input[type='text'], input:not([type])") as HTMLInputElement;
const formOf = (c: HTMLElement) => c.querySelector("form") as HTMLFormElement;

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 回车在 <form> 里走的是隐式提交，落到 form 的 submit 事件上 */
async function pressEnter(container: HTMLElement) {
  await act(async () => {
    formOf(container).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = mock(async () =>
    Response.json({ llmProviders: [] }),
  ) as unknown as typeof fetch;
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  globalThis.fetch = originalFetch;
});

describe("AgentDock 提交闸门", () => {
  test("回车提交：把输入内容交给 onSend", async () => {
    const { container, onSend } = await render();
    await typeInto(inputOf(container), "生成一把椅子");
    await pressEnter(container);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe("生成一把椅子");
  });

  test("streaming 期间回车不提交（连按回车拉不起第二条流）", async () => {
    const { container, onSend } = await render({
      streaming: true,
      activity: { state: "working", message: "Agent 正在思考" },
    });
    await typeInto(inputOf(container), "第二条");
    await pressEnter(container);
    await pressEnter(container);
    await pressEnter(container);

    expect(onSend).not.toHaveBeenCalled();
  });

  test("空输入不提交", async () => {
    const { container, onSend } = await render();
    await pressEnter(container);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("只有空白字符也不提交", async () => {
    const { container, onSend } = await render();
    await typeInto(inputOf(container), "   ");
    await pressEnter(container);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("从网页粘贴的剪贴板图片进入既有附件与提交链路", async () => {
    const { container, onSend } = await render();
    const input = inputOf(container);
    const clipboardFile = new File(["image bytes"], "image", {
      type: "image/png",
    });
    const pasteEvent = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => clipboardFile,
          },
        ],
        files: [clipboardFile],
      },
    });

    await act(async () => input.dispatchEvent(pasteEvent));

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(container.querySelector('button[aria-label="Remove image pasted-image.png"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Send images"]')).not.toBeNull();

    await pressEnter(container);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![1]).toHaveLength(1);
    expect(onSend.mock.calls[0]![1]?.[0]?.name).toBe("pasted-image.png");
    expect(onSend.mock.calls[0]![1]?.[0]?.type).toBe("image/png");
  });

  test("文件选择可追加多图并单独移除", async () => {
    const { container, onSend } = await render();
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.webp", { type: "image/webp" });
    Object.defineProperty(picker, "files", { configurable: true, value: [first, second] });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));

    expect(container.querySelectorAll('button[aria-label^="Remove image "]')).toHaveLength(2);
    await act(async () => {
      (container.querySelector('button[aria-label="Remove image first.png"]') as HTMLButtonElement).click();
    });
    await pressEnter(container);
    expect(onSend.mock.calls[0]![1]).toEqual([second]);
  });

  test("选中模型显示为缩略图附件，并随消息提交选中快照", async () => {
    const { container, onSend } = await render({ selectedAssets: [CHAIR] });

    expect(container.textContent).toContain("休闲椅");
    const attachment = container.querySelector('[aria-label="Selected model attachments"]');
    expect(attachment).not.toBeNull();
    const chip = attachment!.querySelector("[data-asset-attachment]")!;
    expect(chip.classList.contains("rounded-full")).toBe(true);
    expect(chip.classList.contains("border-hairline")).toBe(true);
    expect(chip.classList.contains("px-px")).toBe(true);
    expect(chip.classList.contains("h-11")).toBe(false);
    expect(attachment!.querySelector("img")?.classList.contains("h-10")).toBe(true);
    expect(attachment!.querySelector("img")?.getAttribute("src")).toContain(
      ".thumb-0-chair.png",
    );

    await typeInto(inputOf(container), "把它改成红色");
    await pressEnter(container);

    expect(onSend.mock.calls[0]![2]).toEqual([
      {
        assetSlug: "chair",
        name: "休闲椅",
        thumbPath: "projects/demo/assets/chair/.thumb-0-chair.png",
        kind: "model",
      },
    ]);
  });

  test("附件移除按钮会取消工作台共享选择", async () => {
    const onRemoveSelectedAsset = mock((_id: string) => {});
    const { container } = await render({
      selectedAssets: [CHAIR],
      onRemoveSelectedAsset,
    });

    const remove = container.querySelector(
      'button[aria-label="Remove model 休闲椅"]',
    ) as HTMLButtonElement;
    await act(async () => remove.click());

    expect(onRemoveSelectedAsset).toHaveBeenCalledWith("demo/chair");
  });
});

describe("AgentDock 停止按钮", () => {
  test("streaming 时按钮变成停止，且点击走 onStop 而不是 onSend", async () => {
    const { container, onSend, onStop } = await render({
      streaming: true,
      activity: { state: "working", message: "Agent 正在思考" },
    });

    const stop = container.querySelector('button[aria-label="Stop generation"]') as HTMLButtonElement;
    expect(stop).not.toBeNull();
    // 不能是 submit，否则点它反而会触发表单提交
    expect(stop.getAttribute("type")).toBe("button");
    // 必须是可点的：变灰会把用户锁在一个他已经知道错了的过程里
    expect(stop.disabled).toBe(false);
    // 停止态沿用发送态的完整液态金属材质，只替换中心动作符号。
    expect(stop.closest(".liquid-metal-send-button")?.getAttribute("data-intent")).toBe(
      "stop",
    );
    expect(
      stop.closest(".liquid-metal-send-button")?.querySelector(
        ".liquid-metal-send-button__core",
      ),
    ).not.toBeNull();
    expect(
      stop.querySelector(".liquid-metal-send-button__stop"),
    ).not.toBeNull();

    await act(async () => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("非 streaming 时是发送按钮，没有停止入口", async () => {
    const { container } = await render();
    expect(container.querySelector('button[aria-label="Stop generation"]')).toBeNull();
    const send = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.closest(".liquid-metal-send-button")).not.toBeNull();
    // 自有实现不依赖 WebGL；玻璃核心与发送控件必须同时存在。
    expect(
      send.closest(".liquid-metal-send-button")?.querySelector(
        ".liquid-metal-send-button__core",
      ),
    ).not.toBeNull();
  });
});

describe("AgentDock 会话菜单", () => {
  const EXISTING_MESSAGES = [
    { id: "u1", role: "user" as const, content: "生成一把椅子" },
  ];

  const SESSIONS = [
    {
      id: "s-current",
      projectSlug: "demo",
      title: "生成一把椅子",
      createdAt: "2026-08-01T05:00:00.000Z",
      updatedAt: "2026-08-01T06:00:00.000Z",
      messageCount: 2,
    },
    {
      id: "s-old",
      projectSlug: "demo",
      title: "制作机械狗",
      createdAt: "2026-07-31T05:00:00.000Z",
      updatedAt: "2026-07-31T06:00:00.000Z",
      messageCount: 8,
    },
  ];

  test("会话入口脱离标题栏独立显示，菜单包含新建与全部会话", async () => {
    const onNewSession = mock(async () => true);
    const onOpenSessions = mock(() => {});
    const { container } = await render({
      messages: EXISTING_MESSAGES,
      onNewSession,
      onOpenSessions,
      activeSessionId: "s-current",
      sessions: SESSIONS,
      onSelectSession: async () => true,
    });
    expect(container.querySelector('button[aria-label="Conversations"]')).toBeNull();

    const expand = container.querySelector(
      'button[aria-label="Expand agent"]',
    ) as HTMLButtonElement;
    await act(async () => expand.click());

    expect(container.querySelector("[data-agent-session-header]")).toBeNull();
    const dockPanel = container.querySelector("[data-agent-dock-panel]")!;
    const control = container.querySelector("[data-agent-session-control]")!;
    const button = control.querySelector(
      'button[aria-label="Conversations"]',
    ) as HTMLButtonElement;

    expect(control.classList.contains("absolute")).toBe(true);
    expect(control.classList.contains("top-3")).toBe(true);
    expect(control.classList.contains("right-4")).toBe(true);
    expect(dockPanel.contains(control)).toBe(true);
    expect(button).not.toBeNull();
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(button.classList.contains("h-10")).toBe(true);
    expect(button.classList.contains("bg-fill")).toBe(true);
    expect(button.classList.contains("control-edge-lit")).toBe(true);
    expect(button.classList.contains("border-line")).toBe(true);
    await act(async () => button.click());

    const menu = document.body.querySelector('[role="menu"][aria-label="Conversation list"]')!;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("rounded-surface")).toBe(true);
    expect(menu.classList.contains("rounded-inset!")).toBe(false);
    expect(menu.textContent).toContain("New conversation");
    expect(menu.textContent).toContain("生成一把椅子");
    expect(menu.textContent).toContain("制作机械狗");
    expect(onOpenSessions).toHaveBeenCalledTimes(1);

    const create = Array.from(menu.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("New conversation"),
    ) as HTMLButtonElement;
    expect(menu.classList.contains("bg-surface-raised")).toBe(true);
    expect(menu.classList.contains("shadow-lg")).toBe(true);
    expect(menu.classList.contains("gap-1")).toBe(true);
    expect(create.classList.contains("h-[54px]")).toBe(true);
    expect(create.classList.contains("rounded-inset")).toBe(true);
    expect(create.classList.contains("text-xs")).toBe(true);
    expect(create.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(create.classList.contains("bg-fill")).toBe(false);
    expect(create.classList.contains("hover:bg-fill")).toBe(true);
    expect(
      Array.from(menu.querySelectorAll("button")).every((item) =>
        item.classList.contains("rounded-inset"),
      ),
    ).toBe(true);
    await act(async () => create.click());
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  test("空会话与流式回复期间不可新建", async () => {
    const empty = await render({
      activeSessionId: "s-empty",
      onNewSession: mock(async () => true),
    });
    await act(async () =>
      (empty.container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );
    await act(async () =>
      (empty.container.querySelector(
        'button[aria-label="Conversations"]',
      ) as HTMLButtonElement).click(),
    );
    expect(
      (Array.from(document.body.querySelectorAll('[role="menu"] button')).find((item) =>
        item.textContent?.includes("New conversation"),
      ) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () =>
      (empty.container.querySelector('button[aria-label="Conversations"]') as HTMLButtonElement).click(),
    );

    const streaming = await render({
      messages: EXISTING_MESSAGES,
      streaming: true,
      activeSessionId: "s-current",
      onNewSession: mock(async () => true),
    });
    await act(async () =>
      (streaming.container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );
    await act(async () =>
      (streaming.container.querySelector(
        'button[aria-label="Conversations"]',
      ) as HTMLButtonElement).click(),
    );
    expect(
      (Array.from(document.body.querySelectorAll('[role="menu"] button')).find((item) =>
        item.textContent?.includes("New conversation"),
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("点击旧会话调用切换并关闭菜单", async () => {
    const onSelectSession = mock(async (_id: string) => true);
    const { container } = await render({
      messages: EXISTING_MESSAGES,
      activeSessionId: "s-current",
      sessions: SESSIONS,
      onNewSession: mock(async () => true),
      onSelectSession,
    });
    await act(async () =>
      (container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (container.querySelector('button[aria-label="Conversations"]') as HTMLButtonElement).click(),
    );
    const old = Array.from(document.body.querySelectorAll('[role="menu"] button')).find((item) =>
      item.textContent?.includes("制作机械狗"),
    ) as HTMLButtonElement;
    await act(async () => old.click());

    expect(onSelectSession).toHaveBeenCalledWith("s-old");
    expect(document.body.querySelector('[role="menu"][aria-label="Conversation list"]')).toBeNull();
  });
});

describe("AgentDock 会话计划", () => {
  const MESSAGES = [
    { id: "u1", role: "user" as const, content: "重新分析场景图片" },
    { id: "a1", role: "assistant" as const, content: "我先列出处理步骤。" },
  ];
  const planWith = (
    steps: PlanStep[],
    extra: Partial<ProjectPlan> = {},
  ): ProjectPlan => ({
    schemaVersion: 1,
    revision: 1,
    title: "重新分析场景图片",
    steps,
    updatedAt: "2026-08-01T06:00:00.000Z",
    ...extra,
  });
  const RUNNING = planWith([
    { id: "step-1", content: "分析第一张图片", status: "in_progress" },
    { id: "step-2", content: "汇总结果", status: "pending" },
  ]);
  const NOT_STARTED = planWith([
    { id: "step-1", content: "分析第一张图片", status: "pending" },
    { id: "step-2", content: "汇总结果", status: "pending" },
  ]);

  async function renderPlan(plan: ProjectPlan) {
    const rendered = await render({ messages: MESSAGES, plan });
    await act(async () =>
      (rendered.container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );
    return rendered;
  }

  const cardOf = (container: HTMLElement) =>
    container.querySelector("#agent-dock-history [data-plan-card]") as HTMLElement;
  const headerOf = (container: HTMLElement) =>
    cardOf(container).querySelector("[data-plan-card-header]") as HTMLButtonElement;
  /** 折叠的行仍留在 DOM 里（收高度的动画要有东西可收），按未折叠的计数。 */
  const visibleSteps = (container: HTMLElement) =>
    [...cardOf(container).querySelectorAll<HTMLElement>("[data-plan-step]")].filter(
      (step) => !step.dataset.planStepFolded,
    );
  const stepCount = (container: HTMLElement) => visibleSteps(container).length;

  test("计划开始执行后默认折叠：只留当前这一步，面板仍是标准居中卡片", async () => {
    const { container } = await renderPlan(RUNNING);
    const history = container.querySelector("#agent-dock-history")!;
    const card = cardOf(container);
    const lastMessage = history.querySelector("[data-agent-message]")!;

    expect(card).not.toBeNull();
    expect(card.classList.contains("glass")).toBe(true);
    expect(card.classList.contains("border")).toBe(true);
    expect(card.classList.contains("self-center")).toBe(true);
    expect(card.classList.contains("bg-fill!")).toBe(true);
    expect(card.classList.contains("w-full")).toBe(true);
    expect(card.classList.contains("max-w-xl")).toBe(true);
    expect(
      card.querySelector("[data-plan-card-header]")?.classList.contains("justify-between"),
    ).toBe(true);
    expect(card.dataset.planCardState).toBe("collapsed");
    expect(headerOf(container).getAttribute("aria-expanded")).toBe("false");
    // 折叠态只剩当前进行中的那一步占高度，未开始的步骤收成 0fr。
    expect(stepCount(container)).toBe(1);
    const step = card.querySelector<HTMLElement>('[data-plan-step="in_progress"]')!;
    expect(step.classList.contains("grid")).toBe(true);
    expect(step.textContent).toContain("分析第一张图片");
    expect(step.dataset.planStepFolded).toBeUndefined();
    const pending = card.querySelector<HTMLElement>('[data-plan-step="pending"]')!;
    expect(pending.dataset.planStepFolded).toBe("true");
    expect(pending.classList.contains("grid-rows-[0fr]")).toBe(true);
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    // 收放靠 grid-template-rows + opacity 过渡，不是瞬间切换。
    expect(step.className).toContain("transition-[grid-template-rows,opacity]");
    expect(step.classList.contains("grid-rows-[1fr]")).toBe(true);
    expect(
      lastMessage.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  test("点击计划标题栏展开全部步骤，再点收起", async () => {
    const { container } = await renderPlan(RUNNING);
    expect(stepCount(container)).toBe(1);

    await act(async () => headerOf(container).click());
    expect(cardOf(container).dataset.planCardState).toBe("expanded");
    expect(headerOf(container).getAttribute("aria-expanded")).toBe("true");
    expect(stepCount(container)).toBe(2);

    await act(async () => headerOf(container).click());
    expect(cardOf(container).dataset.planCardState).toBe("collapsed");
    expect(stepCount(container)).toBe(1);
  });

  test("计划还没开始执行时完整铺开，点击才折叠", async () => {
    const { container } = await renderPlan(NOT_STARTED);

    expect(cardOf(container).dataset.planCardState).toBe("expanded");
    expect(stepCount(container)).toBe(2);

    await act(async () => headerOf(container).click());
    expect(cardOf(container).dataset.planCardState).toBe("collapsed");
    expect(stepCount(container)).toBe(1);
    expect(visibleSteps(container)[0]!.textContent).toContain("分析第一张图片");
  });

  test("用户展开后，同一计划的后续进度更新不会再次自动折叠", async () => {
    const { container, root } = await renderPlan(RUNNING);
    await act(async () => headerOf(container).click());
    expect(stepCount(container)).toBe(2);

    await rerender(root, {
      messages: MESSAGES,
      plan: planWith([
        { id: "step-1", content: "分析第一张图片", status: "completed" },
        { id: "step-2", content: "汇总结果", status: "in_progress" },
      ]),
    });

    expect(cardOf(container).dataset.planCardState).toBe("expanded");
    expect(stepCount(container)).toBe(2);
  });

  test("重新规划（revision 变化）后回到默认折叠", async () => {
    const { container, root } = await renderPlan(RUNNING);
    await act(async () => headerOf(container).click());
    expect(stepCount(container)).toBe(2);

    await rerender(root, {
      messages: MESSAGES,
      plan: planWith(
        [
          { id: "step-9", content: "改用另一种分析路线", status: "in_progress" },
          { id: "step-10", content: "重新汇总", status: "pending" },
        ],
        { revision: 2, revisionReason: "原路线不可行" },
      ),
    });

    expect(cardOf(container).dataset.planCardState).toBe("collapsed");
    expect(stepCount(container)).toBe(1);
    expect(visibleSteps(container)[0]!.textContent).toContain("改用另一种分析路线");
  });

  test("全部完成且折叠时，展示最后推进过的一步而不是回到第一步", async () => {
    const { container } = await renderPlan(
      planWith([
        { id: "step-1", content: "分析第一张图片", status: "completed" },
        { id: "step-2", content: "汇总结果", status: "completed" },
      ]),
    );

    expect(cardOf(container).dataset.planCardState).toBe("collapsed");
    expect(stepCount(container)).toBe(1);
    expect(visibleSteps(container)[0]!.textContent).toContain("汇总结果");
  });
});

describe("AgentDock ask-user 提问卡片", () => {
  const QUESTION = {
    questionId: "q-1",
    header: "付费确认",
    question: "是否按上述计划生成？",
    options: [
      { id: "approve", label: "同意", recommended: true },
      { id: "stop", label: "停止", tone: "danger" as const },
    ],
    multiSelect: false,
    allowOther: false,
  };

  test("卡片留在提问那条 assistant 消息里，并使用与计划卡相同的居中阅读宽度", async () => {
    const { container } = await render({
      messages: [
        { id: "u1", role: "user", content: "把天空盒改一下" },
        {
          id: "a1",
          role: "assistant",
          content: "还有一件事需要确认。",
          pendingQuestion: QUESTION,
          agentStatus: { label: "Waiting for your decision", status: "waiting" },
        },
      ],
    });
    await act(async () =>
      (container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );

    const history = container.querySelector("#agent-dock-history")!;
    const message = history.querySelector("[data-agent-message]")!;
    const card = message.querySelector("[data-ask-user-card]")!;

    expect(card).not.toBeNull();
    // 在消息气泡内部：mx-auto 才有效（消息容器不是 flex，self-center 不生效）
    expect(card.classList.contains("mx-auto")).toBe(true);
    expect(card.classList.contains("max-w-xl")).toBe(true);
    expect(card.classList.contains("w-full")).toBe(true);
    expect(card.classList.contains("bg-fill!")).toBe(true);
    expect(message.textContent).toContain("还有一件事需要确认。");
    expect(message.querySelector('[data-agent-turn-status="waiting"]')).not.toBeNull();
  });

  test("点选项把回答交回提问那条消息的 id", async () => {
    const onAnswerQuestion = mock((_id: string, _answer: unknown) => {});
    const { container } = await render({
      messages: [
        { id: "a1", role: "assistant", content: "", pendingQuestion: QUESTION },
      ],
      onAnswerQuestion: onAnswerQuestion as never,
    });
    await act(async () =>
      (container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );

    await act(async () =>
      (container.querySelector(
        '[data-ask-user-option="approve"]',
      ) as HTMLButtonElement).click(),
    );

    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
    expect(onAnswerQuestion.mock.calls[0]![0]).toBe("a1");
    expect(onAnswerQuestion.mock.calls[0]![1]).toMatchObject({
      questionId: "q-1",
      optionIds: ["approve"],
      labels: ["同意"],
    });
  });
});

describe("AgentDock 状态行", () => {
  test("assistant 生成的参考图显示为可弹窗预览的缩略图", async () => {
    const path = "projects/demo/source/0-ref.png";
    const { container } = await render({
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "参考图已经准备好了。",
          images: [path],
        },
      ],
    });
    await act(async () =>
      (container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );

    const gallery = container.querySelector("[data-agent-generated-images]")!;
    const trigger = gallery.querySelector("button")!;
    const image = gallery.querySelector("img")!;
    expect(gallery.classList.contains("ml-[30px]")).toBe(true);
    expect(gallery.classList.contains("max-w-[calc(100%-30px)]")).toBe(true);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(image.getAttribute("src")).toContain(`/api/library/${path}`);
    expect(image.getAttribute("alt")).toBe("0-ref.png");
    expect(image.classList.contains("h-16")).toBe(true);
    expect(image.classList.contains("w-16")).toBe(true);
    expect(image.classList.contains("ring-2")).toBe(true);
    expect(image.classList.contains("ring-ink-strong")).toBe(true);
    expect(image.classList.contains("object-cover")).toBe(true);
    expect(image.classList.contains("aspect-square")).toBe(false);

    await act(async () => trigger.click());
    const dialog = document.querySelector("[data-generated-image-preview]")!;
    const preview = dialog.querySelector('img[alt="0-ref.png"]')!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.classList.contains("bg-canvas/70")).toBe(true);
    expect(preview.getAttribute("src")).toContain(`/api/library/${path}`);
    expect(preview.classList.contains("rounded-inset")).toBe(true);
    expect(preview.classList.contains("bg-field")).toBe(true);
    expect(preview.classList.contains("object-contain")).toBe(true);

    await act(async () =>
      (dialog.querySelector(
        'button[aria-label="Close generated image preview"]',
      ) as HTMLButtonElement).click(),
    );
    expect(document.querySelector("[data-generated-image-preview]")).toBeNull();
  });

  test("Agent 自发续跑的检查图渲染成 Agent 侧卡片，不是用户气泡", async () => {
    const path = "projects/demo/assets/dog/inspections/check.png";
    const { container } = await render({
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "四视角检查完成，比例正常。",
          autoTurn: {
            kind: "inspection",
            label: "Self-check · 金毛 · 4 views (ISO / Front / Right / Top)",
            images: [path],
          },
        },
      ],
    });
    await act(async () =>
      (container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );

    const card = container.querySelector("[data-agent-auto-turn='inspection']")!;
    expect(card.textContent).toContain("Self-check · 金毛 · 4 views");
    const gallery = card.querySelector("[data-agent-generated-images]")!;
    expect(gallery.querySelector("img")!.getAttribute("src")).toContain(
      `/api/library/${path}`,
    );
    // 卡片自带内边距，缩略图不再按时间线再缩进一次
    expect(gallery.classList.contains("ml-[30px]")).toBe(false);
    // 用户气泡是右对齐的 bg-fill 容器；这一步不该出现任何一个
    expect(container.querySelector(".self-end")).toBeNull();
  });

  test("生成图使用输入框附件缩略图，用户历史图片仍保留大图样式", async () => {
    const { container } = await render({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "看这张图",
          images: ["projects/demo/source/0-upload.png"],
        },
        {
          id: "a1",
          role: "assistant",
          content: "生成好了",
          images: ["projects/demo/source/1-generated.png"],
        },
      ],
    });
    await act(async () =>
      (container.querySelector(
        'button[aria-label="Expand agent"]',
      ) as HTMLButtonElement).click(),
    );

    const uploaded = container.querySelector(
      '[data-message-images="uploaded"] img',
    )!;
    const generated = container.querySelector(
      '[data-message-images="generated"] img',
    )!;
    expect(uploaded.classList.contains("max-h-48")).toBe(true);
    expect(uploaded.classList.contains("object-contain")).toBe(true);
    expect(uploaded.classList.contains("h-16")).toBe(false);
    expect(generated.classList.contains("h-16")).toBe(true);
    expect(generated.classList.contains("w-16")).toBe(true);
    expect(generated.classList.contains("ring-2")).toBe(true);
    expect(uploaded.className).not.toBe(generated.className);
    expect(uploaded.parentElement?.tagName).toBe("BUTTON");
    expect(generated.parentElement?.tagName).toBe("BUTTON");
    expect(uploaded.parentElement?.className).not.toBe(
      generated.parentElement?.className,
    );

    const uploadedTrigger = uploaded.parentElement as HTMLButtonElement;
    expect(uploadedTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => uploadedTrigger.click());
    const uploadedDialog = document.querySelector(
      "[data-uploaded-image-preview]",
    )!;
    expect(uploadedDialog.getAttribute("role")).toBe("dialog");
    expect(uploadedDialog.getAttribute("aria-modal")).toBe("true");
    expect(
      uploadedDialog.querySelector('img[alt="0-upload.png"]'),
    ).not.toBeNull();

    await act(async () =>
      (uploadedDialog.querySelector(
        'button[aria-label="Close uploaded image preview"]',
      ) as HTMLButtonElement).click(),
    );
    expect(document.querySelector("[data-uploaded-image-preview]")).toBeNull();
  });

  test("折叠且 working 时显示紧凑状态", async () => {
    const { container } = await render({
      activity: { state: "working", message: "正在导入 chair.glb" },
    });
    const status = container.querySelector("[data-agent-status]")!;
    expect(container.textContent).toContain("正在导入 chair.glb");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.querySelector("svg")?.getAttribute("width")).toBe("28");
  });

  test("attention 时不占用折叠状态栏", async () => {
    const { container } = await render({
      activity: { state: "attention", message: "保存摆位失败：磁盘只读" },
    });
    expect(container.querySelector("[data-agent-status]")).toBeNull();
  });

  test("idle 时完全不显示状态栏", async () => {
    const { container } = await render({ activity: IDLE });
    expect(container.querySelector("[data-agent-status]")).toBeNull();
    expect(container.textContent).not.toContain("等待你的指令");
  });

  test("展开后工具轨迹进入最新 assistant 消息，完成时动画冻结", async () => {
    const { container } = await render({
      activity: IDLE,
      messages: [
        { id: "u1", role: "user", content: "生成参考图" },
        {
          id: "a1",
          role: "assistant",
          content: "参考图已经准备好了。",
          activities: [
            {
              id: "tool-1",
              toolName: "generate-reference-images",
              label: "已生成参考图",
              status: "completed",
            },
          ],
        },
      ],
    });
    const expand = container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement;
    await act(async () => expand.click());

    expect(container.querySelector("[data-agent-status]")).toBeNull();
    const trace = container.querySelector('[data-agent-message-activity="completed"]')!;
    expect(trace.textContent).toContain("已生成参考图");
    expect(trace.querySelector("svg")).toBeNull();
    const completedDot = trace.querySelector('[data-agent-step-dot="completed"]')!;
    expect(completedDot).not.toBeNull();
    expect(completedDot.classList.contains("bg-ink-faint")).toBe(true);
    expect(
      container
        .querySelector('[data-agent-turn-status="completed"] svg')
        ?.getAttribute("data-animated"),
    ).toBe("false");
    expect(
      container
        .querySelector('[data-agent-turn-status="completed"] svg')
        ?.getAttribute("width"),
    ).toBe("28");
    const turnStatus = container.querySelector('[data-agent-turn-status="completed"]')!;
    const timeline = container.querySelector("[data-agent-tool-timeline]")!;
    expect(turnStatus.parentElement?.nextElementSibling).toBe(timeline);
    expect(container.querySelectorAll("[data-agent-timeline-node]")).toHaveLength(2);
    expect(container.querySelector("[data-agent-text-node]")?.textContent).toContain(
      "参考图已经准备好了。",
    );
    expect(container.querySelector("[data-agent-activity-rail]")).not.toBeNull();
    expect(container.textContent).not.toContain("文件夹");
  });

  test("一轮多个工具为首尾文字建节点，中间文字不建节点", async () => {
    const intro = "我先确认你的要求。";
    const middle = "参考图符合要求，继续生成模型。";
    const final = "模型已经生成完成。";
    const { container } = await render({
      activity: IDLE,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: intro + middle + final,
          activities: [
            {
              id: "tool-1",
              toolName: "generate-reference-images",
              contentOffset: intro.length,
              label: "已生成参考图",
              status: "completed",
            },
            {
              id: "tool-2",
              toolName: "start-3d-batch",
              contentOffset: (intro + middle).length,
              label: "已启动 3D 生成",
              status: "completed",
            },
          ],
        },
      ],
    });
    const expand = container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement;
    await act(async () => expand.click());

    expect(container.querySelectorAll("[data-agent-timeline-node]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-agent-text-node]")).toHaveLength(2);
    expect(container.querySelector("[data-agent-inline-text]")?.textContent).toBe(middle);
    expect(container.querySelectorAll("[data-agent-activity-rail]")).toHaveLength(1);
    expect(container.textContent).toContain(intro);
    expect(container.textContent).toContain(final);
  });

  test("流式文字输出时立即显示运行中节点", async () => {
    const { container } = await render({
      activity: { state: "working", message: "正在回复" },
      streaming: true,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "这段文字还在流式生成",
        },
      ],
    });
    const expand = container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement;
    await act(async () => expand.click());

    const node = container.querySelector('[data-agent-text-node="running"]')!;
    expect(node.textContent).toContain("这段文字还在流式生成");
    expect(node.querySelector("svg")).toBeNull();
    expect(node.querySelector('[data-agent-step-dot="running"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-agent-turn-status="running"] svg')
        ?.getAttribute("data-animated"),
    ).toBe("true");
  });

  test("失败工具使用静态节点显示", async () => {
    const { container } = await render({
      activity: IDLE,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "工具失败了，我会说明原因。",
          activities: [
            {
              id: "tool-failed",
              toolName: "build-cad-model",
              contentOffset: 0,
              label: "构建 CAD 模型失败",
              status: "failed",
            },
          ],
        },
      ],
    });
    const expand = container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement;
    await act(async () => expand.click());

    const node = container.querySelector('[data-agent-message-activity="failed"]')!;
    expect(node.textContent).toContain("构建 CAD 模型失败");
    expect(node.querySelector("svg")).toBeNull();
    const failedDot = node.querySelector('[data-agent-step-dot="failed"]')!;
    expect(failedDot).not.toBeNull();
    expect(failedDot.classList.contains("bg-signal")).toBe(true);
    expect(
      container
        .querySelector('[data-agent-turn-status="failed"] svg')
        ?.getAttribute("data-animated"),
    ).toBe("false");
  });

  test("展开且执行中时只在最新 assistant 消息内播放动画", async () => {
    const { container } = await render({
      activity: { state: "working", message: "正在生成贴图" },
      messages: [
        { id: "u1", role: "user", content: "生成贴图" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          activities: [
            {
              id: "tool-1",
              toolName: "generate-texture",
              label: "正在生成贴图",
              status: "running",
            },
          ],
        },
      ],
    });
    const expand = container.querySelector('button[aria-label="Expand agent"]') as HTMLButtonElement;
    await act(async () => expand.click());

    expect(container.querySelector("[data-agent-status]")).toBeNull();
    const message = container.querySelector("[data-agent-message]")!;
    const trace = message.querySelector('[data-agent-message-activity="running"]')!;
    expect(trace.textContent).toContain("正在生成贴图");
    expect(trace.querySelector("svg")).toBeNull();
    const runningDot = trace.querySelector('[data-agent-step-dot="running"]')!;
    expect(runningDot).not.toBeNull();
    expect(runningDot.classList.contains("bg-accent")).toBe(true);
    expect(runningDot.classList.contains("bg-signal")).toBe(false);
    expect(
      message
        .querySelector('[data-agent-turn-status="running"] svg')
        ?.getAttribute("data-animated"),
    ).toBe("true");
  });
});

describe("AgentDock LLM 能力筛选", () => {
  test("env 激活火山方舟时，四个模型均可选择并保存", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ llmProviders: ["volcengine"] }),
    ) as unknown as typeof fetch;
    const { container } = await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const modelSelect = container.querySelector(
      'button[aria-label="Choose chat model"]',
    ) as HTMLButtonElement;
    await act(async () => modelSelect.click());

    expect(document.body.textContent).not.toContain("Doubao Seed 2.0 Lite");
    expect(document.body.textContent).toContain("GLM 5.3 Flash");
    expect(document.body.textContent).toContain("Doubao-Seed-Evolving");
    expect(document.body.textContent).toContain("Doubao-Seed-2.1-pro");
    expect(document.body.textContent).toContain("DeepSeek V4.1 Flash");
    expect(document.body.textContent).not.toContain("GPT-4o mini");
    expect(document.body.textContent).not.toContain("Gemini 2.5 Flash");

    const choices = [
      ["GLM 5.3 Flash", "glm-5-3-flash-260828"],
      ["DeepSeek V4.1 Flash", "deepseek-v4-1-flash-260910"],
      ["Doubao-Seed-Evolving", "doubao-seed-evolving"],
      ["Doubao-Seed-2.1-pro", "doubao-seed-2-1-pro-260915"],
    ] as const;
    for (const [index, [label, model]] of choices.entries()) {
      if (index > 0) await act(async () => modelSelect.click());
      const option = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes(label),
      ) as HTMLButtonElement;
      await act(async () => option.click());
      expect(modelSelect.textContent).toContain(label);
      expect(JSON.parse(localStorage.getItem("chatspace.llmSettings:v1")!)).toMatchObject({ model });
    }
  });

  test("旧浏览器 OpenAI Key 不会激活其他模型", async () => {
    localStorage.setItem(
      "gabo.apiKeys",
      JSON.stringify({ openai: "openai-key" }),
    );
    const { container } = await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const modelSelect = container.querySelector(
      'button[aria-label="Choose chat model"]',
    ) as HTMLButtonElement;
    await act(async () => modelSelect.click());

    expect(document.body.textContent).not.toContain("GPT-4o mini");
    expect(document.body.textContent).not.toContain("Gemini 2.5 Flash");
  });
});

describe("AgentDock 图片生成模型选择", () => {
  test("LLM、3D 和图片模型默认选项统一显示 Auto", async () => {
    const { container } = await render();
    for (const label of [
      "Choose chat model",
      "Choose 3D generation model",
      "Choose image generation model",
    ]) {
      const select = container.querySelector(`button[aria-label="${label}"]`);
      expect(select?.textContent?.trim()).toBe("Auto");
    }
  });

  test("显示图片模型菜单并持久化选择", async () => {
    const { container } = await render();
    const imageModelSelect = container.querySelector(
      'button[aria-label="Choose image generation model"]',
    ) as HTMLButtonElement;

    expect(imageModelSelect).not.toBeNull();
    expect(imageModelSelect.textContent).toContain("Auto");

    await act(async () => imageModelSelect.click());
    expect(document.body.textContent).toContain("Seedream 4.5");
    expect(document.body.textContent).toContain("Seedream 5.0");
    const seedream = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Seedream 5.0 Pro"),
    ) as HTMLButtonElement;
    await act(async () => seedream.click());

    expect(JSON.parse(localStorage.getItem("chatspace.imageGenerateModelSettings:v1")!)).toEqual({
      model: "seedream-5-pro",
    });
  });
});

describe("AgentDock 3D 模型选择", () => {
  test("菜单列出具体模型而不是渠道名，并持久化选择", async () => {
    const { container } = await render();
    const threeDSelect = container.querySelector(
      'button[aria-label="Choose 3D generation model"]',
    ) as HTMLButtonElement;

    await act(async () => threeDSelect.click());
    for (const label of ["Seed3D 2.0", "Hyper3D Gen-2", "Hi3D 2.0", "Tripo 3.1", "Tripo P1", "Tripo P2"]) {
      expect(document.body.textContent).toContain(label);
    }
    const hi3d = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Hi3D 2.0"),
    ) as HTMLButtonElement;
    await act(async () => hi3d.click());

    expect(threeDSelect.textContent).toContain("Hi3D 2.0");
    expect(JSON.parse(localStorage.getItem("chatspace.threeDModelSettings:v1")!)).toEqual({
      model: "hi3d-2",
    });
  });

  test("旧版渠道偏好按该渠道默认模型回显", async () => {
    localStorage.setItem(
      "chatspace.threeDProviderSettings:v1",
      JSON.stringify({ provider: "tripo-direct" }),
    );
    const { container } = await render();
    const threeDSelect = container.querySelector(
      'button[aria-label="Choose 3D generation model"]',
    ) as HTMLButtonElement;
    expect(threeDSelect.textContent).toContain("Tripo 3.1");
  });
});
