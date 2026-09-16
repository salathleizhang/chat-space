import { createHash, createHmac } from "node:crypto";
import { ChatServiceError } from "../common/errors";

/**
 * Tripo3D 直连客户端（Bearer tsk_ key；REST 细节经官方 Python SDK 源码核实 2026-07）。
 * v2：POST /task 建任务（{ data: { task_id } }）→ GET /task/:id 轮询
 * （data.status: queued / running / success / failed / cancelled / banned / expired）。
 * v3（分割等新能力）：POST openapi.tripo3d.ai/v3/mesh/segment → GET /v3/tasks/:id。
 * 图片经 POST /upload/file（multipart，file_token）；模型文件导入需 STS 直传 S3（待接）。
 * 后处理任务只收 original_model_task_id —— 链式：先有 Tripo 生成任务才能后处理。
 */

const V2_BASE = "https://api.tripo3d.ai/v2/openapi";
const V3_BASE = "https://openapi.tripo3d.ai";

export interface TripoCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function jsonOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function dataOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.data ?? {}) as Record<string, unknown>;
}

/** 上传图片（multipart）→ file_token；仅支持图片，模型文件须走 STS 直传（待接） */
export async function uploadTripoImage(
  fileName: string,
  bytes: Uint8Array,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  const response = await fetchFn(`${V2_BASE}/upload/file`, {
    method: "POST",
    headers: authHeader(options.apiKey),
    body: form,
  });
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo 上传失败（${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_upload_failed",
    );
  }
  const token = dataOf(payload).file_token ?? dataOf(payload).image_token;
  if (typeof token !== "string" || !token) {
    throw new ChatServiceError("Tripo 上传响应缺少 file_token", 502, "tripo_upload_failed");
  }
  return token;
}

export async function createTripoTask(
  body: Record<string, unknown>,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${V2_BASE}/task`, {
    method: "POST",
    headers: { ...authHeader(options.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo 提交失败（${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_submit_failed",
    );
  }
  const taskId = dataOf(payload).task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new ChatServiceError("Tripo 提交响应缺少 task_id", 502, "tripo_submit_failed");
  }
  return taskId;
}

/** v3 系任务（分割 / 新版 texture / 新版 rig 等独立端点） */
export async function createTripoV3Task(
  path: string,
  body: Record<string, unknown>,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${V3_BASE}${path}`, {
    method: "POST",
    headers: { ...authHeader(options.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo 提交失败（${path} ${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_submit_failed",
    );
  }
  const taskId = dataOf(payload).task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new ChatServiceError("Tripo 提交响应缺少 task_id", 502, "tripo_submit_failed");
  }
  return taskId;
}

/** v3 分割任务（Segmentation v2 模型）：输入是已有 Tripo 任务 id */
export function createTripoSegmentTask(
  originalTaskId: string,
  options: TripoCallOptions,
): Promise<string> {
  return createTripoV3Task(
    "/v3/mesh/segment",
    { model: "v2.0-20260430", input: originalTaskId },
    options,
  );
}

// ---------- 模型文件导入：STS 换发 + SigV4 直传 S3（Python SDK 的 boto3 路径等价实现） ----------

const S3_SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** AWS SigV4 的 S3 PUT（path-style；region 未在 STS 响应中给出，按 boto3 缺省 us-east-1） */
export async function sigV4PutObject(
  s3Host: string,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  creds: { accessKey: string; secretKey: string; sessionToken: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const region = "us-east-1";
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(bytes);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const canonicalUri = `/${bucket}/${encodedKey}`;

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `host:${s3Host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    `x-amz-security-token:${creds.sessionToken}`,
    "",
    S3_SIGNED_HEADERS,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretKey}`, dateStamp), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const response = await fetchFn(`https://${s3Host}${canonicalUri}`, {
    method: "PUT",
    headers: {
      Host: s3Host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "x-amz-security-token": creds.sessionToken,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, ` +
        `SignedHeaders=${S3_SIGNED_HEADERS}, Signature=${signature}`,
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo S3 直传失败（${response.status}）：${(await response.text()).slice(0, 300)}`,
      502,
      "tripo_upload_failed",
    );
  }
}

/** 上传模型文件（STS 直传）→ 任务 file 对象里的 { bucket, key } */
export async function uploadTripoModelViaSts(
  format: string,
  bytes: Uint8Array,
  options: TripoCallOptions,
): Promise<{ bucket: string; key: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${V2_BASE}/upload/sts/token`, {
    method: "POST",
    headers: { ...authHeader(options.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ format }),
  });
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo STS 换发失败（${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_upload_failed",
    );
  }
  const data = dataOf(payload);
  const required = ["s3_host", "sts_ak", "sts_sk", "session_token", "resource_bucket", "resource_uri"];
  for (const field of required) {
    if (typeof data[field] !== "string" || !data[field]) {
      throw new ChatServiceError(`Tripo STS 响应缺少 ${field}`, 502, "tripo_upload_failed");
    }
  }
  await sigV4PutObject(
    data.s3_host as string,
    data.resource_bucket as string,
    data.resource_uri as string,
    bytes,
    {
      accessKey: data.sts_ak as string,
      secretKey: data.sts_sk as string,
      sessionToken: data.session_token as string,
    },
    fetchFn,
  );
  return { bucket: data.resource_bucket as string, key: data.resource_uri as string };
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "banned", "expired"]);

/** 轮询直至 success，返回任务 data；终态失败/超时抛错 */
export async function waitForTripoTask(
  taskId: string,
  options: TripoCallOptions & { v3?: boolean },
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const url = options.v3 ? `${V3_BASE}/v3/tasks/${taskId}` : `${V2_BASE}/task/${taskId}`;

  for (;;) {
    const response = await fetchFn(url, { headers: authHeader(options.apiKey) });
    const payload = await jsonOrEmpty(response);
    if (!response.ok) {
      throw new ChatServiceError(
        `Tripo 任务查询失败（${response.status}）`,
        502,
        "tripo_status_failed",
      );
    }
    const data = dataOf(payload);
    const status = typeof data.status === "string" ? data.status : "unknown";
    await options.onStatus?.(status);

    if (status === "success") return data;
    if (TERMINAL_FAILURES.has(status)) {
      throw new ChatServiceError(`Tripo 任务失败：${status}`, 502, "tripo_task_failed");
    }
    if (Date.now() > deadline) {
      throw new ChatServiceError(
        `Tripo 任务超时（task_id=${taskId}，可凭侧写续查）`,
        504,
        "tripo_timeout",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
