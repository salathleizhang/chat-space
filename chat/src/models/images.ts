import { ChatServiceError } from "../common/errors";
import { IMAGE_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../common/http";

/**
 * 图片生成（文生图）+ 编辑（img2img）传输客户端，2026-07 合并自原
 * imageGen.ts / imageEdit.ts / imageChannels.ts 三个文件：拆开纯粹是为了
 * "两个文件共享一套渠道选路又互不依赖"，一旦生成和编辑本就该在一个文件里，
 * 那层拆分就只剩仪式感——渠道常量、选路函数、data URI 解析器直接放在本文件
 * 顶部给下面两段共用，不再需要单独导出。
 *
 * 渠道覆盖：
 * - OpenAI 兼容 images API（OpenAI 官方用于生成；火山方舟的 Seedream 用同一
 *   端点完成生成与编辑）。
 * - Gemini generateContent（Google 官方）：生成与编辑是同一个调用，编辑只是
 *   多带一到多个 inlineData part，故意不共享同一个函数 signature（生成不需要
 *   images 参数）。
 * - OpenRouter（chat completions + modalities 用于生成/编辑 nano-banana 等
 *   对话型模型，编辑多带 image_url part）。Seedream 只走火山方舟。
 */

// ---------- 渠道选路（生成/编辑共用） ----------

export const IMAGE_CHANNELS = ["volcengine", "google", "openai", "openrouter"] as const;
export type ImageChannel = (typeof IMAGE_CHANNELS)[number];

const IMAGE_CHANNEL_KEYS = {
  volcengine: "volcengineApiKey",
  google: "googleApiKey",
  openai: "openaiApiKey",
  openrouter: "openrouterApiKey",
} as const;

const IMAGE_CHANNEL_LABELS: Record<ImageChannel, string> = {
  volcengine: "火山方舟",
  google: "Google AI",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export type ImageProviderKeys = Partial<
  Record<(typeof IMAGE_CHANNEL_KEYS)[ImageChannel], string>
>;

/** 按已激活 key 选渠道：未指定渠道时按模型声明顺序（原厂优先）取第一个有 key 的。 */
function selectImageChannel<Entry>(
  modelLabel: string,
  channels: Partial<Record<ImageChannel, Entry>>,
  keys: ImageProviderKeys,
  preferred?: ImageChannel,
): { channel: ImageChannel; entry: Entry; apiKey: string } {
  const candidates = preferred ? [preferred] : (Object.keys(channels) as ImageChannel[]);
  for (const channel of candidates) {
    const entry = channels[channel];
    if (!entry) {
      if (preferred) {
        throw new ChatServiceError(
          `模型「${modelLabel}」不支持经 ${IMAGE_CHANNEL_LABELS[channel]} 调用（可选：${Object.keys(channels).join("、")}）`,
          400,
          "channel_unsupported",
        );
      }
      continue;
    }
    const apiKey = keys[IMAGE_CHANNEL_KEYS[channel]];
    if (apiKey) return { channel, entry, apiKey };
    if (preferred) {
      throw new ChatServiceError(
        `缺少 ${IMAGE_CHANNEL_LABELS[channel]} API key，请在设置中填写`,
        401,
        `missing_${IMAGE_CHANNEL_KEYS[channel]}`,
      );
    }
  }
  throw new ChatServiceError(
    `模型「${modelLabel}」支持的渠道（${Object.keys(channels)
      .map((c) => IMAGE_CHANNEL_LABELS[c as ImageChannel])
      .join("、")}）都没有配置 API key，请在设置中填写任意一家`,
    401,
    "missing_imagegen_key",
  );
}

const DATA_URI_RE = /^data:([^;]+);base64,(.*)$/s;

/** 解析本地资产库读出的 data URI（供编辑渠道构造 inlineData/image_url part） */
function parseDataUri(dataUri: string): { mimeType: string; base64: string } {
  const match = DATA_URI_RE.exec(dataUri);
  if (!match) {
    throw new ChatServiceError("输入图不是有效的 data URI", 400, "invalid_data_uri");
  }
  return { mimeType: match[1]!, base64: match[2]! };
}

export interface ImageGenOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
}

/** 归一化的结果：URL（可下载/可修复）或内联 base64 二选一 */
export interface GeneratedImageRef {
  url?: string;
  dataBase64?: string;
  mimeType?: string;
}

/**
 * 3D 参考图的归一化画布。宽物体占绝大多数资产生成场景，因此默认由上层选择
 * landscape；各供应商的参数名和可用尺寸不同，在本文件统一映射。
 */
export const REFERENCE_IMAGE_CANVASES = ["landscape", "portrait", "square"] as const;
export type ReferenceImageCanvas = (typeof REFERENCE_IMAGE_CANVASES)[number];

interface ImageGenerateInput {
  prompt: string;
  count: number;
  canvas: ReferenceImageCanvas;
  /** Seedream 的同一个 images/generations 端点接受参考图用于图片编辑。 */
  images?: string[];
  /**
   * 火山方舟专用：显式输出尺寸。可填档位（`2K` / `4K`）或精确 `宽x高`
   * （总像素区间 [2560x1440, 4096x4096]、宽高比 [1/16, 16]）。
   * 缺省按输入图（编辑）或 canvas（文生图）推断——**档位/上限与模型强相关，
   * 5.0 系没有 3K/4K 档，塞超限值会直接 400**，所以只有明确知道模型上限的
   * 调用方（天空盒那条，钉的是 4.5）才显式传。
   */
  size?: string;
}

const ASPECT_RATIO_BY_CANVAS: Record<ReferenceImageCanvas, "4:3" | "3:4" | "1:1"> = {
  landscape: "4:3",
  portrait: "3:4",
  square: "1:1",
};

const VOLCENGINE_SIZE_BY_CANVAS: Record<ReferenceImageCanvas, string> = {
  landscape: "2304x1728",
  portrait: "1728x2304",
  square: "2048x2048",
};

const OPENAI_SIZE_BY_CANVAS: Record<ReferenceImageCanvas, string> = {
  landscape: "1536x1024",
  portrait: "1024x1536",
  square: "1024x1024",
};

async function jsonOrThrow(
  response: Response,
  what: string,
  code: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ChatServiceError(
      `${what}失败（${response.status}）：${JSON.stringify(body).slice(0, 300)}`,
      502,
      code,
    );
  }
  return body;
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** 返回体里内嵌的 data URL（OpenRouter 三个函数共用同一种响应形状） */
const RESPONSE_DATA_URL_RE = /^data:([^;]+);base64,(.*)$/;

// ---------- 文生图 ----------

/**
 * OpenAI 兼容 images API：OpenAI 官方与火山方舟共用（baseUrl 区分）。
 * 端点、鉴权、响应形状两家一致，只有「要几张」各说各话，故留一个 dialect 分支
 * （火山方舟字段经官方文档核实 2026-07）：
 * - OpenAI：`n`。
 * - 火山方舟：**没有 `n`**，多张走组图开关 `sequential_image_generation`
 *   （默认 `disabled` 只出一张，传 n 会被静默忽略）+
 *   `sequential_image_generation_options.max_images`（上限 15）。注意 `auto`
 *   是「模型自主判断出几张」，max_images 只封顶，实际张数可能少于 count。
 *   另外 watermark 默认 true（右下角"AI 生成"字样）——这些图是要喂给图生 3D
 *   的参考图，水印会被烘进网格与贴图，必须关掉。
 * - `size` 两家都收，但方舟的可选值与**模型强相关**：档位 `1K`/`2K`/`3K`/`4K`
 *   （5.0 系没有 3K/4K、上限约 419 万像素），或精确 `宽x高`（总像素
 *   [2560x1440, 4096x4096]、宽高比 [1/16, 16]）。传超限值直接 400，所以只有
 *   明确知道模型上限的调用方（天空盒那条：4.5 + 4096x2048）才显式传 `size`。
 */
export async function generateImagesOpenAICompat(
  baseUrl: string,
  model: string,
  input: ImageGenerateInput,
  options: ImageGenOptions,
  dialect: "openai" | "volcengine" = "openai",
): Promise<GeneratedImageRef[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const requestBody: Record<string, unknown> = { model, prompt: input.prompt };
  if (dialect === "volcengine") {
    requestBody.watermark = false;
    requestBody.response_format = "url";
    requestBody.size =
      input.size ?? (input.images?.length ? "2K" : VOLCENGINE_SIZE_BY_CANVAS[input.canvas]);
    if (input.images?.length) {
      for (const image of input.images) parseDataUri(image);
      requestBody.image = input.images.length === 1 ? input.images[0] : input.images;
    }
    if (input.count > 1) {
      requestBody.sequential_image_generation = "auto";
      requestBody.sequential_image_generation_options = { max_images: input.count };
    }
  } else {
    requestBody.n = input.count;
    requestBody.size = OPENAI_SIZE_BY_CANVAS[input.canvas];
  }
  const response = await fetchWithTimeout(
    fetchFn,
    `${baseUrl.replace(/\/$/, "")}/images/generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
    IMAGE_REQUEST_TIMEOUT_MS,
    "图片生成",
  );
  const body = await jsonOrThrow(response, "图片生成", "imagegen_failed");
  const data = (body.data ?? []) as Record<string, unknown>[];
  const images = data
    .map((item) => ({
      ...(typeof item.url === "string" ? { url: item.url } : {}),
      ...(typeof item.b64_json === "string"
        ? { dataBase64: item.b64_json, mimeType: "image/png" }
        : {}),
    }))
    .filter((ref) => ref.url || ref.dataBase64);
  if (images.length === 0) {
    // 火山方舟组图里单张失败（多为内容审核）是 200 + data[i].error，不进顶层 error，
    // 全灭时把第一条带出来，否则只剩一句"没有图片"没法排查
    const itemError = data.find((item) => item.error)?.error as
      | { code?: string; message?: string }
      | undefined;
    throw new ChatServiceError(
      itemError
        ? `图片生成失败（${itemError.code ?? "unknown"}）：${itemError.message ?? ""}`
        : "图片生成响应中没有图片",
      502,
      "imagegen_no_images",
    );
  }
  return images;
}

/** Google 官方 Gemini 图像生成（generateContent，一次一张） */
export async function generateImageGoogle(
  model: string,
  input: Pick<ImageGenerateInput, "prompt" | "canvas">,
  options: ImageGenOptions,
): Promise<GeneratedImageRef> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchWithTimeout(
    fetchFn,
    `${GOOGLE_BASE}/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": options.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          responseFormat: {
            image: { aspectRatio: ASPECT_RATIO_BY_CANVAS[input.canvas] },
          },
        },
      }),
    },
    IMAGE_REQUEST_TIMEOUT_MS,
    "Gemini 图片生成",
  );
  const body = await jsonOrThrow(response, "Gemini 图片生成", "imagegen_failed");
  const candidates = body.candidates as
    | { content?: { parts?: Record<string, unknown>[] } }[]
    | undefined;
  for (const part of candidates?.[0]?.content?.parts ?? []) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline && typeof inline === "object") {
      const record = inline as Record<string, unknown>;
      if (typeof record.data === "string") {
        return {
          dataBase64: record.data,
          mimeType:
            typeof record.mimeType === "string"
              ? record.mimeType
              : typeof record.mime_type === "string"
                ? record.mime_type
                : "image/png",
        };
      }
    }
  }
  throw new ChatServiceError("Gemini 响应中没有图片", 502, "imagegen_no_images");
}

