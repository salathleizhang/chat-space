import { ChatServiceError } from "./errors";

/**
 * 出网请求的统一超时预算。
 *
 * Bun 的 fetch 在 keep-alive 连接被服务端或本机代理静默断开时不会 reject，请求会
 * 永远 pending。供应商轮询循环里的 deadline 只在 fetch 返回之后才检查，于是一个没有
 * 超时的请求能让任务永远停在 running/generating——供应商侧其实早已完成
 * （2026-09-26 的 Tripo 批量任务就是这样挂了近两小时）。所以每一次出网都必须带
 * AbortSignal.timeout，让「最坏情况」变成一个可见的失败。
 */

/** 提交、查询状态这类短请求；正常在秒级返回 */
export const API_REQUEST_TIMEOUT_MS = 2 * 60_000;
/** 上传参考图/模型（multipart 或 S3 直传） */
export const UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 图片生成/编辑；高分辨率单张可能跑一两分钟 */
export const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 产物下载（GLB 可达数十 MB） */
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** 给请求补上超时信号；调用方自带 signal 时保持不动，尊重显式取消。 */
export function withRequestTimeout(init: RequestInit = {}, timeoutMs: number): RequestInit {
  return init.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/** fetch 因超时/取消抛出的 DOMException（TimeoutError 或 AbortError） */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * 只有超时和网络层错误值得重试；供应商明确回错的业务错误（ChatServiceError）应立刻
 * 冒泡，否则一个错 key 会白白轮询到 deadline 才失败。
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof ChatServiceError) return error.code === "request_timeout";
  return true;
}

/** 带超时的 fetch：超时转成带上下文的 ChatServiceError，其余错误原样冒泡 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetchFn(input, withRequestTimeout(init ?? {}, timeoutMs));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ChatServiceError(
        `${label}请求超时（${Math.round(timeoutMs / 1000)} 秒无响应），已中止`,
        504,
        "request_timeout",
      );
    }
    throw error;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
