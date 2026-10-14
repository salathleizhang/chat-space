import { useCallback, useEffect, useRef, useState } from "react";
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
  type SpeechLanguageOption,
  type SpeechRecognitionLike,
} from "./voiceInput";

export interface UseVoiceInputOptions {
  /** 输入框当前的文字（受控值）。**开始**听写时它成为"基线"，转写接在它后面。 */
  value: string;
  /** 把合成后的文字写回输入框。 */
  onChange: (next: string) => void;
}

export interface VoiceInputController {
  /** 浏览器是否提供识别引擎（Firefox 没有）。 */
  supported: boolean;
  listening: boolean;
  /** 需要打扰用户的那句话；`no-speech` 之类的常态噪声不会出现在这里。 */
  error: string | null;
  lang: string;
  languageOptions: SpeechLanguageOption[];
  setLang: (lang: string) => void;
  toggle: () => void;
}

/** 错误气泡自动收起的时间：够看清，又不会一直糊在输入框上。 */
const ERROR_TIMEOUT_MS = 8_000;

/**
 * 自动续跑的最小间隔。正常的一次"结束→续跑"要么是静音超时（数秒）、要么是用户手动停
 * （那时根本不会续跑），所以**远小于这个间隔的连番结束只可能是引擎在起不来**——
 * 放任它重开就是在用户的浏览器里对着识别服务打转。撞上就停手并告诉用户。
 */
const MIN_RESTART_GAP_MS = 250;

/**
 * 浏览器自带语音转写的会话管理。
 *
 * 四条不变量，缺一条都会出问题：
 * ① **不覆盖用户打的字**：转写永远接在"开始听写那一刻输入框里的内容"后面；用户中途自己
 *    改了输入框就把他改后的内容当成新基线（`rebaseIfEdited`）。
 * ② **Chrome 会自己结束会话**（静音几秒、切标签页、跑满一圈），`onend` 里要先把已经说出来的
 *    文字收口进输入框，再按用户意图续跑——否则那些字会随着结果列表一起消失。
 * ③ **致命的错误不能续跑**：权限被拒/断网/没有麦克风时立刻重启会变成高频循环
 *    （`isFatalSpeechError`）。
 * ④ **"结束→重开"本身也要有闸门**：③ 挡不住"引擎就是不报错地起不来"，
 *    `MIN_RESTART_GAP_MS` 是那一条的兜底。
 *
 * 引擎实例只建一次并复用：`SpeechRecognition` 构造是廉价的，但重新挂监听会让
 * "哪一份回调还在飞"变得不可推理。
 */
