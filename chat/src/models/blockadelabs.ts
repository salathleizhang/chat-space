import { ChatServiceError } from "../common/errors";
import { API_REQUEST_TIMEOUT_MS, fetchWithTimeout, readBodyWithTimeout } from "../common/http";
import { pollProviderTask } from "../common/polling";

/**
 * Blockade Labs Skybox 客户端（api-documentation.blockadelabs.com 核实 2026-07）。
 * 两段式：先 /skybox 生成全景图，再 /skybox/export 用 type_id 转出目标格式（HDR=4/EXR=5）。
 * BYOK：key 是调用参数；fetch 可注入以便测试。认证头是裸 key，不是 Bearer。
 */

const ENDPOINT = "https://backend.blockadelabs.com/api/v1";

/** 导出类型 id（官方文档表）：2=png 4=hdri-hdr 5=hdri-exr 6=depth-map 10=cube-map 11=glb */
export const EXPORT_TYPE_HDR = 4;

export interface BlockadeLabsOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 单次轮询的超时预算（默认 API_REQUEST_TIMEOUT_MS） */
  requestTimeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

export interface SkyboxGenerateParams {
  prompt: string;
  /** Blockade Labs 风格模型 id（skybox_style_id），缺省用其平台默认写实风格 */
  styleId?: number;
  negativeText?: string;
  enhancePrompt?: boolean;
  seed?: number;
}

interface SkyboxRequestBody {
  id?: number;
  obfuscated_id?: string;
  status?: string;
  file_url?: string;
  error_message?: string;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: apiKey, "Content-Type": "application/json" };
}

function isTerminal(status: string | undefined): boolean {
  return status === "complete" || status === "abort" || status === "error";
}

async function pollUntilDone(
  fetchFn: typeof fetch,
  url: string,
  apiKey: string,
  options: BlockadeLabsOptions,
  errorPrefix: string,
): Promise<SkyboxRequestBody> {
  const timeoutError = () =>
    new ChatServiceError(`${errorPrefix} timed out`, 504, "blockadelabs_timeout");

  return pollProviderTask<SkyboxRequestBody>({
    label: errorPrefix,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    timeoutError,
    attempt: async (signal, requestTimeoutMs) => {
      const response = await fetchWithTimeout(
        fetchFn,
        url,
        { headers: headers(apiKey), signal },
        requestTimeoutMs,
        errorPrefix,
      );
      const body = await readBodyWithTimeout(
        () => response.json().catch(() => ({})) as Promise<SkyboxRequestBody>,
        requestTimeoutMs,
        errorPrefix,
      );
      if (!response.ok) {
        throw new ChatServiceError(
          `${errorPrefix} poll failed (${response.status})`,
          502,
          "blockadelabs_poll_failed",
        );
      }
      return body;
    },
    statusOf: (body) => body.status ?? "unknown",
    // 终态（complete/abort/error）都算「不用再等」；失败在 failureOf 里给说法。
    isDone: (body) => body.status === "complete" && Boolean(body.file_url),
    failureOf: (body) => {
      if (!isTerminal(body.status)) return undefined;
      if (body.status !== "complete") {
        return new ChatServiceError(
          `${errorPrefix} failed: ${body.error_message ?? body.status}`,
          502,
          "blockadelabs_generation_failed",
        );
      }
      return new ChatServiceError(
        `${errorPrefix} finished without a file_url`,
        502,
        "blockadelabs_bad_response",
      );
    },
  });
}

/** 提交生成请求，立即返回续跑所需的 id（不轮询）；供调用方在崩溃窗口前落盘侧写。 */
export async function submitSkybox(
  params: SkyboxGenerateParams,
  options: BlockadeLabsOptions,
): Promise<{ obfuscatedId: string; requestId: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const submitResponse = await fetchWithTimeout(
    fetchFn,
    `${ENDPOINT}/skybox`,
    {
      method: "POST",
      headers: headers(options.apiKey),
      body: JSON.stringify({
        prompt: params.prompt,
        ...(params.styleId !== undefined ? { skybox_style_id: params.styleId } : {}),
        ...(params.negativeText ? { negative_text: params.negativeText } : {}),
        ...(params.enhancePrompt !== undefined ? { enhance_prompt: params.enhancePrompt } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
      }),
    },
    API_REQUEST_TIMEOUT_MS,
    "Blockade Labs submission",
  );
  const submitBody = (await submitResponse.json().catch(() => ({}))) as SkyboxRequestBody;
  if (!submitResponse.ok) {
    throw new ChatServiceError(
      `Blockade Labs submission failed (${submitResponse.status})`,
      502,
      "blockadelabs_submit_failed",
    );
  }
  const id = submitBody.id;
  const obfuscatedId = submitBody.obfuscated_id;
  if (id === undefined || !obfuscatedId) {
    throw new ChatServiceError(
      "Blockade Labs response is missing id/obfuscated_id",
      502,
      "blockadelabs_bad_response",
    );
  }
  // 轮询用的 {id} 官方文档写的是"生成请求的 id"，这里按数字 id 拼接——
  // 与 obfuscated_id（导出阶段用）是两个不同字段，未逐字核实前先按文档字面理解，
  // 真实形状以 smoke 验证为准（同目录 tripo.ts/hunyuan.ts 头注同款先例）。
  return { obfuscatedId, requestId: String(id) };
}

/** 仅轮询已提交的生成请求（侧写续跑用，不重新提交），入参是数字 id（非 obfuscated_id） */
export async function pollSkyboxGenerate(
  requestId: string,
  options: BlockadeLabsOptions,
): Promise<{ fileUrl: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const result = await pollUntilDone(
    fetchFn,
    `${ENDPOINT}/imagine/requests/${requestId}`,
    options.apiKey,
    options,
    "Blockade Labs generation",
  );
  return { fileUrl: result.file_url! };
}

/** 提交导出请求，立即返回 exportId（不轮询）；供调用方在崩溃窗口前落盘侧写。 */
export async function submitSkyboxExport(
  obfuscatedId: string,
  options: BlockadeLabsOptions,
): Promise<{ exportId: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const submitResponse = await fetchWithTimeout(
    fetchFn,
    `${ENDPOINT}/skybox/export`,
    {
      method: "POST",
      headers: headers(options.apiKey),
      body: JSON.stringify({ skybox_id: obfuscatedId, type_id: EXPORT_TYPE_HDR }),
    },
    API_REQUEST_TIMEOUT_MS,
    "Blockade Labs export submission",
  );
  const submitBody = (await submitResponse.json().catch(() => ({}))) as SkyboxRequestBody;
  if (!submitResponse.ok) {
    throw new ChatServiceError(
      `Blockade Labs export submission failed (${submitResponse.status})`,
      502,
      "blockadelabs_export_submit_failed",
    );
  }
  const exportId = submitBody.id !== undefined ? String(submitBody.id) : submitBody.obfuscated_id;
  if (!exportId) {
    throw new ChatServiceError(
      "Blockade Labs export response is missing id",
      502,
      "blockadelabs_bad_response",
    );
  }
  return { exportId };
}

/** 仅轮询已提交的导出请求（侧写续跑用，不重新提交） */
export async function pollSkyboxExport(
  exportId: string,
  options: BlockadeLabsOptions,
): Promise<{ fileUrl: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const result = await pollUntilDone(
    fetchFn,
    `${ENDPOINT}/skybox/export/${exportId}`,
    options.apiKey,
    options,
    "Blockade Labs export",
  );
  return { fileUrl: result.file_url! };
}
