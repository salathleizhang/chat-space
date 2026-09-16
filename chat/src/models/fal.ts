import { ChatServiceError } from "../common/errors";

/**
 * FAL 队列协议客户端（对应上游 fal-queue.mjs）：
 * submit → poll status → get result。BYOK：key 是调用参数，不读环境变量。
 * fetch 可注入以便测试。
 */

export interface FalCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 每次状态轮询后的回调（用于刷新请求侧写） */
  onStatus?: (status: string) => void | Promise<void>;
  /** 提交成功、拿到 requestId 后、开始轮询前回调（供调用方在崩溃窗口前落盘续跑 id） */
  onSubmitted?: (submission: FalSubmission) => void | Promise<void>;
}

export interface FalSubmission {
  requestId: string;
  statusUrl?: string;
  responseUrl?: string;
  submittedAt: string;
}

const QUEUE_BASE = "https://queue.fal.run";

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}` };
}

async function jsonOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function submitToFalQueue(
  endpoint: string,
  input: Record<string, unknown>,
  options: FalCallOptions,
): Promise<FalSubmission> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${QUEUE_BASE}/${endpoint}`, {
    method: "POST",
    headers: { ...authHeaders(options.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `FAL 提交失败（${response.status}）：${JSON.stringify(body).slice(0, 300)}`,
      502,
      "fal_submit_failed",
    );
  }
  const requestId = body.request_id;
  if (typeof requestId !== "string" || !requestId) {
    throw new ChatServiceError("FAL 提交响应缺少 request_id", 502, "fal_submit_failed");
  }
  return {
    requestId,
    statusUrl: typeof body.status_url === "string" ? body.status_url : undefined,
    responseUrl: typeof body.response_url === "string" ? body.response_url : undefined,
    submittedAt: new Date().toISOString(),
  };
}

