import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flush } from "../../test-utils";
import type { AskUserAnswer, AskUserQuestion } from "../../shared/lib/chatClient";
import { AskUserCard } from "./AskUserCard";

/**
 * 卡片本身没有业务语义：内容全部来自模型。这里盯的是三条交互契约——
 * 单选点一下就走、多选要先勾再确认、已经答过/被跳过的卡片不能再点。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

async function render(
  props: Partial<Parameters<typeof AskUserCard>[0]> = {},
) {
  const onAnswer = mock((_answer: AskUserAnswer) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(AskUserCard, {
        question: QUESTION,
        onAnswer,
        ...props,
      } as never),
    );
  });
  return { container, onAnswer };
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

const QUESTION: AskUserQuestion = {
  questionId: "q-1",
  header: "付费确认",
  question: "是否按上述计划生成？",
  details: ["Seedream 生成参考图 1 张", "Seed3D 生成模型 1 个"],
  options: [
    { id: "approve", label: "同意", description: "调用 Seed3D", recommended: true },
    { id: "stop", label: "停止", tone: "danger" },
  ],
  multiSelect: false,
  allowOther: false,
};

const optionButton = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-ask-user-option="${id}"]`) as HTMLButtonElement;

describe("AskUserCard 待回答", () => {
  test("渲染问题、角标、明细与全部选项", async () => {
    const { container } = await render();
    const card = container.querySelector("[data-ask-user-card]")!;
    expect(card.getAttribute("data-ask-user-card")).toBe("pending");
    // 卡片在消息气泡内部，靠 mx-auto 居中；宽度与计划卡一致
    expect(card.classList.contains("mx-auto")).toBe(true);
    expect(card.classList.contains("max-w-xl")).toBe(true);
    expect(card.classList.contains("w-full")).toBe(true);
    expect(container.textContent).toContain("是否按上述计划生成？");
    expect(container.textContent).toContain("付费确认");
    expect(container.querySelectorAll("[data-ask-user-details] li")).toHaveLength(2);
    expect(container.querySelectorAll("[data-ask-user-option]")).toHaveLength(2);
    // 推荐项有标记，危险项用 signal 色
    expect(container.textContent).toContain("推荐");
    expect(optionButton(container, "stop").textContent).toContain("停止");
  });

  test("单选：点一下就把 optionId 与可读文字一起回传", async () => {
    const { container, onAnswer } = await render();
    await act(async () => optionButton(container, "approve").click());

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      questionId: "q-1",
      question: QUESTION.question,
      optionIds: ["approve"],
      labels: ["同意"],
    });
  });

  test("多选：勾选不提交，确认才提交，且空选择不能确认", async () => {
    const { container, onAnswer } = await render({
      question: { ...QUESTION, multiSelect: true },
    });
    const confirm = container.querySelector(
      "[data-ask-user-confirm]",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await act(async () => optionButton(container, "approve").click());
    expect(onAnswer).not.toHaveBeenCalled();
    expect(optionButton(container, "approve").getAttribute("data-ask-user-checked")).toBe("true");
    expect(confirm.disabled).toBe(false);

    await act(async () => confirm.click());
    expect(onAnswer.mock.calls[0]![0]).toMatchObject({ optionIds: ["approve"], labels: ["同意"] });
  });

  test("allowOther：自由输入作为补充文本一起回传", async () => {
    const { container, onAnswer } = await render({
      question: { ...QUESTION, multiSelect: true, allowOther: true },
    });
    const other = container.querySelector("[data-ask-user-other]") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(other, "只做参考图，先不做 3D");
      other.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      (container.querySelector("[data-ask-user-confirm]") as HTMLButtonElement).click(),
    );

    expect(onAnswer.mock.calls[0]![0]).toMatchObject({
      optionIds: [],
      labels: [],
      text: "只做参考图，先不做 3D",
    });
  });
});

describe("AskUserCard 终态", () => {
  test("已回答：转为只读回执，不再有可点选项", async () => {
    const { container, onAnswer } = await render({
      answer: {
        questionId: "q-1",
        question: QUESTION.question,
        optionIds: ["approve"],
        labels: ["同意"],
      },
    });
    expect(container.querySelector("[data-ask-user-card]")?.getAttribute("data-ask-user-card")).toBe("answered");
    expect(container.textContent).toContain("已选择：同意");
    expect(container.querySelectorAll("[data-ask-user-option]")).toHaveLength(0);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  test("被跳过：置灰并说明原因，问题本身仍留在历史里", async () => {
    const { container } = await render({ superseded: true });
    expect(container.querySelector("[data-ask-user-card]")?.getAttribute("data-ask-user-card")).toBe("superseded");
    expect(container.textContent).toContain("已忽略");
    expect(container.textContent).toContain("是否按上述计划生成？");
    expect(container.querySelectorAll("[data-ask-user-option]")).toHaveLength(0);
  });
});

describe("AskUserCard 折叠", () => {
  const ANSWER: AskUserAnswer = {
    questionId: "q-1",
    question: QUESTION.question,
    optionIds: ["approve"],
    labels: ["同意"],
  };
  const stateOf = (container: HTMLElement) =>
    container
      .querySelector("[data-ask-user-card]")
      ?.getAttribute("data-ask-user-card-state");
  const headerOf = (container: HTMLElement) =>
    container.querySelector("[data-ask-user-header]") as HTMLButtonElement;

  test("答完默认收起，点标题栏展开、再点收起", async () => {
    const { container } = await render({ answer: ANSWER });
    expect(stateOf(container)).toBe("collapsed");
    expect(headerOf(container).getAttribute("aria-expanded")).toBe("false");

    await act(async () => headerOf(container).click());
    expect(stateOf(container)).toBe("expanded");
    expect(headerOf(container).getAttribute("aria-expanded")).toBe("true");

    await act(async () => headerOf(container).click());
    expect(stateOf(container)).toBe("collapsed");
  });

  test("待回答时不给折叠入口：选项必须一直看得见", async () => {
    const { container } = await render();
    expect(stateOf(container)).toBe("expanded");
    expect(headerOf(container).tagName).toBe("DIV");
    expect(container.querySelector("[aria-expanded]")).toBeNull();
  });

  test("展开后把卡片自己带进视野，收起不跟", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { container } = await render({ answer: ANSWER });
      const card = container.querySelector("[data-ask-user-card]")!;

      await act(async () => headerOf(container).click());
      await flush(60);
      expect(scrolled).toContain(card);

      scrolled.length = 0;
      await act(async () => headerOf(container).click());
      await flush(60);
      expect(scrolled).toHaveLength(0);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
