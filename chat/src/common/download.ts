import { ChatServiceError, toErrorMessage } from "./errors";
import {
  DOWNLOAD_MAX_ATTEMPTS,
  DOWNLOAD_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  readBodyWithTimeout,
  sleep,
} from "./http";
import { currentTaskPump } from "./taskPump";

/**
 * 产物下载：有限重试 + 断点续传。
 *
 * 2026-09-26 的 World Labs 世界生成里，最后一个 full_res splat 下到一半被静默断开
 * （`The socket connection was closed unexpectedly`），整条 53 分钟的任务就此失败，
 * 而前面 23MB 已经落盘、供应商侧也早已完成。链路会抖是常态，不该让一次 socket 抖动
 * 决定整条任务的成败，所以这里做两件事：
 *
 *   ① 有限次重试（指数退避），单次尝试由 http.ts 的硬上限兜底；
 *   ② 断点续传：**边读边攒**，中途断开也保住已收到的字节，重试时用 `Range` 只取缺的
 *      那一段（Marble CDN 支持 206）。攒字节必须在流上做——`arrayBuffer()` 一断就
 *      全丢，那样重试只能从头再来。
 *
 * 只在拿到完整字节后才交给调用方落盘，正式路径上不会出现半截文件。
 *
 * 退避等待同样走任务闸门（`common/taskPump.ts`）：本进程定时器停摆时，
 * 工作台每秒一次的 `GET /api/tasks` 会把重试推着走，而不是把下载永远停在那里。
 */
export interface DownloadBytesOptions {
  fetchFn?: typeof fetch;
  /** 单次尝试的预算 */
  requestTimeoutMs?: number;
  /** 尝试次数（含首次） */
  maxAttempts?: number;
  /** 指数退避的基数（毫秒）；上限固定 15 秒 */
  backoffBaseMs?: number;
  /** 错误文案前缀 */
  label?: string;
}

/** 只有「链路/服务端临时抽风」值得重试；404 这类明确回错立刻冒泡。 */
function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof ChatServiceError) {
    return error.code === "request_timeout" || error.code === "download_retryable";
  }
  // socket 被断开、DNS 抖动等网络层错误
  return true;
}

function backoffMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), 15_000);
}

function concatAll(head: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  let size = head.byteLength;
  for (const chunk of chunks) size += chunk.byteLength;
  const merged = new Uint8Array(size);
  merged.set(head, 0);
  let offset = head.byteLength;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 把响应体读进 `already` 后面。**读到的部分一定带回来**：中途断开时用 error 告知调用方，
 * 同时把已收到的字节交回去，下一次尝试才能从断点接着下。
 */
async function readBodyInto(
  response: Response,
  already: Uint8Array,
  timeoutMs: number,
  label: string,
): Promise<{ bytes: Uint8Array; error?: unknown }> {
  if (!response.body) return { bytes: already };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await readBodyWithTimeout(() => reader.read(), timeoutMs, label);
      if (done) break;
      if (value) chunks.push(value);
    }
    return { bytes: concatAll(already, chunks) };
  } catch (error) {
    return { bytes: concatAll(already, chunks), error };
  }
}

export async function downloadBytesWithRetry(
  url: string,
  options: DownloadBytesOptions = {},
): Promise<Uint8Array> {
  const fetchFn = options.fetchFn ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DOWNLOAD_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS);
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;
  const label = options.label ?? "产物下载";

  let received: Uint8Array = new Uint8Array(0);
  let lastError: unknown;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const requestedRange = received.byteLength > 0;
    try {
      const response = await fetchWithTimeout(
        fetchFn,
        url,
        requestedRange ? { headers: { Range: `bytes=${received.byteLength}-` } } : undefined,
        requestTimeoutMs,
        label,
      );
      if (response.status === 416 && requestedRange) {
        // 手上的字节已经不少于服务端的：丢掉重来，不用可疑的半截内容拼。
        received = new Uint8Array(0);
        throw new ChatServiceError(
          `${label}区间已失效，改为全量重下：${url}`,
          502,
          "download_retryable",
        );
      }
      if (!response.ok) {
        const retryable =
          response.status >= 500 || response.status === 408 || response.status === 429;
        throw new ChatServiceError(
          `${label}失败（${response.status}）：${url}`,
          502,
          retryable ? "download_retryable" : "download_failed",
        );
      }
      // 服务端不认 Range 时会回 200 + 全量：这一轮从零开始攒，不跟旧字节拼。
      const base = response.status === 206 && requestedRange ? received : new Uint8Array(0);
      const { bytes, error } = await readBodyInto(response, base, requestTimeoutMs, label);
      received = bytes;
      if (error) {
        throw new ChatServiceError(
          `${label}传输中断（已收到 ${received.byteLength} 字节，将续传）：${toErrorMessage(error)}`,
          502,
          "download_retryable",
        );
      }
      if (received.byteLength === 0) {
        throw new ChatServiceError(`${label}得到空文件：${url}`, 502, "download_empty");
      }
      return received;
    } catch (error) {
      lastError = error;
      // 明确回错（404 等）不重试，原样冒泡，保留它自己的错误码与文案。
      if (!isRetryableDownloadError(error)) throw error;
      if (attempt === maxAttempts) break;
      await (currentTaskPump()?.wait(backoffMs(attempt, backoffBaseMs)) ??
        sleep(backoffMs(attempt, backoffBaseMs)));
    }
  }

  throw new ChatServiceError(
    `${label}失败（已尝试 ${attempts} 次）：${url}；最后一次错误：${toErrorMessage(lastError)}。` +
      "已经落盘的其他产物不受影响，可用 repair-assets 只补缺失文件。",
    502,
    "download_failed",
  );
}
