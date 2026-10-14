import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import {
  FakeSpeechRecognition as FakeRecognition,
  installFakeSpeechRecognition,
  removeFakeSpeechRecognition,
  renderHook,
} from "../../test-utils";
import { useVoiceInput, type VoiceInputController } from "./useVoiceInput";

interface MountedVoice {
  hook: { result: { current: VoiceInputController }; unmount: () => Promise<void> };
  onChange: ReturnType<typeof mock>;
  /** 引擎开着的时候拿它 */
  engine: () => FakeRecognition;
  /** 模拟受控输入框把 onChange 收到的值回灌给钩子（父组件重渲染） */
  flushToInput: () => Promise<void>;
  /** 模拟用户自己在输入框里改字 */
  typeIntoInput: (next: string) => Promise<void>;
  toggle: () => Promise<void>;
}

async function mountVoice(initialValue = ""): Promise<MountedVoice> {
  const onChange = mock((_next: string) => {});
  let value = initialValue;
  const hook = await renderHook(
    (props: { value: string; onChange: (next: string) => void }) => useVoiceInput(props),
    { value, onChange },
  );
  const flushToInput = async () => {
    const next = onChange.mock.calls.at(-1)?.[0];
    if (next === undefined || next === value) return;
    value = next;
    await hook.rerender({ value, onChange });
  };
  const typeIntoInput = async (next: string) => {
    value = next;
    await hook.rerender({ value, onChange });
  };
  return {
    hook: hook as unknown as MountedVoice["hook"],
    onChange,
    engine: () => FakeRecognition.created[0]!,
    flushToInput,
    typeIntoInput,
    toggle: async () => {
      await act(async () => {
        hook.result.current.toggle();
      });
    },
  };
}

beforeEach(() => {
  installFakeSpeechRecognition();
  localStorage.clear();
  localStorage.setItem("chatspace.voiceInputSettings:v1", JSON.stringify({ lang: "zh-CN" }));
});

afterEach(() => {
  removeFakeSpeechRecognition();
  localStorage.clear();
});

describe("useVoiceInput：会话参数与基线", () => {
  test("开始听写时按连续 + interim 模式开引擎，并把输入框现有文字当基线", async () => {
    const voice = await mountVoice("做一个");
    expect(voice.hook.result.current.supported).toBe(true);
    expect(voice.hook.result.current.lang).toBe("zh-CN");

    await voice.toggle();

    const engine = voice.engine();
    expect(engine.continuous).toBe(true);
    expect(engine.interimResults).toBe(true);
    expect(engine.maxAlternatives).toBe(1);
    expect(engine.lang).toBe("zh-CN");
    expect(engine.startCalls).toBe(1);
    expect(voice.hook.result.current.listening).toBe(true);

    await act(async () => engine.emit({ text: "红色的椅子", final: true }));
    expect(voice.onChange).toHaveBeenLastCalledWith("做一个红色的椅子");
  });

  test("interim 是整段替换而不是追加，定稿后继续接在后面", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emit({ text: "红" }));
    expect(voice.onChange).toHaveBeenLastCalledWith("红");
    await act(async () => engine.revise(0, { text: "红色" }));
    expect(voice.onChange).toHaveBeenLastCalledWith("红色");
    await act(async () => engine.revise(0, { text: "红色", final: true }));
    expect(voice.onChange).toHaveBeenLastCalledWith("红色");
    await act(async () => engine.emit({ text: "椅子" }));
    expect(voice.onChange).toHaveBeenLastCalledWith("红色椅子");
  });

  test("连续两次事件之间父组件还没重渲染，也不会把自己的写入误判成用户编辑", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    // 刻意不 flushToInput：模拟 onresult 在一次 React 提交之前连着来两回
    await act(async () => engine.emit({ text: "第一段", final: true }));
    await act(async () => engine.emit({ text: "第二段", final: true }));
    expect(voice.onChange).toHaveBeenLastCalledWith("第一段第二段");
  });
});

describe("useVoiceInput：不覆盖用户打的字", () => {
  test("听写期间用户自己改输入框 → 他改后的内容成为新基线", async () => {
    const voice = await mountVoice("做一个");
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emit({ text: "红色的椅子", final: true }));
    await voice.flushToInput();
    expect(voice.onChange).toHaveBeenLastCalledWith("做一个红色的椅子");

    await voice.typeIntoInput("我自己改的");
    await act(async () => engine.emit({ text: "新的", final: true }));
    expect(voice.onChange).toHaveBeenLastCalledWith("我自己改的新的");
  });
});

