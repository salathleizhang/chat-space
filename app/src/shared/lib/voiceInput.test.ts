import { afterEach, describe, expect, test } from "bun:test";
import {
  defaultSpeechLang,
  describeSpeechError,
  isFatalSpeechError,
  joinTranscript,
  loadVoiceLang,
  readSpeechEvent,
  resolveSpeechRecognitionCtor,
  saveVoiceLang,
  speechLanguageOptions,
  SPEECH_LANGUAGES,
  voiceShortcutApplies,
  type SpeechResultEventLike,
} from "./voiceInput";

/** 按引擎的形状造结果列表：`{ isFinal, length, [0]: { transcript } }`。 */
function results(...items: { text: string; final?: boolean }[]): SpeechResultEventLike["results"] {
  const list = items.map((item) => ({
    isFinal: item.final ?? false,
    length: 1,
    0: { transcript: item.text },
  }));
  return Object.assign(list, { length: list.length });
}

function event(resultIndex: number, ...items: { text: string; final?: boolean }[]): SpeechResultEventLike {
  return { resultIndex, results: results(...items) };
}

describe("resolveSpeechRecognitionCtor", () => {
  const FAKE = function Fake() {} as never;

  test("优先用无前缀的构造器，缺失时回落到 webkit 前缀", () => {
    expect(resolveSpeechRecognitionCtor({ SpeechRecognition: FAKE })).toBe(FAKE);
    expect(resolveSpeechRecognitionCtor({ webkitSpeechRecognition: FAKE })).toBe(FAKE);
  });

  test("两个都没有（Firefox）或作用域不是对象时返回 null", () => {
    expect(resolveSpeechRecognitionCtor({})).toBeNull();
    expect(resolveSpeechRecognitionCtor(undefined)).toBeNull();
    expect(resolveSpeechRecognitionCtor("window")).toBeNull();
    // 只是挂了个同名非函数属性，不算支持
    expect(resolveSpeechRecognitionCtor({ SpeechRecognition: true })).toBeNull();
  });
});

describe("defaultSpeechLang", () => {
  test("中文按文字系统分：TW/HK/MO 走 zh-TW，其余 zh-CN", () => {
    expect(defaultSpeechLang("zh-CN")).toBe("zh-CN");
    expect(defaultSpeechLang("zh")).toBe("zh-CN");
    expect(defaultSpeechLang("zh-Hans-CN")).toBe("zh-CN");
    expect(defaultSpeechLang("zh-TW")).toBe("zh-TW");
    expect(defaultSpeechLang("zh-HK")).toBe("zh-TW");
    expect(defaultSpeechLang("zh-MO")).toBe("zh-TW");
  });

  test("带地区码的语言保留地区（en-GB / pt-BR），只有语言时落到表里的默认项", () => {
    expect(defaultSpeechLang("en")).toBe("en-US");
    expect(defaultSpeechLang("en-US")).toBe("en-US");
    expect(defaultSpeechLang("en-GB")).toBe("en-GB");
    expect(defaultSpeechLang("ja")).toBe("ja-JP");
    expect(defaultSpeechLang("it-IT")).toBe("it-IT");
  });

  test("空值/非法标签回落到 en-US", () => {
    expect(defaultSpeechLang("")).toBe("en-US");
    expect(defaultSpeechLang(null)).toBe("en-US");
    expect(defaultSpeechLang(undefined)).toBe("en-US");
    expect(defaultSpeechLang("!!!")).toBe("en-US");
  });
});

describe("speechLanguageOptions", () => {
  test("表里的语言原样返回；表外的语言顶到最前面，避免下拉里什么都不选中", () => {
    expect(speechLanguageOptions("zh-CN")).toEqual([...SPEECH_LANGUAGES]);
    const options = speechLanguageOptions("pt-BR");
    expect(options[0]).toEqual({ value: "pt-BR", label: "pt-BR" });
    expect(options).toHaveLength(SPEECH_LANGUAGES.length + 1);
  });
});

describe("readSpeechEvent", () => {
  test("定稿与未定稿分开返回，且都从 resultIndex 读起", () => {
    expect(readSpeechEvent(event(0, { text: "生成一个", final: true }, { text: "红色的" }))).toEqual({
      final: "生成一个",
      interim: "红色的",
    });
  });

  test("resultIndex 之前的结果不再返回（增量口径：不会把已定稿的吐第二遍）", () => {
    expect(readSpeechEvent(event(1, { text: "旧的", final: true }, { text: "新的", final: true }))).toEqual({
      final: "新的",
      interim: "",
    });
  });

  test("下标越界/空列表都不抛，返回空串", () => {
    expect(readSpeechEvent(event(0))).toEqual({ final: "", interim: "" });
    expect(readSpeechEvent(event(9, { text: "落空", final: true }))).toEqual({ final: "", interim: "" });
  });
});