export function useVoiceInput({ value, onChange }: UseVoiceInputOptions): VoiceInputController {
  const ctor = resolveSpeechRecognitionCtor(globalThis);
  const [lang, setLangState] = useState(
    () => loadVoiceLang() ?? defaultSpeechLang(globalThis.navigator?.language),
  );
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 下面的事件处理器都活在 React 之外（浏览器回调），拿不到本次渲染的闭包值，所以走 ref。
   * 渲染期直接赋值是刻意的：effect 要等到提交之后才跑，而 `onresult` 可能正好落在两者之间。
   */
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const langRef = useRef(lang);
  langRef.current = lang;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** 用户意图。只有它为真，`onend` 才会自动续跑；它也是按钮"亮着/灭了"的真源。 */
  const wantRef = useRef(false);
  /** 开始听写那一刻输入框里的文字：转写永远接在它后面。 */
  const baseRef = useRef("");
  /** 本次识别会话里已经定稿的转写（增量累加，不会重复）。 */
  const finalRef = useRef("");
  /** 当前还在滚动的 interim 转写（下一次事件整段替换它）。 */
  const interimRef = useRef("");
  /** 我们自己最后一次写进输入框的内容，用来分辨"用户手动改过输入框"。 */
  const writtenRef = useRef<string | null>(null);
  /** 上一次会话结束的时刻，用来兜住"结束→重开"的狂奔（见 `MIN_RESTART_GAP_MS`）。 */
  const lastEndAtRef = useRef(0);

  const write = useCallback((next: string) => {
    const changed = next !== valueRef.current;
    writtenRef.current = next;
    // 同时把 valueRef 推到自己写出去的值上：`onresult` 可能在父组件重渲染**之前**就再来一次，
    // 那时 props 里的 value 还是旧的，`rebaseIfEdited` 会把我们自己的写入误判成"用户改过输入框"，
    // 于是清空缓冲、刚说的一段话整段丢掉。父组件若没接受这个值（被 maxLength 截了等），
    // 下一次渲染会把 valueRef 覆盖回真实值，rebase 依然判得准。
    valueRef.current = next;
    if (changed) onChangeRef.current(next);
  }, []);

  /**
   * 用户在我们听写期间动了输入框：把他改后的内容当成新基线，并清掉转写缓冲。
   *
   * 不做这一下的话，下一次 `onresult` 会用"旧基线 + 新转写"整段覆盖输入框，用户刚打的字
   * 无声消失。清缓冲是安全的：`readSpeechEvent` 是增量口径，已经说过的 final 不会再吐一遍
   * （这也是它不采用"每次重读整张列表"的原因）。
   */
  const rebaseIfEdited = useCallback(() => {
    if (writtenRef.current === null || valueRef.current === writtenRef.current) return;
    baseRef.current = valueRef.current;
    finalRef.current = "";
    interimRef.current = "";
  }, []);

  const compose = useCallback(() => joinTranscript(baseRef.current, finalRef.current + interimRef.current), []);

  /** 会话收口：把缓冲折进基线并落回输入框（手动停止、Chrome 自己结束、改语言时都要走）。 */
  const commit = useCallback(() => {
    rebaseIfEdited();
    const tail = finalRef.current + interimRef.current;
    finalRef.current = "";
    interimRef.current = "";
    if (!tail) return;
    baseRef.current = joinTranscript(baseRef.current, tail);
    write(baseRef.current);
  }, [rebaseIfEdited, write]);

  const createRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (!ctor) return null;
    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = langRef.current;

    recognition.onresult = (event) => {
      // rebase 必须在**累加之前**：它会清空转写缓冲，先累加再 rebase 会把刚到的这段 final 抹掉
      rebaseIfEdited();
      const { final, interim } = readSpeechEvent(event);
      finalRef.current += final;
      interimRef.current = interim;
      write(compose());
    };
    recognition.onerror = (event) => {
      const message = describeSpeechError(event.error);
      if (message) setError(message);
      if (isFatalSpeechError(event.error)) {
        wantRef.current = false;
        setListening(false);
      }
    };
    recognition.onend = () => {
      commit();
      if (!wantRef.current) {
        setListening(false);
        return;
      }
      const now = Date.now();
      if (now - lastEndAtRef.current < MIN_RESTART_GAP_MS) {
        wantRef.current = false;
        setListening(false);
        setError("Voice input keeps stopping — try again.");
        return;
      }
      lastEndAtRef.current = now;
      // 从 onend 里重启是安全的（引擎已经停止）；不排定时器："按钮灭了但其实在跑"这种
      // 自相矛盾的状态比一次失败更难查。
      try {
        recognition.start();
      } catch {
        wantRef.current = false;
        setListening(false);
        setError("Voice input stopped unexpectedly.");
      }
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [commit, compose, ctor, write]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current ?? createRecognition();
    if (!recognition) return;
    setError(null);
    baseRef.current = valueRef.current;
    finalRef.current = "";
    interimRef.current = "";
    writtenRef.current = valueRef.current;
    recognition.lang = langRef.current;
    wantRef.current = true;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // 引擎还在上一次会话里没收尾时会抛（Chrome 的 InvalidStateError）。把意图退回去，
      // 用户再点一下即可——**不在这里排定时器重试**，理由同 `onend`。
      wantRef.current = false;
      setListening(false);
      setError("Voice input couldn't start — try again.");
    }
  }, [createRecognition]);

  const stop = useCallback(() => {
    wantRef.current = false;
    setListening(false);
    commit();
    try {
      // 用 stop 而不是 abort：让它把最后几个没定稿的词定稿后再回调 onend
      recognitionRef.current?.stop();
    } catch {
      // 没在跑的时候 stop 可能抛，忽略
    }
  }, [commit]);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start();
  }, [start, stop]);

  const setLang = useCallback((next: string) => {
    setLangState(next);
    langRef.current = next;
    saveVoiceLang(next);
    const recognition = recognitionRef.current;
    if (!recognition) return;
    // 引擎是按会话读 lang 的：改语言要结束当前会话，`onend` 里会用新语言续跑
    recognition.lang = next;
    if (wantRef.current) {
      try {
        recognition.stop();
      } catch {
        // 没在跑
      }
    }
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(
    () => () => {
      wantRef.current = false;
      const recognition = recognitionRef.current;
      if (!recognition) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // 已经停了
      }
    },
    [],
  );

  return {
    supported: ctor !== null,
    listening,
    error,
    lang,
    languageOptions: speechLanguageOptions(lang),
    setLang,
    toggle,
  };
}
