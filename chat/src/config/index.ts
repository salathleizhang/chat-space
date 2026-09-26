import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_TRIPO_IMAGE_MODEL } from "../models/tripo";

export const LLM_PROVIDER_IDS = ["volcengine"] as const;
export const GLM_FLASH_SELECTION = "glm-5-3-flash-260828";
export const DEEPSEEK_FLASH_SELECTION = "deepseek-v4-1-flash-260910";
export const DOUBAO_EVOLVING_SELECTION = "doubao-seed-evolving";
export const DOUBAO_PRO_SELECTION = "doubao-seed-2-1-pro-260915";

const EnvSchema = z.object({
  CHAT_PORT: z.coerce.number().int().positive().default(3901),
  CHATSPACE_LIBRARY_DIR: z.string().min(1).optional(),
  CHATSPACE_WEB_ORIGINS: z.string().optional(),
  VOLC_KEY: z.string().min(1).optional(),
  TRIPO_KEY: z.string().min(1).optional(),
  HUNYUAN_KEY: z.string().min(1).optional(),
  TRIPO_IMAGE_MODEL: z.string().min(1).default(DEFAULT_TRIPO_IMAGE_MODEL),
  WORLDLABS_KEY: z.string().min(1).optional(),
  VOLC_LLM_BASE_URL: z.url().default("https://ark.cn-beijing.volces.com/api/v3"),
  VOLC_LLM_MODEL: z.string().min(1).optional(),
  VOLC_GLM_MODEL: z.string().min(1).default(GLM_FLASH_SELECTION),
  VOLC_DEEPSEEK_MODEL: z.string().min(1).default(DEEPSEEK_FLASH_SELECTION),
  VOLC_DOUBAO_EVOLVING_MODEL: z.string().min(1).default(DOUBAO_EVOLVING_SELECTION),
  VOLC_DOUBAO_PRO_MODEL: z.string().min(1).default(DOUBAO_PRO_SELECTION),
  VOLC_HYPER3D_MODEL: z.string().min(1).default("hyper3d-gen2-260112"),
  VOLC_HI3D_MODEL: z.string().min(1).default("hitem3d-2-0-251223"),
});

const env = EnvSchema.parse(process.env);
const defaultLlmModel = env.VOLC_LLM_MODEL ?? env.VOLC_GLM_MODEL;

/** 工程默认保存在当前用户的 ChatSpace 目录。 */
export function defaultLibraryRoot(home = homedir()): string {
  return join(home, "ChatSpace");
}

/** 生产站点只接受完整 origin，不放行其他 pages.dev 页面。 */
export function createAllowedOriginChecker(configuredOrigins?: string) {
  const webOrigins = new Set(
    (configuredOrigins ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  return (origin: string) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) || webOrigins.has(origin);
}

const serverKeys = {
  volcengineApiKey: env.VOLC_KEY,
  seed3dApiKey: env.VOLC_KEY,
  tripo3dApiKey: env.TRIPO_KEY,
  hunyuanApiKey: env.HUNYUAN_KEY,
  worldLabsApiKey: env.WORLDLABS_KEY,
};

export const configuredProviders = {
  volcengine: Boolean(env.VOLC_KEY),
  tripo3d: Boolean(env.TRIPO_KEY),
  hunyuan: Boolean(env.HUNYUAN_KEY),
  worldlabs: Boolean(env.WORLDLABS_KEY),
} as const;
export const configuredEnvLlmProviders = env.VOLC_KEY ? ["volcengine"] : [];

export const config = {
  port: env.CHAT_PORT,
  library: { root: env.CHATSPACE_LIBRARY_DIR ?? defaultLibraryRoot() },
  cors: { isAllowedOrigin: createAllowedOriginChecker(env.CHATSPACE_WEB_ORIGINS) },
  llm: {
    defaultBaseUrl: env.VOLC_LLM_BASE_URL,
    defaultModel: defaultLlmModel,
    glmModel: env.VOLC_GLM_MODEL,
    deepseekModel: env.VOLC_DEEPSEEK_MODEL,
    evolvingModel: env.VOLC_DOUBAO_EVOLVING_MODEL,
    proModel: env.VOLC_DOUBAO_PRO_MODEL,
  },
  ark3d: {
    hyper3dModel: env.VOLC_HYPER3D_MODEL,
    hi3dModel: env.VOLC_HI3D_MODEL,
  },
  tripo: {
    imageModel: env.TRIPO_IMAGE_MODEL,
  },
} as const;

/** 浏览器只能选择已配置的模型，凭证、实际模型 ID 和端点均由本机决定。 */
export function createServerCredentialInjector(
  keys: Readonly<Record<string, string | undefined>>,
  llm: {
    baseUrl: string;
    model: string;
    glmModel: string;
    deepseekModel: string;
    evolvingModel: string;
    proModel: string;
  },
) {
  const models = new Map<string, string>([
    [GLM_FLASH_SELECTION, llm.glmModel],
    ["glm-5.3", llm.glmModel],
    [DEEPSEEK_FLASH_SELECTION, llm.deepseekModel],
    [DOUBAO_EVOLVING_SELECTION, llm.evolvingModel],
    [DOUBAO_PRO_SELECTION, llm.proModel],
  ]);
  return (body: unknown): unknown => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const merged: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(body)) {
      if (!field.endsWith("ApiKey")) merged[field] = value;
    }
    for (const [field, key] of Object.entries(keys)) {
      if (key) merged[field] = key;
    }
    if ("llm" in merged) {
      const requestedModel = merged.llm && typeof merged.llm === "object" && !Array.isArray(merged.llm)
        ? (merged.llm as Record<string, unknown>).model
        : undefined;
      merged.llm = {
        apiKey: keys.volcengineApiKey ?? "",
        provider: "volcengine",
        baseUrl: llm.baseUrl,
        model: (typeof requestedModel === "string" ? models.get(requestedModel) : undefined) ?? llm.model,
      };
    }
    return merged;
  };
}

export const withServerCredentials = createServerCredentialInjector(serverKeys, {
  baseUrl: env.VOLC_LLM_BASE_URL,
  model: defaultLlmModel,
  glmModel: env.VOLC_GLM_MODEL,
  deepseekModel: env.VOLC_DEEPSEEK_MODEL,
  evolvingModel: env.VOLC_DOUBAO_EVOLVING_MODEL,
  proModel: env.VOLC_DOUBAO_PRO_MODEL,
});
