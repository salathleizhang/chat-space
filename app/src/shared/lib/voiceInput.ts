/**
 * 浏览器自带语音识别（Web Speech API）的**纯契约**。
 *
 * 为什么这里自己声明类型：TypeScript 5.9 的 `lib.dom.d.ts` 里**没有** `SpeechRecognition`、
 * `SpeechRecognitionEvent`、`SpeechRecognitionErrorEvent`，也没有构造器声明（只有
 * `SpeechRecognitionResult` / `SpeechRecognitionAlternative` 这两个结果类型）。
 * 所以 `new SpeechRecognition()` 过不了类型检查，而 `as any` 会把下面每一条边界都藏起来。
 * 这里只如实建模真正用到的字段，测试也能按同一份形状造假对象。
 *
 * 产品上必须知道的边界（不是"以后再说"，是现在就成立的事实）：
 * ① 只有 Chromium 系（Chrome/Edge）与 Safari 提供它，**Firefox 没有** → 支持性必须探测；
 * ② Chrome 的实现**不是端侧识别**：音频会上传到 Google 的服务器，需要联网
 *    （`network` 错误就是这个原因，不是本机网络坏了）；
 * ③ 它要求安全上下文（https 或 localhost）：局域网 http 下拿不到麦克风。
 */

/** 识别结果里的一个候选（我们固定 `maxAlternatives = 1`，只读第 0 个）。 */
export interface SpeechAlternativeLike {
  transcript: string;
}

/** 一条识别结果：`isFinal` 为真表示这段不再变；否则还会被下一次事件改写。 */
export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
}

/** 一次会话里累积的结果列表（Chrome 在 `continuous` 模式下会一直往里追加）。 */
export interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
}

export interface SpeechResultEventLike {
  /** 本次事件里**第一个发生变化**的结果下标；读取口径见 `readSpeechEvent`。 */
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}

export interface SpeechErrorEventLike {
  /** `not-allowed` / `service-not-allowed` / `no-speech` / `network` / `audio-capture` / `aborted` … */
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  /** `true` 才会一直听下去，否则说完一句就结束。 */
  continuous: boolean;
  /** `true` 才有"边说边出字"，代价是同一段文字会被反复改写。 */
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onresult: ((event: SpeechResultEventLike) => void) | null;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** 浏览器里的构造器：Chromium 长期只有带前缀的那个名字，所以两个都要看。 */
export function resolveSpeechRecognitionCtor(scope: unknown): SpeechRecognitionCtor | null {
  if (!scope || typeof scope !== "object") return null;
  const candidate = scope as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  for (const value of [candidate.SpeechRecognition, candidate.webkitSpeechRecognition]) {
    if (typeof value === "function") return value as SpeechRecognitionCtor;
  }
  return null;
}

export interface SpeechLanguageOption {
  value: string;
  label: string;
}

/**
 * 下拉里常驻的语种。标签用各语言自己的写法（选语言就是这个惯例），
 * 但都取短形式——这一行已经挤了三个模型选择器，语言胶囊不能比它们还宽。
 */
export const SPEECH_LANGUAGES: readonly SpeechLanguageOption[] = [
  { value: "zh-CN", label: "中文" },
  { value: "zh-TW", label: "繁中" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "es-ES", label: "Español" },
];

const BCP47 = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * `navigator.language` → 识别引擎要的 BCP-47 标签。
 *
 * 中文单独处理：Chrome 的 `zh-CN` 与 `zh-TW` 是**两套声学模型**，把普通话语音喂给 zh-TW
 * （或反过来）会稳定输出同音错字，而且它不会报错、也不会自动纠正——
 * 所以这里按"文字系统"而不是"国家"分：TW/HK/MO 走 zh-TW，其余走 zh-CN。
 *
 * 其它语言：带地区且浏览器给了地区码时保留（en-GB、pt-BR 是有意义的），
 * 否则落到表里同语言的那一项；完全不在表里的原样透传——引擎认 BCP-47，
 * 认不出会自己报 `language-not-supported`，比我们瞎猜一个更诚实。
 */
export function defaultSpeechLang(navigatorLanguage: string | null | undefined): string {
  const raw = (navigatorLanguage ?? "").trim();
  if (!raw || !BCP47.test(raw)) return "en-US";
  const parts = raw.split("-");
  const language = (parts[0] ?? "").toLowerCase();
  const region = parts[1] ?? "";
  if (language === "zh") {
    const upper = region.toUpperCase();
    return upper === "TW" || upper === "HK" || upper === "MO" ? "zh-TW" : "zh-CN";
  }
  const exact = SPEECH_LANGUAGES.find((item) => item.value.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.value;
  const sameLanguage = SPEECH_LANGUAGES.find((item) => item.value.split("-")[0] === language);
  if (!sameLanguage) return raw;
  return region ? `${language}-${region.toUpperCase()}` : sameLanguage.value;
}

/** 下拉选项：当前语言不在表里时（pt-BR、it-IT…）顶到最前面，否则下拉会"什么都没选中"。 */
export function speechLanguageOptions(current: string): SpeechLanguageOption[] {
  if (SPEECH_LANGUAGES.some((item) => item.value === current)) return [...SPEECH_LANGUAGES];
  return [{ value: current, label: current }, ...SPEECH_LANGUAGES];
}

export interface SpeechTranscript {
  /** 本次事件里新定稿的那一段（要累加到会话缓冲上）。 */
  final: string;
  /** 还没定稿的尾巴（每次事件**整段替换**上一次的，不是追加）。 */
  interim: string;
}

/**
 * 事件 → 本次新增的转写。
 *
 * 口径是**增量**的（从 `resultIndex` 读到列表末尾），与 react-speech-recognition 等
 * 主流实现一致。理由：`resultIndex` 是"第一个变化的下标"，Chrome 修订一段 interim 时
 * 会把它连同后面的 interim 一起重发，所以"final 累加 + interim 替换"既不会丢字也不会重复。
 *
 * 另一条路是每次事件都重读**整张列表**（幂等，看起来更稳），但那与"用户中途改输入框就把
 * 基线重置"冲突：整张列表会把已经折进基线的 final 再吐一遍，用户打的字后面就会多出一份
 * 镜像。增量口径才配得上 rebase，见 `useVoiceInput` 的 `rebaseIfEdited`。
 */
export function readSpeechEvent(event: SpeechResultEventLike): SpeechTranscript {
  const results = event.results;
  const total = results?.length ?? 0;
  const from = Math.max(0, Math.min(event.resultIndex ?? 0, total));
  let final = "";
  let interim = "";
  for (let index = from; index < total; index += 1) {
    const result = results[index];
    const text = result?.[0]?.transcript ?? "";
    if (!text) continue;
    if (result?.isFinal) final += text;
    else interim += text;
  }
  return { final, interim };
}

/**
 * 把转写接在已有文字后面。
 *
 * 分隔符按"基线最后一个字符是不是 ASCII 字母/数字"决定：英文需要空格
 * （"make a" + "red chair"），中日韩不需要（"做一个" + "红色的椅子"），
 * 而基线自带空白（"make a " / 换行）时也不该再多一个空格。
 */
export function joinTranscript(base: string, transcript: string): string {
  if (!transcript) return base;
  if (!base) return transcript;
  return /[A-Za-z0-9]$/.test(base) ? `${base} ${transcript}` : `${base}${transcript}`;
}

/** `no-speech`（静音一会儿）与 `aborted`（我们自己叫停时可能收到）都不是故障。 */
const BENIGN_ERRORS = new Set(["no-speech", "aborted"]);

/** 错误码 → 给用户看的一句话；返回 null 表示"这个错不值得打扰用户"。 */
export function describeSpeechError(code: string): string | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked — allow it for this site in the browser settings.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Browser speech recognition needs a network connection.";
    case "language-not-supported":
      return "The browser can't recognize this language — pick another one.";
    default:
      return BENIGN_ERRORS.has(code) ? null : `Voice input failed (${code}).`;
  }
}

