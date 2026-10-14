import type { ChatMessage } from "../dto/chat";

/**
 * 回复语言：把"用户用什么语言提问"算成一条**写在用户消息末尾**的硬指令。
 *
 * 为什么不能只靠提示词（2026-10-06 用户报"我说英文它回中文"）：creator 的固定指令、
 * 服务端注入的项目上下文、计划文本、工具返回值几乎全是中文，而工作台的续跑指令却是
 * 英文——模型面前的语言信号本来就是混的，指令里那条"回复语言跟随用户"压不住它。
 * 本机会话库里两种结果都能找到：英文开场 "Generation every weapon to 3D" 得到整条
 * 中文回复；"Extract all the furniture from this image and generate 3D models" 却是
 * 英文回复。所以语言判定必须由服务端自己算，并且放在**模型最后读到的地方**
 * （本轮最后一条 user 消息末尾），而不是指望模型从混杂上下文里猜。
 *
 * 判定只取**用户自己写的话**：工作台的续跑轮（`[Self-check] …`、
 * `[Background tasks finished]` …）借 user 角色进模型、而且是英文写的，但它们不是
 * 用户发言，必须跳过——否则中文用户会在一次自动续跑之后收到英文回答。
 *
 * 混排按"词"计权：一个汉字算一个词，一段拉丁字母算一个词。
 * 「生成 golden-retriever 的 3D 模型」是中文（5 个汉字词 vs 3 个拉丁词），
 * 「Make the 金毛 red」是英文（2 vs 3）。按字符比例算会把前者误判成英文——
 * 中文用户夹英文标识符是常态。
 */

/** 语言判定结果：代码只用于测试与日志，directive 才是发给模型的那句话。 */
export type ReplyLanguage = {
  code: string;
  directive: string;
};

/**
 * 工作台/服务端自动续跑轮的标记。
 *
 * 这些文本借 user 角色进模型（协议上图片只能挂在 user 消息上），但语义上不是用户
 * 发言，而且是英文写的。判据取"以 `[Some Tag]` 开头"：现有几种（Self-check /
 * Scene check / Close-up check / Identity check / Inspection screenshots /
 * Background tasks finished / Plan continues / `[Reference image ready]` 这类
 * `[<Noun> ready]`）全部命中，而用户自己几乎不会这样开头。
 */
const WORKBENCH_TURN = /^\s*\[[A-Z][A-Za-z0-9 '’_-]{0,60}\]/;

/** 这条 user 消息是不是工作台自动生成的（不是用户写的） */
export function isWorkbenchTurn(text: string): boolean {
  return WORKBENCH_TURN.test(text);
}

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z][A-Za-z'’_-]*/g;
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
const CYRILLIC = /[\u0400-\u04ff]/;
const UKRAINIAN_LETTERS = /[іїєґ]/i;
const ARABIC = /[\u0600-\u06ff]/;
const HEBREW = /[\u0590-\u05ff]/;
const DEVANAGARI = /[\u0900-\u097f]/;
const THAI = /[\u0e00-\u0e7f]/;

/**
 * 拉丁字母语言的功能词表。判据是"命中数最多的一种"，命中 0 就按英语算——
 * 本产品的英文用户占多数，而且**绝不能**回落到中文，那正是这次要修的 bug。
 * 表里刻意不收录 `in`/`o`/`a` 这类跨语言都出现的短词，避免把英语判成意/葡。
 */
const LATIN_HINTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "en",
    [
      "the", "this", "that", "these", "those", "make", "create", "generate", "please",
      "can", "could", "you", "with", "from", "and", "to", "of", "it", "for", "want",
      "turn", "into", "model", "models", "image", "photo", "how", "what", "is", "are",
      "my", "me", "all", "every", "extract", "review",
    ],
  ],
  [
    "es",
    [
      "el", "los", "las", "una", "que", "para", "con", "por", "como", "quiero", "hacer",
      "crear", "gracias", "esta", "este", "desde", "todos", "imagen", "modelo",
    ],
  ],
  [
    "fr",
    [
      "le", "les", "une", "des", "que", "pour", "avec", "je", "vous", "faire", "créer",
      "merci", "cette", "dans", "sur", "tous", "image", "modèle",
    ],
  ],
  [
    "de",
    [
      "der", "die", "das", "und", "ein", "eine", "für", "mit", "ich", "nicht", "machen",
      "erstellen", "danke", "bitte", "von", "auf", "alle", "bild", "modell",
    ],
  ],
  [
    "pt",
    [
      "um", "uma", "para", "com", "por", "que", "criar", "fazer", "obrigado", "esta",
      "isso", "todos", "imagem", "modelo",
    ],
  ],
  [
    "it",
    [
      "il", "una", "per", "con", "che", "creare", "fare", "grazie", "questo", "questa",
      "della", "tutti", "immagine", "modello",
    ],
  ],
  ["nl", ["het", "een", "van", "voor", "met", "maak", "maken", "dank", "deze", "niet", "alle"]],
  ["pl", ["nie", "dla", "zrobić", "stwórz", "proszę", "dziękuję", "jest", "tego", "oraz", "wszystkie"]],
  ["tr", ["bir", "için", "yap", "oluştur", "lütfen", "teşekkür", "bu", "ile", "tüm"]],
  ["vi", ["một", "cho", "tạo", "với", "cảm", "của", "này", "làm", "tất"]],
  ["id", ["yang", "untuk", "buat", "dengan", "terima", "kasih", "ini", "dari", "semua"]],
];

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  id: "Indonesian",
  ru: "Russian",
  uk: "Ukrainian",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  he: "Hebrew",
  hi: "Hindi",
  th: "Thai",
};

