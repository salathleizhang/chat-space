import { ChatServiceError } from "../common/errors";
import {
  API_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  isRetryableNetworkError,
  sleep,
} from "../common/http";

/**
 * World Labs Marble 客户端（对应上游 generate-world.mjs）。
 * BYOK：key 是调用参数；fetch 可注入以便测试。
 */

const ENDPOINT = "https://api.worldlabs.ai/marble/v1";
export const MARBLE_MODEL = "marble-1.1";

export interface WorldLabsOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 单次轮询的超时预算（默认 API_REQUEST_TIMEOUT_MS） */
  requestTimeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

export interface MarbleImagePrompt {
  dataBase64: string;
  extension: string;
  mimeType: string;
}

export interface MarbleGenerateParams {
  displayName: string;
  imagePrompt?: MarbleImagePrompt;
  textPrompt?: string;
}

interface MarbleOperation {
  operation_id?: string;
  id?: string;
  name?: string;
  done?: boolean;
  error?: unknown;
  response?: MarbleWorldResponse;
}

export interface MarbleWorldResponse {
  assets?: {
    mesh?: { collider_mesh_url?: string };
    imagery?: { pano_url?: string };
    thumbnail_url?: string;
    splats?: { spz_urls?: Record<string, string> };
  };
  [key: string]: unknown;
}

function headers(apiKey: string): Record<string, string> {
  return { "WLT-Api-Key": apiKey, "Content-Type": "application/json" };
}

function operationId(operation: MarbleOperation): string {
  const id = operation.operation_id ?? operation.id ?? operation.name;
  if (!id) {
    throw new ChatServiceError(
      "World Labs 响应缺少 operation_id",
      502,
      "worldlabs_bad_response",
    );
  }
  return String(id).split("/").at(-1)!;
}

/** 提交世界生成请求，立即返回续跑所需信息（不轮询）；提交即完成时直接带 response。 */
export async function submitMarbleWorld(
  params: MarbleGenerateParams,
  options: WorldLabsOptions,
): Promise<{ operationId: string; done: boolean; response?: MarbleWorldResponse }> {
  const fetchFn = options.fetchFn ?? fetch;
  if (!params.imagePrompt && !params.textPrompt) {
    throw new ChatServiceError(
      "世界生成需要源图或文字 prompt",
      400,
      "worldlabs_missing_prompt",
    );
  }

  const worldPrompt = params.imagePrompt
    ? {
        type: "image",
        image_prompt: {
          source: "data_base64",
          data_base64: params.imagePrompt.dataBase64,
          extension: params.imagePrompt.extension,
          mime_type: params.imagePrompt.mimeType,
        },
        ...(params.textPrompt ? { text_prompt: params.textPrompt } : {}),
      }
    : { type: "text", text_prompt: params.textPrompt };

  const submitResponse = await fetchWithTimeout(
    fetchFn,
    `${ENDPOINT}/worlds:generate`,
    {
      method: "POST",
      headers: headers(options.apiKey),
      body: JSON.stringify({
        display_name: params.displayName,
        model: MARBLE_MODEL,
        world_prompt: worldPrompt,
      }),
    },
    API_REQUEST_TIMEOUT_MS,
    "World Labs 提交",
  );
  const submitBody = (await submitResponse.json().catch(() => ({}))) as MarbleOperation;
  if (!submitResponse.ok) {
    throw new ChatServiceError(
      `World Labs 提交失败（${submitResponse.status}）`,
      502,
      "worldlabs_submit_failed",
    );
  }

  return {
    operationId: operationId(submitBody),
    done: Boolean(submitBody.done),
    ...(submitBody.done && submitBody.response ? { response: submitBody.response } : {}),
  };
}

/** 仅轮询已存在的 operation（侧写续跑用，不重新提交） */
export async function pollMarbleOperation(
  operationId: string,
  options: WorldLabsOptions,
): Promise<MarbleWorldResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);

  for (;;) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchFn,
        `${ENDPOINT}/operations/${operationId}`,
        { headers: { "WLT-Api-Key": options.apiKey } },
        options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
        "World Labs 轮询",
      );
    } catch (error) {
      // 瞬时网络错误不终止整条任务：等一个轮询间隔后继续，超时仍由 deadline 判定。
      if (!isRetryableNetworkError(error)) throw error;
      if (Date.now() > deadline) {
        throw new ChatServiceError(
          `World Labs 生成超时（operation_id=${operationId}）`,
          504,
          "worldlabs_timeout",
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const body = (await response.json().catch(() => ({}))) as MarbleOperation;
    if (!response.ok) {
      throw new ChatServiceError(
        `World Labs 轮询失败（${response.status}）`,
        502,
        "worldlabs_poll_failed",
      );
    }
    await options.onStatus?.(body.done ? "completed" : "running");
    if (body.done) {
      if (body.error) {
        throw new ChatServiceError(
          `World Labs 生成失败：${JSON.stringify(body.error).slice(0, 300)}`,
          502,
          "worldlabs_failed",
        );
      }
      if (!body.response) {
        throw new ChatServiceError(
          "World Labs operation 完成但没有 response",
          502,
          "worldlabs_bad_response",
        );
      }
      return body.response;
    }
    if (Date.now() > deadline) {
      throw new ChatServiceError(
        `World Labs 生成超时（operation_id=${operationId}）`,
        504,
        "worldlabs_timeout",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface WorldAssetUrls {
  glb?: string;
  pano?: string;
  thumbnail?: string;
  spz: Record<string, string>;
}

export function extractWorldAssetUrls(response: MarbleWorldResponse): WorldAssetUrls {
  const assets = response.assets ?? {};
  const spz: Record<string, string> = {};
  for (const [key, url] of Object.entries(assets.splats?.spz_urls ?? {})) {
    if (url) spz[key] = url;
  }
  return {
    glb: assets.mesh?.collider_mesh_url,
    pano: assets.imagery?.pano_url,
    thumbnail: assets.thumbnail_url,
    spz,
  };
}