/**
 * 这个错误之后该不该自动续跑。
 *
 * 权限被拒、断网、没有麦克风这些**立刻重试只会立刻再失败**（Chrome 会以每秒若干次的频率
 * 循环），必须把"想听"的意图收回；静音结束（`no-speech`）则相反——那正是连续听写的常态，
 * Chrome 静一会儿就结束一次会话，续跑才接得上。
 */
export function isFatalSpeechError(code: string): boolean {
  return !BENIGN_ERRORS.has(code);
}

export interface VoiceKeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

/** 焦点在可编辑元素上（与 `transformKeys.isTypingTarget` 同一条判据）。 */
function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { isContentEditable?: boolean; tagName?: string };
  if (element.isContentEditable) return true;
  return /^(input|textarea|select)$/i.test(element.tagName ?? "");
}

/**
 * 语音输入快捷键 `V` 的闸门，与视口 G/R/S 逐条同源：
 * ① 正在输入框里打字时不抢键（否则打 "v" 会变成开麦）；② 带 meta/ctrl/alt 时不管
 * （⌘V 是粘贴）；③ 长按重复触发不管（`repeat`）。
 * 键位表之外的按键返回 false，调用方**不要** `preventDefault`。
 */
export function voiceShortcutApplies(event: VoiceKeyEventLike): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.repeat) return false;
  if (event.key.toLowerCase() !== "v") return false;
  return !isTypingTarget(event.target);
}

const VOICE_LANG_KEY = "chatspace.voiceInputSettings:v1";

export function loadVoiceLang(): string | null {
  try {
    const raw = localStorage.getItem(VOICE_LANG_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const lang = (parsed as { lang?: unknown }).lang;
    return typeof lang === "string" && lang.trim() ? lang : null;
  } catch {
    // 隐私模式/禁用 localStorage：回落到浏览器语言，不影响功能
    return null;
  }
}

export function saveVoiceLang(lang: string): void {
  try {
    localStorage.setItem(VOICE_LANG_KEY, JSON.stringify({ lang }));
  } catch {
    // 同上：存不下就只在本次会话里生效
  }
}