/** 从一条用户消息里取纯文本（图片/资产部件不参与语言判定）。 */
export function chatMessageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * 判一条文本的主语言，返回语言代码；完全没有语言信号（只有数字/符号/表情）时返回
 * undefined —— 那种情况宁可不注入指令，也不要凭空指定一种语言。
 */
export function detectReplyLanguage(text: string): string | undefined {
  const body = text.replace(WORKBENCH_TURN, " ");
  if (KANA.test(body)) return "ja";
  if (HANGUL.test(body)) return "ko";
  if (CYRILLIC.test(body)) return UKRAINIAN_LETTERS.test(body) ? "uk" : "ru";
  if (ARABIC.test(body)) return "ar";
  if (HEBREW.test(body)) return "he";
  if (DEVANAGARI.test(body)) return "hi";
  if (THAI.test(body)) return "th";

  const han = (body.match(HAN) ?? []).length;
  const latin = body.match(LATIN_WORD) ?? [];
  // 汉字一个字就是一个词，拉丁字母要成段才算一个词：两者同量级时才算中文为主
  if (han > 0 && han >= latin.length) return "zh";
  if (latin.length === 0) return han > 0 ? "zh" : undefined;

  const words = new Set(latin.map((word) => word.toLowerCase()));
  let best = "en";
  let bestScore = 0;
  for (const [code, hints] of LATIN_HINTS) {
    const score = hints.reduce((sum, hint) => (words.has(hint) ? sum + 1 : sum), 0);
    if (score > bestScore) {
      best = code;
      bestScore = score;
    }
  }
  // 功能词命中太少就按英语算（拉丁字母但没法归类的文本，回落到中文一定更糟）
  return bestScore >= 2 ? best : "en";
}

/** 语言代码 → 追加在用户消息末尾的指令。中文用中文写，其余用英文点名目标语言。 */
export function replyLanguageDirective(code: string): string {
  if (code === "zh") {
    return (
      "【回复语言】用户在用中文交流：整条回复都用简体中文（正文、计划标题与步骤、" +
      "ask-user 卡片文字、新资产名称都一样）。上下文里的英文续跑指令不代表用户改用了英文。"
    );
  }
  const name = LANGUAGE_NAMES[code] ?? "English";
  return (
    `[Reply language] The user is writing in ${name}. Write your entire reply in ${name} — ` +
    `prose, plan titles and steps, ask-user card text and new asset names. ` +
    `Do not switch to another language just because the internal project context, plan text or tool ` +
    `output is written in English.`
  );
}

/**
 * 按会话里的**用户真实发言**（从最近一条往前找）判定回复语言。
 * 一条都找不到（例如整场对话只有工作台续跑轮）时返回 undefined：不注入任何指令，
 * 交回提示词里那条"跟随用户"的通用规则。
 */
export function replyLanguageForMessages(
  messages: readonly ChatMessage[],
): ReplyLanguage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = chatMessageText(message).trim();
    if (!text || isWorkbenchTurn(text)) continue;
    const code = detectReplyLanguage(text);
    if (!code) continue;
    return { code, directive: replyLanguageDirective(code) };
  }
  return undefined;
}