describe("joinTranscript", () => {
  test("英文之间补空格，中日韩直接拼，基线自带空白时不再补", () => {
    expect(joinTranscript("make a", "red chair")).toBe("make a red chair");
    expect(joinTranscript("make a ", "red chair")).toBe("make a red chair");
    expect(joinTranscript("做一个", "红色的椅子")).toBe("做一个红色的椅子");
    expect(joinTranscript("", "你好")).toBe("你好");
    expect(joinTranscript("已有的字", "")).toBe("已有的字");
    expect(joinTranscript("", "")).toBe("");
  });
});

describe("describeSpeechError / isFatalSpeechError", () => {
  test("权限、断网、没有麦克风、语言不支持都有可读文案", () => {
    expect(describeSpeechError("not-allowed")).toContain("Microphone access is blocked");
    expect(describeSpeechError("service-not-allowed")).toContain("Microphone access is blocked");
    expect(describeSpeechError("audio-capture")).toContain("No microphone");
    expect(describeSpeechError("network")).toContain("network");
    expect(describeSpeechError("language-not-supported")).toContain("can't recognize");
    expect(describeSpeechError("weird-code")).toContain("weird-code");
  });

  test("静音与主动中止不打扰用户，但其它错误都不能自动续跑", () => {
    expect(describeSpeechError("no-speech")).toBeNull();
    expect(describeSpeechError("aborted")).toBeNull();
    expect(isFatalSpeechError("no-speech")).toBe(false);
    expect(isFatalSpeechError("aborted")).toBe(false);
    expect(isFatalSpeechError("not-allowed")).toBe(true);
    expect(isFatalSpeechError("network")).toBe(true);
    expect(isFatalSpeechError("weird-code")).toBe(true);
  });
});

describe("voiceShortcutApplies", () => {
  test("裸按 V（大小写都算）触发", () => {
    expect(voiceShortcutApplies({ key: "v" })).toBe(true);
    expect(voiceShortcutApplies({ key: "V" })).toBe(true);
  });

  test("输入框/可编辑区里打字不抢键", () => {
    expect(voiceShortcutApplies({ key: "v", target: { tagName: "INPUT" } })).toBe(false);
    expect(voiceShortcutApplies({ key: "v", target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(voiceShortcutApplies({ key: "v", target: { isContentEditable: true } })).toBe(false);
    // 普通元素上仍然触发
    expect(voiceShortcutApplies({ key: "v", target: { tagName: "DIV" } })).toBe(true);
  });

  test("带 meta/ctrl/alt 不管（⌘V 是粘贴），长按重复不管，别的键不管", () => {
    expect(voiceShortcutApplies({ key: "v", metaKey: true })).toBe(false);
    expect(voiceShortcutApplies({ key: "v", ctrlKey: true })).toBe(false);
    expect(voiceShortcutApplies({ key: "v", altKey: true })).toBe(false);
    expect(voiceShortcutApplies({ key: "v", repeat: true })).toBe(false);
    expect(voiceShortcutApplies({ key: "g" })).toBe(false);
    expect(voiceShortcutApplies({ key: "Shift" })).toBe(false);
  });
});

describe("语音语言偏好持久化", () => {
  afterEach(() => localStorage.clear());

  test("存下来能读回去", () => {
    expect(loadVoiceLang()).toBeNull();
    saveVoiceLang("ja-JP");
    expect(loadVoiceLang()).toBe("ja-JP");
  });

  test("坏数据（非对象/字段类型不对/空串）一律当作没存过", () => {
    localStorage.setItem("chatspace.voiceInputSettings:v1", "[\"zh-CN\"]");
    expect(loadVoiceLang()).toBeNull();
    localStorage.setItem("chatspace.voiceInputSettings:v1", JSON.stringify({ lang: 3 }));
    expect(loadVoiceLang()).toBeNull();
    localStorage.setItem("chatspace.voiceInputSettings:v1", JSON.stringify({ lang: "  " }));
    expect(loadVoiceLang()).toBeNull();
    localStorage.setItem("chatspace.voiceInputSettings:v1", "{ 坏 JSON");
    expect(loadVoiceLang()).toBeNull();
  });
});
