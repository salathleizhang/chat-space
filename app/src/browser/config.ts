import { DEFAULT_TRIPO_IMAGE_MODEL } from "../../../chat/src/models/tripo";
export const LLM_PROVIDER_IDS = ["volcengine"] as const;
export const GLM_FLASH_SELECTION = "glm-5-3-flash-260828";
export const DEEPSEEK_FLASH_SELECTION = "deepseek-v4-1-flash-260910";
export const DOUBAO_EVOLVING_SELECTION = "doubao-seed-evolving";
export const DOUBAO_PRO_SELECTION = "doubao-seed-2-1-pro-260915";
export const config = {
  port: 3901, host: "browser", library: { root: "/browser" }, cors: { isAllowedOrigin: () => true },
  llm: { defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: GLM_FLASH_SELECTION,
    glmModel: GLM_FLASH_SELECTION, deepseekModel: DEEPSEEK_FLASH_SELECTION, evolvingModel: DOUBAO_EVOLVING_SELECTION, proModel: DOUBAO_PRO_SELECTION },
  ark3d: { hyper3dModel: "hyper3d-gen2-260112", hi3dModel: "hitem3d-2-0-251223" },
  tripo: { imageModel: DEFAULT_TRIPO_IMAGE_MODEL },
  blender: { enabled: false, cloudService: false, host: "", port: 0, bin: "", args: [], workDir: null, localWorkDir: null },
};
export const configuredProviders = { volcengine: false, tripo3d: false, hunyuan: false, worldlabs: false };
export const configuredEnvLlmProviders: string[] = [];
export function configureCapabilities(value: { providers: typeof configuredProviders; llmProviders: string[]; blenderCloud?: boolean }) {
  Object.assign(configuredProviders, value.providers); configuredEnvLlmProviders.push(...value.llmProviders);
  config.blender.cloudService = value.blenderCloud === true;
}
const marker = "chatspace-server-proxy";
export function serverResumeKeys(): { tripo3dApiKey?: string; seed3dApiKey?: string; worldLabsApiKey?: string; hunyuanApiKey?: string } {
  return { ...(configuredProviders.tripo3d ? { tripo3dApiKey: marker } : {}), ...(configuredProviders.volcengine ? { seed3dApiKey: marker } : {}),
    ...(configuredProviders.worldlabs ? { worldLabsApiKey: marker } : {}), ...(configuredProviders.hunyuan ? { hunyuanApiKey: marker } : {}) };
}
export function withServerCredentials(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const result = { ...body as Record<string, unknown>, ...serverResumeKeys(), ...(configuredProviders.volcengine ? { volcengineApiKey: marker } : {}) };
  if ("llm" in result) {
    const requested = result.llm as Record<string, unknown> | undefined;
    result.llm = { apiKey: marker, provider: "volcengine", baseUrl: config.llm.defaultBaseUrl,
      model: typeof requested?.model === "string" ? requested.model : config.llm.defaultModel };
  }
  return result;
}
