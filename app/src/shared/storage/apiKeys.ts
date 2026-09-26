/** 模型与生成偏好保存在浏览器；供应商密钥只保存在本机 chat 服务。 */
export const LLM_PROVIDER_IDS = ["volcengine"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

const LLM_SETTINGS_KEY = "chatspace.llmSettings:v1";
/** 只读的旧键：老版本存的是渠道名，现在存具体模型，加载时迁移一次。 */
const LEGACY_THREE_D_PROVIDER_KEY = "chatspace.threeDProviderSettings:v1";
const THREE_D_MODEL_SETTINGS_KEY = "chatspace.threeDModelSettings:v1";
const IMAGE_SETTINGS_KEY = "chatspace.imageGenerateModelSettings:v1";

function readObject(key: string): Record<string, unknown> | null {
  try {
    const legacyKey = key.replace(/^chatspace\./, "gabo.");
    const current = localStorage.getItem(key);
    const raw = current ?? localStorage.getItem(legacyKey);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (current === null && writeObject(key, value)) localStorage.removeItem(legacyKey);
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeObject(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 清理旧版本留在浏览器中的密钥；新版不会再读取或发送这些值。 */
export function clearLegacyApiKeys(): void {
  try {
    localStorage.removeItem("gabo.apiKeys");
    localStorage.removeItem("gabo.apiKeys:v1");
    localStorage.removeItem("chatspace.apiKeys");
    localStorage.removeItem("chatspace.apiKeys:v1");
  } catch {
    // 禁用 localStorage 时无需影响页面启动。
  }
}

export interface LlmSettings {
  provider: LlmProviderId | "";
  baseUrl: string;
  model: string;
}

export interface LlmModelPreset {
  value: string;
  label: string;
  provider?: LlmProviderId;
  baseUrl?: string;
}

export const LLM_MODEL_PRESETS: LlmModelPreset[] = [
  { value: "", label: "Auto", baseUrl: "" },
  { value: "glm-5-3-flash-260828", label: "GLM 5.3 Flash", provider: "volcengine" },
  { value: "deepseek-v4-1-flash-260910", label: "DeepSeek V4.1 Flash", provider: "volcengine" },
  { value: "doubao-seed-evolving", label: "Doubao-Seed-Evolving", provider: "volcengine" },
  { value: "doubao-seed-2-1-pro-260915", label: "Doubao-Seed-2.1-pro", provider: "volcengine" },
];

function savedLlmModel(model: unknown): string {
  if (model === "glm-5.3") return "glm-5-3-flash-260828";
  return LLM_MODEL_PRESETS.some((preset) => preset.provider && preset.value === model)
    ? model as string
    : "";
}

export function loadLlmSettings(): LlmSettings {
  const saved = readObject(LLM_SETTINGS_KEY);
  const model = savedLlmModel(saved?.model);
  return { provider: model ? "volcengine" : "", baseUrl: "", model };
}

export function saveLlmSettings(settings: LlmSettings): boolean {
  const model = savedLlmModel(settings.model);
  return writeObject(LLM_SETTINGS_KEY, {
    provider: model ? "volcengine" : "",
    baseUrl: "",
    model,
  });
}

export interface ThreeDModelSettings { model: string }

/** 下拉列出的是具体模型，不是渠道；值与 chat/src/models/threeD.ts 的选择键逐字对应。 */
export const THREE_D_MODEL_PRESETS = [
  { value: "", label: "Auto" },
  { value: "seed3d-2", label: "Seed3D 2.0" },
  { value: "hyper3d-gen2", label: "Hyper3D Gen-2" },
  { value: "hi3d-2", label: "Hi3D 2.0" },
  { value: "tripo-3-1", label: "Tripo 3.1" },
];

/** 旧版渠道偏好 → 该渠道的默认模型，迁移时保住用户原来的选择。 */
const LEGACY_PROVIDER_MODELS: Record<string, string> = {
  "seed3d-direct": "seed3d-2",
  "hyper3d-volc": "hyper3d-gen2",
  "hi3d-volc": "hi3d-2",
  "tripo-direct": "tripo-3-1",
};

function savedThreeDModel(model: unknown): string {
  return THREE_D_MODEL_PRESETS.some((preset) => preset.value && preset.value === model)
    ? model as string
    : "";
}

export function loadThreeDModelSettings(): ThreeDModelSettings {
  const saved = readObject(THREE_D_MODEL_SETTINGS_KEY);
  if (saved) return { model: savedThreeDModel(saved.model) };
  const legacy = readObject(LEGACY_THREE_D_PROVIDER_KEY)?.provider;
  return {
    model: savedThreeDModel(
      typeof legacy === "string" ? LEGACY_PROVIDER_MODELS[legacy] ?? "" : "",
    ),
  };
}

export function saveThreeDModelSettings(settings: ThreeDModelSettings): boolean {
  return writeObject(THREE_D_MODEL_SETTINGS_KEY, { model: savedThreeDModel(settings.model) });
}

export interface ImageGenerateModelSettings { model: string }

export const IMAGE_GENERATE_MODEL_PRESETS = [
  { value: "", label: "Auto" },
  { value: "seedream", label: "Seedream 4.5" },
  { value: "seedream-5", label: "Seedream 5.0" },
  { value: "seedream-5-pro", label: "Seedream 5.0 Pro" },
];

export function loadImageGenerateModelSettings(): ImageGenerateModelSettings {
  const saved = readObject(IMAGE_SETTINGS_KEY);
  const model = saved?.model;
  return {
    model:
      typeof model === "string" &&
      IMAGE_GENERATE_MODEL_PRESETS.some((preset) => preset.value && preset.value === model)
        ? model
        : "",
  };
}

export function saveImageGenerateModelSettings(settings: ImageGenerateModelSettings): boolean {
  return writeObject(IMAGE_SETTINGS_KEY, settings);
}
