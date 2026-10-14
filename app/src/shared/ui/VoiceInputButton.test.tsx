import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FakeSpeechRecognition as FakeRecognition,
  installFakeSpeechRecognition,
  removeFakeSpeechRecognition,
} from "../../test-utils";
import { VoiceInputButton } from "./VoiceInputButton";

/**
 * 这一层测的是"组件接线"，不是钩子逻辑（那边有自己的测试）。
 * 最关键的一条是**识别出来的字真的落进了输入框**——这是这个功能的全部意义。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

/** 受控输入框 + 语音按钮：与产品里的接线形状一致（value / onChange 两个口子）。 */
function Harness({ initial = "" }: { initial?: string }) {
  const [text, setText] = useState(initial);
  return createElement(
    "div",
    null,
    createElement("input", {
      "aria-label": "instructions",
      value: text,
      onChange: (event: { target: { value: string } }) => setText(event.target.value),
    }),
    createElement(VoiceInputButton, { value: text, onChange: setText }),
  );
}

async function render(initial?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(Harness, initial === undefined ? {} : { initial }));
  });
  return {
    container,
    input: () => container.querySelector<HTMLInputElement>('input[aria-label="instructions"]')!,
    mic: () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]') ??
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop voice input"]')!,
    engine: () => FakeRecognition.created[0]!,
  };
}

function pressKey(target: Window | Element, key: string) {
  return act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  installFakeSpeechRecognition();
  localStorage.clear();
  localStorage.setItem("chatspace.voiceInputSettings:v1", JSON.stringify({ lang: "zh-CN" }));
});

afterEach(async () => {
  removeFakeSpeechRecognition();
  localStorage.clear();
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

describe("VoiceInputButton", () => {
  test("点麦克风开始听写，识别结果直接写进输入框（接在已有文字后面）", async () => {
    const view = await render("做一个");

    // 语言胶囊与麦克风都在，麦克风可点
    expect(view.container.querySelector('button[aria-label="Speech recognition language"]')).not.toBeNull();
    expect(view.mic().disabled).toBe(false);
    expect(view.mic().getAttribute("aria-pressed")).toBe("false");

    await act(async () => view.mic().click());

    expect(view.mic().getAttribute("aria-pressed")).toBe("true");
    expect(view.mic().getAttribute("aria-label")).toBe("Stop voice input");
    expect(view.engine().startCalls).toBe(1);

    await act(async () => view.engine().emit({ text: "红色的椅子", final: true }));
    expect(view.input().value).toBe("做一个红色的椅子");

    // 再点一下停止
    await act(async () => view.mic().click());
    expect(view.mic().getAttribute("aria-pressed")).toBe("false");
  });

  test("按 V 开麦；焦点在输入框里时 V 只是打字，不抢键", async () => {
    const view = await render();

    await pressKey(window, "v");
    expect(view.mic().getAttribute("aria-pressed")).toBe("true");
    await pressKey(window, "v");
    expect(view.mic().getAttribute("aria-pressed")).toBe("false");

    // 在输入框里按 V：不开麦，也不吃掉这次按键
    const input = view.input();
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(view.mic().getAttribute("aria-pressed")).toBe("false");
    expect(event.defaultPrevented).toBe(false);
  });

  test("权限被拒时把原因摆在按钮上方（role=alert），而不是静默失败", async () => {
    const view = await render();
    await act(async () => view.mic().click());
    await act(async () => view.engine().emitError("not-allowed"));

    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Microphone access is blocked");
    expect(view.mic().getAttribute("aria-pressed")).toBe("false");
  });

  test("浏览器不支持识别引擎时：麦克风禁用、干脆不渲染语言胶囊", async () => {
    removeFakeSpeechRecognition();
    const view = await render();

    expect(view.mic().disabled).toBe(true);
    expect(view.container.querySelector('button[aria-label="Speech recognition language"]')).toBeNull();
    // 按 V 也不会有任何反应（连引擎都不建）
    await pressKey(window, "v");
    expect(FakeRecognition.created).toHaveLength(0);
  });
});