/** OpenRouter：chat completions + modalities，图片以 data URL 返回（一次一张） */
export async function generateImageOpenRouter(
  model: string,
  input: Pick<ImageGenerateInput, "prompt" | "canvas">,
  options: ImageGenOptions,
): Promise<GeneratedImageRef> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchWithTimeout(
    fetchFn,
    `${OPENROUTER_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: input.prompt }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: ASPECT_RATIO_BY_CANVAS[input.canvas] },
      }),
    },
    IMAGE_REQUEST_TIMEOUT_MS,
    "OpenRouter 图片生成",
  );
  const body = await jsonOrThrow(response, "OpenRouter 图片生成", "imagegen_failed");
  const choices = body.choices as
    | { message?: { images?: { image_url?: { url?: string } }[] } }[]
    | undefined;
  for (const image of choices?.[0]?.message?.images ?? []) {
    const url = image.image_url?.url;
    if (typeof url !== "string") continue;
    const dataUri = RESPONSE_DATA_URL_RE.exec(url);
    if (dataUri) {
      return { dataBase64: dataUri[2]!, mimeType: dataUri[1]! };
    }
    return { url };
  }
  throw new ChatServiceError("OpenRouter 响应中没有图片", 502, "imagegen_no_images");
}

/**
 * 图生 3D 用的文生图模型 × 渠道注册表。一个模型条目声明各渠道的端点/模型 id，
 * 按用户已激活 key 选路；Seedream 仅声明火山方舟渠道。
 * 端点 id 经各家文档/模型页核实（2026-07）。
 */
export interface ImageChannelEntry {
  /** 对应渠道的模型 id */
  model: string;
  /** 火山 Seedream 5.0 Pro 每次只返回一张，count > 1 时逐次请求。 */
  volcengineSingleImage?: boolean;
}

export const IMAGE_GENERATE_MODELS = {
  seedream: {
    channels: {
      volcengine: { model: "doubao-seedream-4-5-251128" },
    } as Partial<Record<ImageChannel, ImageChannelEntry>>,
  },
  "seedream-5": {
    channels: {
      volcengine: { model: "doubao-seedream-5-0-260128" },
    } as Partial<Record<ImageChannel, ImageChannelEntry>>,
  },
  "seedream-5-pro": {
    channels: {
      volcengine: { model: "doubao-seedream-5-0-pro-260628", volcengineSingleImage: true },
    } as Partial<Record<ImageChannel, ImageChannelEntry>>,
  },
  "nano-banana": {
    channels: {
      google: { model: "gemini-3.1-flash-image" },
      openrouter: { model: "google/gemini-3.1-flash-image-preview" },
    } as Partial<Record<ImageChannel, ImageChannelEntry>>,
  },
  "gpt-image-2": {
    channels: {
      openai: { model: "gpt-image-2" },
    } as Partial<Record<ImageChannel, ImageChannelEntry>>,
  },
} as const;
export type ImageGenerateModel = keyof typeof IMAGE_GENERATE_MODELS;
export const IMAGE_GENERATE_MODEL_IDS = Object.keys(IMAGE_GENERATE_MODELS) as [
  ImageGenerateModel,
  ...ImageGenerateModel[],
];

export function routeImageGenerateChannel(
  model: ImageGenerateModel,
  keys: ImageProviderKeys,
  preferred?: ImageChannel,
): { channel: ImageChannel; entry: ImageChannelEntry; apiKey: string } {
  return selectImageChannel(model, IMAGE_GENERATE_MODELS[model].channels, keys, preferred);
}

interface ImageDispatchOptions {
  fetchFn?: typeof fetch;
}

/** 按渠道分发文生图调用，归一化为图片引用。 */
export async function runImageGenerate(
  channel: ImageChannel,
  entry: ImageChannelEntry,
  input: ImageGenerateInput,
  apiKey: string,
  options: ImageDispatchOptions = {},
): Promise<{ refs: GeneratedImageRef[] }> {
  const callOptions = { apiKey, fetchFn: options.fetchFn };
  if (channel === "openai" || channel === "volcengine") {
    const baseUrl =
      channel === "openai"
        ? "https://api.openai.com/v1"
        : "https://ark.cn-beijing.volces.com/api/v3";
    if (channel === "volcengine" && entry.volcengineSingleImage && input.count > 1) {
      const refs: GeneratedImageRef[] = [];
      for (let i = 0; i < input.count; i++) {
        refs.push(
          ...(await generateImagesOpenAICompat(
            baseUrl,
            entry.model,
            { ...input, count: 1 },
            callOptions,
            channel,
          )),
        );
      }
      return { refs };
    }
    return {
      refs: await generateImagesOpenAICompat(
        baseUrl,
        entry.model,
        input,
        callOptions,
        channel,
      ),
    };
  }
  // google / openrouter(chat completions)：一次一张，按 count 串行
  const refs: GeneratedImageRef[] = [];
  for (let i = 0; i < input.count; i++) {
    refs.push(
      channel === "google"
        ? await generateImageGoogle(entry.model, input, callOptions)
        : await generateImageOpenRouter(entry.model, input, callOptions),
    );
  }
  return { refs };
}

// ---------- 图片编辑（img2img） ----------

export interface ImageEditChannelEntry {
  model: string;
}

export const IMAGE_EDIT_MODELS = {
  seedream: {
    channels: {
      volcengine: { model: "doubao-seedream-4-5-251128" },
    } as Partial<Record<ImageChannel, ImageEditChannelEntry>>,
  },
  "seedream-5": {
    channels: {
      volcengine: { model: "doubao-seedream-5-0-260128" },
    } as Partial<Record<ImageChannel, ImageEditChannelEntry>>,
  },
  "seedream-5-pro": {
    channels: {
      volcengine: { model: "doubao-seedream-5-0-pro-260628" },
    } as Partial<Record<ImageChannel, ImageEditChannelEntry>>,
  },
  "nano-banana": {
    channels: {
      google: { model: "gemini-3.1-flash-image" },
      openrouter: { model: "google/gemini-3.1-flash-image-preview" },
    } as Partial<Record<ImageChannel, ImageEditChannelEntry>>,
  },
} as const;
export type ImageEditModel = keyof typeof IMAGE_EDIT_MODELS;
export const IMAGE_EDIT_MODEL_IDS = Object.keys(IMAGE_EDIT_MODELS) as [
  ImageEditModel,
  ...ImageEditModel[],
];

export function routeImageEditChannel(
  model: ImageEditModel,
  keys: ImageProviderKeys,
  preferred?: ImageChannel,
): { channel: ImageChannel; entry: ImageEditChannelEntry; apiKey: string } {
  return selectImageChannel(model, IMAGE_EDIT_MODELS[model].channels, keys, preferred);
}

export interface ImageEditInput {
  prompt: string;
  /** 输入图（data URI），至少一张 */
  images: string[];
  /** 火山方舟专用：显式输出尺寸（档位或精确 `宽x高`），语义同 `ImageGenerateInput.size` */
  size?: string;
}

/** Gemini generateContent：文本 part + 每张输入图一个 inlineData part（编辑=多模态输入） */
async function editImageGoogle(
  model: string,
  input: ImageEditInput,
  options: ImageGenOptions,
): Promise<GeneratedImageRef> {
  const fetchFn = options.fetchFn ?? fetch;
  const parts: Record<string, unknown>[] = [{ text: input.prompt }];
  for (const image of input.images) {
    const { mimeType, base64 } = parseDataUri(image);
    parts.push({ inlineData: { mimeType, data: base64 } });
  }
  const response = await fetchWithTimeout(
    fetchFn,
    `${GOOGLE_BASE}/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": options.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    },
    IMAGE_REQUEST_TIMEOUT_MS,
    "Gemini 图片编辑",
  );
  const body = await jsonOrThrow(response, "Gemini 图片编辑", "imageedit_failed");
  const candidates = body.candidates as
    | { content?: { parts?: Record<string, unknown>[] } }[]
    | undefined;
  for (const part of candidates?.[0]?.content?.parts ?? []) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline && typeof inline === "object") {
      const record = inline as Record<string, unknown>;
      if (typeof record.data === "string") {
        return {
          dataBase64: record.data,
          mimeType:
            typeof record.mimeType === "string"
              ? record.mimeType
              : typeof record.mime_type === "string"
                ? record.mime_type
                : "image/png",
        };
      }
    }
  }
  throw new ChatServiceError("Gemini 响应中没有图片", 502, "imageedit_no_images");
}

