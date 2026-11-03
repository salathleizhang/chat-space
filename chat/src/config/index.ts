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
  CHAT_PORT: z.coerce.number().int().positive().max(65535).optional(),
  PORT: z.coerce.number().int().positive().max(65535).optional(),
  CHAT_HOST: z.string().min(1).default("127.0.0.1"),
  CHATSPACE_LIBRARY_DIR: z.string().min(1).optional(),
  CHATSPACE_WEB_ORIGINS: z.string().optional(),
  VOLC_KEY: z.string().min(1).optional(),
  TRIPO_KEY: z.string().min(1).optional(),
  HUNYUAN_KEY: z.string().min(1).optional(),
  TRIPO_IMAGE_MODEL: z.string().min(1).default(DEFAULT_TRIPO_IMAGE_MODEL),
  // 绑定/动画/分件目前整体关闭：Tripo 积分用尽，且没有可替代的本地实现。
  // 打开只影响"工具是否注册"，不改变代码路径（TRIPO_RIGGING=1 即可恢复）。
  TRIPO_RIGGING: z.enum(["0", "1"]).default("0"),
  TRIPO_SEGMENT: z.enum(["0", "1"]).default("0"),
  // 完整场景（SceneJob）的模型节点仍走 Tripo：积分用尽后整条链路不可用，
  // 默认关闭以免先花钱生成参考图再在模型节点上失败。SCENE_JOB=1 恢复。
  SCENE_JOB: z.enum(["0", "1"]).default("0"),
  WORLDLABS_KEY: z.string().min(1).optional(),
  VOLC_LLM_BASE_URL: z.url().default("https://ark.cn-beijing.volces.com/api/v3"),
  VOLC_LLM_MODEL: z.string().min(1).optional(),
  VOLC_GLM_MODEL: z.string().min(1).default(GLM_FLASH_SELECTION),
  VOLC_DEEPSEEK_MODEL: z.string().min(1).default(DEEPSEEK_FLASH_SELECTION),
  VOLC_DOUBAO_EVOLVING_MODEL: z.string().min(1).default(DOUBAO_EVOLVING_SELECTION),
  VOLC_DOUBAO_PRO_MODEL: z.string().min(1).default(DOUBAO_PRO_SELECTION),
  VOLC_HYPER3D_MODEL: z.string().min(1).default("hyper3d-gen2-260112"),
  VOLC_HI3D_MODEL: z.string().min(1).default("hitem3d-2-0-251223"),
  /**
   * Blender 集成（默认**关闭**）。
   *
   * 关闭是刻意的：这 8 个工具只在真的有一个 Blender 会话时才该出现在 agent 的工具表里，
   * 否则模型会去调一个必然失败的会话检查、白费轮次。打开：`BLENDER_ENABLED=1`。
   */
  BLENDER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  /** Blender addon 的 socket 地址。本地是 127.0.0.1；云端是容器暴露出来的主机。 */
  BLENDER_HOST: z.string().min(1).optional(),
  BLENDER_PORT: z.coerce.number().int().positive().max(65535).optional(),
  /**
   * MCP server 的可执行文件与参数（空格分隔）。
   *
   * 默认 `uvx --from mcp-for-blender blender-mcp`：本机系统 Python 是 3.9 而这个包要
   * ≥3.10，`uvx` 会自己拉一个合适的 Python，于是"手动准备 Python 环境"整步消失。
   */
  BLENDER_MCP_BIN: z.string().min(1).optional(),
  BLENDER_MCP_ARGS: z.string().optional(),
  /**
   * 共享工作目录 —— **"文件怎么过去"这条缝的两端**。
   *
   * Blender 跑在容器里、chat/ 跑在宿主机时，这是两个文件系统：Blender 写进 `/workspace`，
   * 而 chat/ 看到的是挂载点 `~/ChatSpace/blender-work`。两个值一起给，中间做前缀映射。
   *
   * 两个都不给 = 同一文件系统（macOS 本地 Blender、或 Blender 与 chat/ 同机），
   * 走 `os.tmpdir()` 中转即可。
   */
  BLENDER_WORKDIR: z.string().min(1).optional(),
  CHATSPACE_BLENDER_WORKDIR: z.string().min(1).optional(),
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

/**
 * 进程内自动续跑（重启自愈，见 `services/tasks.ts`）取本机凭证的口子。
 * 与 HTTP 入口的 `withServerCredentials` 是**同一份来源**，不另存一份、也不从请求里拿。
 */
export function serverResumeKeys(): {
  tripo3dApiKey?: string;
  seed3dApiKey?: string;
  worldLabsApiKey?: string;
  hunyuanApiKey?: string;
} {
  return {
    ...(serverKeys.tripo3dApiKey ? { tripo3dApiKey: serverKeys.tripo3dApiKey } : {}),
    ...(serverKeys.seed3dApiKey ? { seed3dApiKey: serverKeys.seed3dApiKey } : {}),
    ...(serverKeys.worldLabsApiKey ? { worldLabsApiKey: serverKeys.worldLabsApiKey } : {}),
    ...(serverKeys.hunyuanApiKey ? { hunyuanApiKey: serverKeys.hunyuanApiKey } : {}),
  };
}

export const config = {
  port: env.CHAT_PORT ?? env.PORT ?? 3901,
  host: env.CHAT_HOST,
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
  sceneJob: env.SCENE_JOB === "1",
  tripo: {
    imageModel: env.TRIPO_IMAGE_MODEL,
    /** 绑骨 / 动画 / 角色（image→3D+绑骨）是否注册给 Agent */
    rigging: env.TRIPO_RIGGING === "1",
    /** 语义分件（/mesh/segment）是否注册给 Agent */
    segment: env.TRIPO_SEGMENT === "1",
  },
  /**
   * 本机 Blender 的 addon 地址。火山沙箱另外使用 blenderCloud.ts 的 HTTPS
   * 实例路由与后端凭据；不能把 HTTP 网关域名当成原始 TCP 主机。
   */
  blender: {
    enabled: process.env.VERCEL !== "1" && env.BLENDER_ENABLED === true,
    cloudService: false,
    host: env.BLENDER_HOST ?? "127.0.0.1",
    port: env.BLENDER_PORT ?? 9876,
    bin: env.BLENDER_MCP_BIN ?? "uvx",
    args: env.BLENDER_MCP_ARGS
      ? env.BLENDER_MCP_ARGS.split(" ").filter(Boolean)
      : // 注意：可执行文件与包同名，都是 `mcp-for-blender`。改名前叫 `blender-mcp`，
        // 用旧名字会得到 `An executable named 'blender-mcp' is not provided by package
        // 'mcp-for-blender'`——本条由 blenderOps.test.ts 钉住。
        ["mcp-for-blender"],
    /**
     * 共享工作目录的两端。`workDir` 是 **Blender 看到的**路径，
     * `localWorkDir` 是 **chat/ 看到的**同一个目录。见 EnvSchema 里的说明。
     */
    workDir: env.BLENDER_WORKDIR ?? null,
    localWorkDir: env.CHATSPACE_BLENDER_WORKDIR ?? null,
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