export async function waitForFalCompletion(
  endpoint: string,
  submission: FalSubmission,
  options: FalCallOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  const statusUrl =
    submission.statusUrl ??
    `${QUEUE_BASE}/${endpoint}/requests/${submission.requestId}/status`;

  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(statusUrl, { headers: authHeaders(options.apiKey) });
    } catch {
      // 瞬时网络错误不终止整条任务：等一个轮询间隔后继续，超时仍由 deadline 判定。
      if (Date.now() > deadline) {
        throw new ChatServiceError(
          `FAL 请求超时（request_id=${submission.requestId}，可凭侧写续跑）`,
          504,
          "fal_timeout",
        );
      }
      await options.onStatus?.("RETRYING");
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    const body = await jsonOrEmpty(response);
    if (!response.ok) {
      throw new ChatServiceError(
        `FAL 状态查询失败（${response.status}）`,
        502,
        "fal_status_failed",
      );
    }
    const status = typeof body.status === "string" ? body.status : "UNKNOWN";
    await options.onStatus?.(status);

    if (status === "COMPLETED") {
      if (body.error) {
        throw new ChatServiceError(
          `FAL 请求失败：${JSON.stringify(body.error).slice(0, 300)}`,
          502,
          "fal_request_failed",
        );
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new ChatServiceError(
        `FAL 请求超时（request_id=${submission.requestId}，可凭侧写续跑）`,
        504,
        "fal_timeout",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function getFalQueueResult(
  endpoint: string,
  submission: FalSubmission,
  options: FalCallOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const resultUrl =
    submission.responseUrl ?? `${QUEUE_BASE}/${endpoint}/requests/${submission.requestId}`;
  const response = await fetchFn(resultUrl, { headers: authHeaders(options.apiKey) });
  const body = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(`FAL 结果获取失败（${response.status}）`, 502, "fal_result_failed");
  }
  return body;
}

/** 提交 → 等完成 → 取结果 的完整队列调用 */
export async function callFalQueue(
  endpoint: string,
  input: Record<string, unknown>,
  options: FalCallOptions,
  hooks?: { onSubmit?: (submission: FalSubmission) => void | Promise<void> },
): Promise<{ submission: FalSubmission; result: unknown }> {
  const submission = await submitToFalQueue(endpoint, input, options);
  await hooks?.onSubmit?.(submission);
  await waitForFalCompletion(endpoint, submission, options);
  const result = await getFalQueueResult(endpoint, submission, options);
  return { submission, result };
}

/** fal 存储上传（中转桶）：initiate → PUT 原始字节 → 公网 file_url（官方 JS 客户端同路径，2026-07 核实源码） */
const REST_BASE = "https://rest.alpha.fal.ai";
/** 简单上传上限（≥90MB 需分片上传，未实现） */
const SIMPLE_UPLOAD_LIMIT_BYTES = 90 * 1024 * 1024;

export async function uploadToFalStorage(
  fileName: string,
  contentType: string,
  bytes: Uint8Array,
  options: FalCallOptions,
): Promise<string> {
  if (bytes.byteLength > SIMPLE_UPLOAD_LIMIT_BYTES) {
    throw new ChatServiceError(
      `文件超过 fal 存储简单上传上限（${Math.round(bytes.byteLength / 1024 / 1024)}MB > 90MB）`,
      413,
      "fal_upload_too_large",
    );
  }
  const fetchFn = options.fetchFn ?? fetch;
  const initiate = await fetchFn(
    `${REST_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: { ...authHeaders(options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: fileName, content_type: contentType }),
    },
  );
  const body = await jsonOrEmpty(initiate);
  if (!initiate.ok) {
    throw new ChatServiceError(
      `fal 存储上传初始化失败（${initiate.status}）：${JSON.stringify(body).slice(0, 300)}`,
      502,
      "fal_upload_failed",
    );
  }
  const uploadUrl = body.upload_url;
  const fileUrl = body.file_url;
  if (typeof uploadUrl !== "string" || !uploadUrl || typeof fileUrl !== "string" || !fileUrl) {
    throw new ChatServiceError(
      "fal 存储初始化响应缺少 upload_url/file_url",
      502,
      "fal_upload_failed",
    );
  }
  const put = await fetchFn(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new ChatServiceError(`fal 存储上传失败（${put.status}）`, 502, "fal_upload_failed");
  }
  return fileUrl;
}

/** FAL 平台模型搜索（wildcard 发现段，免费查询；上游 image-blast-wildcard 约定） */
const PLATFORM_BASE = "https://api.fal.ai/v1";

export interface FalModelSummary {
  endpointId: string;
  title?: string;
  category?: string;
  description?: string;
}

export async function searchFalModels(
  query: string,
  options: FalCallOptions & { limit?: number },
): Promise<FalModelSummary[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${PLATFORM_BASE}/models?q=${encodeURIComponent(query)}&status=active&limit=${options.limit ?? 5}`;
  const response = await fetchFn(url, { headers: authHeaders(options.apiKey) });
  const body = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `FAL 模型搜索失败（${response.status}）`,
      502,
      "fal_search_failed",
    );
  }
  const items = (body.models ?? body.items ?? body.data ?? []) as Record<
    string,
    unknown
  >[];
  return items
    .map((item) => ({
      endpointId: String(item.endpoint_id ?? item.id ?? ""),
      title: typeof item.title === "string" ? item.title : undefined,
      category: typeof item.category === "string" ? item.category : undefined,
      description:
        typeof item.description === "string"
          ? item.description.slice(0, 300)
          : undefined,
    }))
    .filter((item) => item.endpointId.length > 0);
}

export async function getFalModelSchema(
  endpointId: string,
  options: FalCallOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${PLATFORM_BASE}/models?endpoint_id=${encodeURIComponent(endpointId)}&expand=openapi-3.0`;
  const response = await fetchFn(url, { headers: authHeaders(options.apiKey) });
  const body = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `FAL 模型 schema 获取失败（${response.status}）`,
      502,
      "fal_schema_failed",
    );
  }
  return body;
}

export interface RemoteFileRef {
  url: string;
  contentType?: string;
  fileName?: string;
}

/** 递归扫描结果 JSON 中的文件引用（形如 { url, content_type?, file_name? } 的对象） */
export function extractFileRefs(value: unknown, found: RemoteFileRef[] = []): RemoteFileRef[] {
  if (Array.isArray(value)) {
    for (const item of value) extractFileRefs(item, found);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && /^https?:\/\//.test(record.url)) {
      found.push({
        url: record.url,
        contentType: typeof record.content_type === "string" ? record.content_type : undefined,
        fileName: typeof record.file_name === "string" ? record.file_name : undefined,
      });
    } else {
      for (const nested of Object.values(record)) extractFileRefs(nested, found);
    }
  }
  return found;
}