/** OpenRouter chat completions：message content 里文本 part + 每张输入图一个 image_url part */
async function editImageOpenRouter(
  model: string,
  input: ImageEditInput,
  options: ImageGenOptions,
): Promise<GeneratedImageRef> {
  const fetchFn = options.fetchFn ?? fetch;
  const content = [
    { type: "text", text: input.prompt },
    ...input.images.map((image) => ({ type: "image_url", image_url: { url: image } })),
  ];
  const response = await fetchWithTimeout(
    fetchFn,
    `${OPENROUTER_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
      }),
    },
    IMAGE_REQUEST_TIMEOUT_MS,
    "OpenRouter 图片编辑",
  );
  const body = await jsonOrThrow(response, "OpenRouter 图片编辑", "imageedit_failed");
  const choices = body.choices as
    | { message?: { images?: { image_url?: { url?: string } }[] } }[]
    | undefined;
  for (const image of choices?.[0]?.message?.images ?? []) {
    const url = image.image_url?.url;
    if (typeof url !== "string") continue;
    const dataUri = RESPONSE_DATA_URL_RE.exec(url);
    if (dataUri) return { dataBase64: dataUri[2]!, mimeType: dataUri[1]! };
    return { url };
  }
  throw new ChatServiceError("OpenRouter 响应中没有图片", 502, "imageedit_no_images");
}

interface ImageEditDispatchOptions {
  fetchFn?: typeof fetch;
}

/** 按渠道分发图片编辑调用，归一化为图片引用。 */
export async function runImageEdit(
  channel: ImageChannel,
  entry: ImageEditChannelEntry,
  input: ImageEditInput,
  apiKey: string,
  options: ImageEditDispatchOptions = {},
): Promise<{ refs: GeneratedImageRef[] }> {
  const callOptions = { apiKey, fetchFn: options.fetchFn };
  if (channel === "volcengine") {
    return {
      refs: await generateImagesOpenAICompat(
        "https://ark.cn-beijing.volces.com/api/v3",
        entry.model,
        {
          prompt: input.prompt,
          count: 1,
          canvas: "landscape",
          images: input.images,
          ...(input.size ? { size: input.size } : {}),
        },
        callOptions,
        "volcengine",
      ),
    };
  }
  if (channel === "google") {
    return { refs: [await editImageGoogle(entry.model, input, callOptions)] };
  }
  if (channel === "openrouter") {
    return { refs: [await editImageOpenRouter(entry.model, input, callOptions)] };
  }
  throw new ChatServiceError(
    `图片编辑暂不支持渠道「${channel}」`,
    400,
    "imageedit_channel_unsupported",
  );
}
