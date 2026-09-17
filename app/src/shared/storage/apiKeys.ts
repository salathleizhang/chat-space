/** 模型与生成偏好保存在浏览器；供应商密钥只保存在本机 chat 服务。 */
export const LLM_PROVIDER_IDS = ["volcengine"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

const LLM_SETTINGS_KEY = "chatspace.llmSettings:v1";
const THREE_D_SETTINGS_KEY = "chatspace.threeDProviderSettings:v1";
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
  { value: "", label: "自动选择 Agent 模型", baseUrl: "" },
  { value: "glm-5.3", label: "GLM-5.3", provider: "volcengine" },
  { value: "deepseek-v4-1-flash-260910", label: "DeepSeek V4.1 Flash", provider: "volcengine" },
];

function savedLlmModel(model: unknown): string {
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

export interface ThreeDProviderSettings { provider: string }

export const THREE_D_PROVIDER_PRESETS = [
  { value: "", label: "自动选择" },
  { value: "seed3d-direct", label: "Seed3D" },
  { value: "hyper3d-volc", label: "Hyper3D" },
  { value: "hi3d-volc", label: "Hi3D" },
  { value: "tripo-direct", label: "Tripo3D" },
];

export function loadThreeDProviderSettings(): ThreeDProviderSettings {
  const saved = readObject(THREE_D_SETTINGS_KEY);
  const provider = saved?.provider;
  return {
    provider: THREE_D_PROVIDER_PRESETS.some((item) => item.value === provider)
      ? provider as string
      : "",
  };
}

export function saveThreeDProviderSettings(settings: ThreeDProviderSettings): boolean {
  return writeObject(THREE_D_SETTINGS_KEY, settings);
}

export interface ImageGenerateModelSettings { model: string }

export const IMAGE_GENERATE_MODEL_PRESETS = [
  { value: "", label: "自动选择图片模型" },
  { value: "seedream", label: "Seedream 4.5" },
];

export function loadImageGenerateModelSettings(): ImageGenerateModelSettings {
  const saved = readObject(IMAGE_SETTINGS_KEY);
  return { model: saved?.model === "seedream" ? "seedream" : "" };
}

export function saveImageGenerateModelSettings(settings: ImageGenerateModelSettings): boolean {
  return writeObject(IMAGE_SETTINGS_KEY, settings);
}