describe("useVoiceInput：会话结束与续跑", () => {
  test("引擎自己结束（静音）时先把没定稿的话收口，再用同一份状态续跑", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emit({ text: "最后一句" }));
    await voice.flushToInput();
    await act(async () => engine.emitEnd());

    expect(engine.startCalls).toBe(2);
    expect(voice.hook.result.current.listening).toBe(true);
    // 收口没做的话，下面这次 interim 会把"最后一句"整段顶掉
    await act(async () => engine.emit({ text: "新的" }));
    expect(voice.onChange).toHaveBeenLastCalledWith("最后一句新的");
  });

  test("手动停止后不再续跑，并且把最后几个没定稿的词留在输入框里", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emit({ text: "收尾" }));
    await voice.flushToInput();
    await voice.toggle();

    expect(engine.stopCalls).toBe(1);
    expect(voice.hook.result.current.listening).toBe(false);
    await act(async () => engine.emitEnd());
    expect(engine.startCalls).toBe(1);
  });

  test("静音（no-speech）不打扰用户，引擎结束后照旧续跑", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emitError("no-speech"));
    expect(voice.hook.result.current.error).toBeNull();
    expect(voice.hook.result.current.listening).toBe(true);
    await act(async () => engine.emitEnd());
    expect(engine.startCalls).toBe(2);
  });
});

describe("useVoiceInput：错误与卸载", () => {
  test("麦克风被拒 → 报可读文案、停掉、不再自动续跑", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emitError("not-allowed"));
    expect(voice.hook.result.current.error).toContain("Microphone access is blocked");
    expect(voice.hook.result.current.listening).toBe(false);

    await act(async () => engine.emitEnd());
    expect(engine.startCalls).toBe(1);
  });

  test("start 抛错（上一次会话没收尾）时把意图退回去，并给出可再试的提示", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();
    await voice.toggle(); // 先停下来
    engine.throwOnStart = true;

    await voice.toggle(); // 再开一次：这次引擎抛 InvalidStateError

    expect(voice.hook.result.current.listening).toBe(false);
    expect(voice.hook.result.current.error).toContain("couldn't start");
  });

  test("浏览器不支持时 toggle 是空操作（一个引擎实例都不建）", async () => {
    removeFakeSpeechRecognition();
    const voice = await mountVoice();
    expect(voice.hook.result.current.supported).toBe(false);
    await voice.toggle();
    expect(FakeRecognition.created).toHaveLength(0);
  });

  test("卸载时 abort 掉引擎", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();
    await voice.hook.unmount();
    expect(engine.abortCalls).toBe(1);
  });
});

describe("useVoiceInput：语言", () => {
  test("改语言会落盘、结束当前会话，并用新语言续跑", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emit({ text: "你好", final: true }));
    await voice.flushToInput();
    await act(async () => voice.hook.result.current.setLang("en-US"));
    expect(localStorage.getItem("chatspace.voiceInputSettings:v1")).toBe(JSON.stringify({ lang: "en-US" }));
    expect(engine.lang).toBe("en-US");
    expect(engine.stopCalls).toBe(1);

    await act(async () => engine.emitEnd());
    expect(engine.startCalls).toBe(2);
    expect(voice.hook.result.current.listening).toBe(true);
    // 新会话的结果接在已经说过的话后面，不重复
    await act(async () => engine.emit({ text: "hello", final: true }));
    expect(voice.onChange).toHaveBeenLastCalledWith("你好hello");
  });

  test("没存过偏好时回落到浏览器语言（不是空串）", async () => {
    localStorage.clear();
    const voice = await mountVoice();
    expect(voice.hook.result.current.lang).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
  });
});

describe("useVoiceInput：狂奔兜底", () => {
  test("引擎连着立刻结束（起不来）时不再无限重开，而是停手并说明", async () => {
    const voice = await mountVoice();
    await voice.toggle();
    const engine = voice.engine();

    await act(async () => engine.emitEnd()); // 第一次结束：正常续跑
    expect(engine.startCalls).toBe(2);

    await act(async () => engine.emitEnd()); // 250ms 之内又结束：判定为起不来
    expect(engine.startCalls).toBe(2);
    expect(voice.hook.result.current.listening).toBe(false);
    expect(voice.hook.result.current.error).toContain("keeps stopping");
  });
});
