import { ChatServiceError } from "../common/errors";
import { API_REQUEST_TIMEOUT_MS, fetchWithTimeout, readBodyWithTimeout } from "../common/http";
import { pollProviderTask } from "../common/polling";

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
    splats?: {
      spz_urls?: Record<string, string>;
      semantics_metadata?: MarbleSemanticsMetadata;
    };
  };
  [key: string]: unknown;
}

/**
 * World Labs 世界的语义元数据。字段名是供应商的 snake_case，原样保留以便和
 * `N-world.json` 对照；app 侧要用的三个值由 `extractWorldSemantics` 归一化。
 */
export interface MarbleSemanticsMetadata {
  metric_scale_factor?: number;
  ground_plane_offset?: number;
  flip_y?: boolean;
}

/**
 * 渲染一个世界必须的三个对齐参数。
 *
 * **World Labs 的坐标系是 +Y 朝下**：实测其 collider 网格 94.7% 的顶点法线指向 −Y
 * （地面法线本该指向"上"）。所以原样丢进 Y-up 的 three.js 场景，整个世界是倒过来的。
 *
 * 这三个值是「画面」（spz 泼溅）与「物理」（collider 网格）**共同**的对齐契约，必须
 * 同时套在两者上，缺一个都会错位：只翻转不缩放会小 2.6 倍并陷进地里。
 *
 * `flipY` 缺省 **true**：Marble 取默认值时不会返回 `flip_y` 字段，「字段缺失」不等于
 * 「不用翻转」。上游 image-blaster 的 `flip_y ?? true` 是同一个约定。
 */
export interface WorldSemantics {
  /** 绕 X 轴转 π，把 −Y 变成"上" */
  flipY: boolean;
  /** 统一缩放，让场景是真实米制 */
  metricScaleFactor: number;
  /** Y 平移，把地面抬到 y=0 */
  groundPlaneOffset: number;
}

export function extractWorldSemantics(response: MarbleWorldResponse): WorldSemantics {
  const meta = response.assets?.splats?.semantics_metadata ?? {};
  const finite = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    flipY: typeof meta.flip_y === "boolean" ? meta.flip_y : true,
    metricScaleFactor: finite(meta.metric_scale_factor, 1),
    groundPlaneOffset: finite(meta.ground_plane_offset, 0),
  };
}

function headers(apiKey: string): Record<string, string> {
  return { "WLT-Api-Key": apiKey, "Content-Type": "application/json" };
}

function operationId(operation: MarbleOperation): string {
  const id = operation.operation_id ?? operation.id ?? operation.name;
  if (!id) {
    throw new ChatServiceError(
      "World Labs response is missing operation_id",
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
      "World generation needs a source image or a text prompt",
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
    "World Labs submit",
  );
  const submitBody = (await submitResponse.json().catch(() => ({}))) as MarbleOperation;
  if (!submitResponse.ok) {
    throw new ChatServiceError(
      `World Labs submit failed (${submitResponse.status})`,
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

/**
 * 仅轮询已存在的 operation（侧写续跑用，不重新提交）。
 *
 * 走公共骨架：每一次查询都有硬上限，总预算到点必然兑现。这里曾经是「供应商 5 分钟完成、
 * 本机 37 分钟没动静、30 分钟 deadline 一次没触发」的地方——因为 deadline 只在 await
 * 返回之后才检查，请求挂住时那行永远走不到。
 */
export async function pollMarbleOperation(
  operationId: string,
  options: WorldLabsOptions,
): Promise<MarbleWorldResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const label = "World Labs poll";
  const timeoutError = () =>
    new ChatServiceError(
      `World Labs generation timed out (operation_id=${operationId}; resume the poll from the sidecar)`,
      504,
      "worldlabs_timeout",
    );

  const operation = await pollProviderTask<MarbleOperation>({
    label,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 15_000,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    timeoutError,
    attempt: async (signal, requestTimeoutMs) => {
      const response = await fetchWithTimeout(
        fetchFn,
        `${ENDPOINT}/operations/${operationId}`,
        { headers: { "WLT-Api-Key": options.apiKey }, signal },
        requestTimeoutMs,
        label,
      );
      const body = await readBodyWithTimeout(
        () => response.json().catch(() => ({})) as Promise<MarbleOperation>,
        requestTimeoutMs,
        label,
      );
      if (!response.ok) {
        throw new ChatServiceError(
          `World Labs poll failed (${response.status})`,
          502,
          "worldlabs_poll_failed",
        );
      }
      return body;
    },
    statusOf: (body) => (body.done ? "completed" : "running"),
    // 带 error 的 done 走 failureOf，不能当成成功。
    isDone: (body) => Boolean(body.done) && !body.error,
    failureOf: (body) =>
      body.done && body.error
        ? new ChatServiceError(
            `World Labs generation failed: ${JSON.stringify(body.error).slice(0, 300)}`,
            502,
            "worldlabs_failed",
          )
        : undefined,
  });

  if (!operation.response) {
    throw new ChatServiceError(
      "World Labs operation finished without a response",
      502,
      "worldlabs_bad_response",
    );
  }
  return operation.response;
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
