import { ChatServiceError } from "../common/errors";
import {
  API_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  readBodyWithTimeout,
} from "../common/http";
import { pollProviderTask } from "../common/polling";

/**
 * 火山方舟 Seed3D 图生 3D 客户端（ark.cn-beijing.volces.com/api/v3，Bearer）。
 *
 * **提交侧经官方文档逐字核实 2026-07**：`POST /contents/generations/tasks`，
 * body 是 `{model, content:[{type:"image_url",image_url:{url}}, {type:"text",text}]}`，
 * 图片收公网 URL 或 `data:image/<fmt>;base64,<...>`；输出规格不走结构化字段而是
 * 塞在 text 里的**命令行式开关**（`--subdivisionlevel high|medium|low`、
 * `--fileformat glb|obj|usd|usdz`），这是 Seed3D 独有的形状，别照别家改。
 * 响应 `{id}` 是任务 id。
 *
 * **查询侧未逐字核实**：官方只写明"通过查询 3D 生成任务 API 拿状态，成功后输出
 * `file_url`"，那篇文档正文没拿到。故按 ark 任务型接口的通行形状实现
 * （`GET /contents/generations/tasks/{id}`，状态字段 `status`），并且**不依赖
 * 具体嵌套层级**：`extractSeed3dFileUrls` 递归全扫，先认任何叫 `file_url` 的键
 * （文档点名的字段，不管埋多深），再退到按扩展名认 URL 兜底——真实形状以
 * `bun run smoke` 验证为准。同目录 tripo.ts / hunyuan.ts / blockadelabs.ts
 * 头注同款先例。
 */

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/** 文档点名的旗舰图生 3D 模型（doubao-seed3d，2026-07） */
export const SEED3D_MODEL = "doubao-seed3d-2-0-260328";

export type Seed3dSubdivisionLevel = "high" | "medium" | "low";
export type Seed3dFileFormat = "glb" | "obj" | "usd" | "usdz";

export interface Seed3dCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 单次查询的超时预算（默认 API_REQUEST_TIMEOUT_MS） */
  requestTimeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

export interface Seed3dSubmitParams {
  /** 图片公网 URL 或 data URI（本地资产走后者，免上传基础设施） */
  image: string;
  model?: string;
  subdivisionLevel?: Seed3dSubdivisionLevel;
  fileFormat?: Seed3dFileFormat;
}

async function callArk(
  path: string,
  init: RequestInit,
  options: Seed3dCallOptions,
  /** 轮询时传入任务级 signal 与更细的标签，让总预算能真的打断请求 */
  override: { signal?: AbortSignal; requestTimeoutMs?: number; label?: string } = {},
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  const label = override.label ?? "Seed3D";
  const requestTimeoutMs =
    override.requestTimeoutMs ?? options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS;
  const response = await fetchWithTimeout(
    fetchFn,
    `${ARK_BASE}${path}`,
    {
      ...init,
      ...(override.signal ? { signal: override.signal } : {}),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    requestTimeoutMs,
    label,
  );
  const body = await readBodyWithTimeout(
    () => response.json().catch(() => ({})) as Promise<Record<string, unknown>>,
    requestTimeoutMs,
    label,
  );
  if (!response.ok) {
    throw new ChatServiceError(
      `Seed3D 请求失败（${response.status}）：${JSON.stringify(body).slice(0, 300)}`,
      502,
      "seed3d_request_failed",
    );
  }
  return body;
}

/**
 * 把输出规格拼成 Seed3D 的文本命令。留空则整条 text 部件不发——文档说这部分
 * 选填，缺省 `medium` + `glb`，没必要替它写默认值。
 */
export function composeSeed3dCommand(params: Seed3dSubmitParams): string {
  const flags: string[] = [];
  if (params.subdivisionLevel) flags.push(`--subdivisionlevel ${params.subdivisionLevel}`);
  if (params.fileFormat) flags.push(`--fileformat ${params.fileFormat}`);
  return flags.join(" ");
}

/** 提交图生 3D 任务，返回任务 id（异步接口，产物要轮询） */
export async function submitSeed3dTask(
  params: Seed3dSubmitParams,
  options: Seed3dCallOptions,
): Promise<string> {
  const command = composeSeed3dCommand(params);
  const body = await callArk(
    "/contents/generations/tasks",
    {
      method: "POST",
      body: JSON.stringify({
        model: params.model ?? SEED3D_MODEL,
        content: [
          { type: "image_url", image_url: { url: params.image } },
          ...(command ? [{ type: "text", text: command }] : []),
        ],
      }),
    },
    options,
  );
  const id = body.id;
  if (typeof id !== "string" || !id) {
    throw new ChatServiceError("Seed3D 提交响应缺少任务 id", 502, "seed3d_request_failed");
  }
  return id;
}

/** 查一次任务（续跑只用这个，不重新提交） */
export async function pollSeed3dTask(
  taskId: string,
  options: Seed3dCallOptions,
  override: { signal?: AbortSignal; requestTimeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return callArk(
    `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    {},
    options,
    { label: "Seed3D 任务查询", ...override },
  );
}

const TERMINAL_FAIL = new Set(["failed", "cancelled", "canceled", "expired"]);
const TERMINAL_OK = new Set(["succeeded", "success", "done", "completed"]);

/** 轮询直至成功，返回查询响应（含产物 URL） */
export async function waitForSeed3dTask(
  taskId: string,
  options: Seed3dCallOptions,
): Promise<Record<string, unknown>> {
  const timeoutError = () =>
    new ChatServiceError(
      `Seed3D 任务超时（id=${taskId}，可凭侧写续查）`,
      504,
      "seed3d_timeout",
    );

  return pollProviderTask<Record<string, unknown>>({
    label: "Seed3D 任务查询",
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 10_000,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    timeoutError,
    attempt: (signal, requestTimeoutMs) =>
      pollSeed3dTask(taskId, options, { signal, requestTimeoutMs }),
    statusOf: (result) => String(result.status ?? "").toLowerCase(),
    isDone: (result) => TERMINAL_OK.has(String(result.status ?? "").toLowerCase()),
    failureOf: (result) => {
      const status = String(result.status ?? "").toLowerCase();
      if (!TERMINAL_FAIL.has(status)) return undefined;
      const error = result.error as { message?: string } | undefined;
      return new ChatServiceError(
        `Seed3D 任务失败：${error?.message ?? status}`,
        502,
        "seed3d_task_failed",
      );
    },
  });
}

/** Seed3D 输出 URL 的文件扩展名白名单。 */
const SEED3D_FILE_URL_RE = /\.(glb|obj|usdz?|zip|png|jpe?g|webp)(\?|$)/i;

/**
 * 递归找产物 URL，两道：①任何叫 `file_url` 的键（文档点名的字段，不管埋多深、
 * 也不管带不带扩展名——TOS 签名链接常常没有）；②按扩展名认的 URL 兜底。
 * 两道都走是因为查询响应的确切层级没核实，只认一处会在 smoke 时才发现踩空。
 */
export function extractSeed3dFileUrls(value: unknown, key = "", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) extractSeed3dFileUrls(item, key, found);
  } else if (value && typeof value === "object") {
    for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
      extractSeed3dFileUrls(nested, nestedKey, found);
    }
  } else if (typeof value === "string" && /^https?:\/\//.test(value)) {
    const named = key === "file_url" || key.endsWith("_file_url");
    if ((named || SEED3D_FILE_URL_RE.test(value)) && !found.includes(value)) {
      found.push(value);
    }
  }
  return found;
}
