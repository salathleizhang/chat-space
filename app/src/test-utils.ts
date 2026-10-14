import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  SpeechErrorEventLike,
  SpeechRecognitionLike,
  SpeechResultEventLike,
} from "./shared/lib/voiceInput";

/**
 * 最小 hook 测试台：把 hook 挂进一个只渲染 null 的探针组件，用 React 19 自带的
 * `act` 驱动。刻意不引入 @testing-library/react——这里只需要"渲染 / 换 props /
 * 卸载"三件事，为此加一个依赖不值得。
 */
export interface HookHarness<P, R> {
  result: { current: R };
  rerender: (props: P) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: P,
): Promise<HookHarness<P, R>> {
  const result = { current: undefined as R };
  let props = initialProps;
  const Probe = () => {
    result.current = hook(props);
    return null;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    rerender: async (next: P) => {
      props = next;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 让已排队的微任务与 0ms 定时器跑完（等 fetch 的 .then 链落地） */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 手工控制兑现时机的 promise，用来模拟"请求还在路上时组件被卸载" */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 假的识别引擎（Web Speech API）。happy-dom 里没有真的，所以语音相关的测试都挂它。
 *
 * 关键是**结果列表按会话累积**：`resultIndex` 是"第一个变化的下标"，指向累积列表里的位置，
 * 而不是"本次新结果的第 0 条"。这一点做假了，增量读取（`readSpeechEvent`）的测试会假通过。
 */
export class FakeSpeechRecognition implements SpeechRecognitionLike {
  static created: FakeSpeechRecognition[] = [];

  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechErrorEventLike) => void) | null = null;
  onresult: ((event: SpeechResultEventLike) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  /** 模拟"上一次会话还没收尾就再次 start"（Chrome 会抛 InvalidStateError） */
  throwOnStart = false;

  /** 会话内累积的结果；真引擎每次 start 都是新的一份 */
  private session: ReturnType<typeof speechResultEntry>[] = [];

  constructor() {
    FakeSpeechRecognition.created.push(this);
  }

  start(): void {
    if (this.throwOnStart) throw new Error("InvalidStateError");
    this.startCalls += 1;
    this.session = [];
  }
  stop(): void {
    this.stopCalls += 1;
  }
  abort(): void {
    this.abortCalls += 1;
  }

  /** 追加一条新结果，`resultIndex` 就是它的下标 */
  emit(item: { text: string; final?: boolean }): void {
    const index = this.session.length;
    this.session.push(speechResultEntry(item));
    this.fire(index);
  }
  /** 引擎改写已有的一条（interim 被修正），`resultIndex` 指回它 */
  revise(index: number, item: { text: string; final?: boolean }): void {
    this.session[index] = speechResultEntry(item);
    this.fire(index);
  }
  emitError(code: string): void {
    this.onerror?.({ error: code });
  }
  emitEnd(): void {
    this.onend?.();
  }

  private fire(resultIndex: number): void {
    this.onresult?.({
      resultIndex,
      results: Object.assign([...this.session], { length: this.session.length }),
    });
  }
}

function speechResultEntry(item: { text: string; final?: boolean }) {
  return { isFinal: item.final ?? false, length: 1, 0: { transcript: item.text } };
}

/** 把假引擎装成浏览器全局（Chromium 长期只有 webkit 前缀的那个名字，这里就装它）。 */
export function installFakeSpeechRecognition(): void {
  FakeSpeechRecognition.created = [];
  (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
    FakeSpeechRecognition;
}

export function removeFakeSpeechRecognition(): void {
  const scope = globalThis as unknown as {
    webkitSpeechRecognition?: unknown;
    SpeechRecognition?: unknown;
  };
  delete scope.webkitSpeechRecognition;
  delete scope.SpeechRecognition;
}
