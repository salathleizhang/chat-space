import { createHash, createHmac } from "node:crypto";
import { ChatServiceError } from "../common/errors";

/**
 * Tripo3D 直连客户端（Bearer tsk_ key；v3 REST 细节经官方文档核实 2026-09）。
 * v3（openapi.tripo3d.ai/v3）把 v2 的通用 POST /task 拆成能力端点：
 * - 上传文件：POST /files（multipart）→ data.file_token；大文件可先用
 *   POST /files/upload-credentials 换 STS 凭证，SigV4 直传 S3 后同样得到 file_token。
 * - 生成：POST /generation/image-to-model（{ input: file_token, model }）。
 * - 后处理：POST /models/import、/models/texture、/mesh/segment、/animations/rig …。
 * - 轮询：GET /tasks/:id（data.status: queued / running / success / failed /
 *   cancelled / banned / expired）。
 * v2 的 POST /v2/openapi/upload/file 已下线（404 code 9404），不要再用。
 */

const V3_BASE = "https://openapi.tripo3d.ai/v3";

/** 图生 3D 默认几何模型（官方 v3.1，最新最佳质量）；可用 TRIPO_IMAGE_MODEL 覆盖。 */
export const DEFAULT_TRIPO_IMAGE_MODEL = "v3.1-20260211";

export interface TripoCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 图生 3D 的几何模型版本；缺省用 DEFAULT_TRIPO_IMAGE_MODEL */
  imageModel?: string;
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

/** 上传参考图（multipart）→ file_token */
export async function uploadTripoFile(
  fileName: string,
  bytes: Uint8Array,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  const response = await fetchFn(`${V3_BASE}/files`, {
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

/** 图生 3D：file_token 由 uploadTripoFile 得到 */
export function createTripoImageToModelTask(
  fileToken: string,
  options: TripoCallOptions,
): Promise<string> {
  return createTripoV3Task(
    "/generation/image-to-model",
    { input: fileToken, model: options.imageModel ?? DEFAULT_TRIPO_IMAGE_MODEL },
    options,
  );
}

export type TripoView = "front" | "left" | "back" | "right";

/** 多视角图生 3D：front 必须存在，且总计至少两个视角。 */
export function createTripoMultiviewToModelTask(
  inputs: Partial<Record<TripoView, string>>,
  options: TripoCallOptions,
): Promise<string> {
  const orderedViews: TripoView[] = ["front", "left", "back", "right"];
  const payloadInputs = orderedViews.flatMap((view) =>
    inputs[view] ? [{ [view]: inputs[view] }] : [],
  );
  if (!inputs.front || payloadInputs.length < 2) {
    throw new ChatServiceError(
      "Tripo 多视角生成至少需要 front 和另一个视角",
      400,
      "tripo_multiview_invalid",
    );
  }
  return createTripoV3Task(
    "/generation/multiview-to-model",
    { inputs: payloadInputs, model: options.imageModel ?? DEFAULT_TRIPO_IMAGE_MODEL },
    options,
  );
}

/** 把上传好的模型文件登记成 Tripo 任务（后续分割/贴图等后处理的链头） */
export function createTripoImportModelTask(
  fileToken: string,
  options: TripoCallOptions,
): Promise<string> {
  return createTripoV3Task("/models/import", { input: fileToken }, options);
}

/** v3 系任务（生成 / 后处理 / 导入等能力端点） */
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
    "/mesh/segment",
    { model: "v2.0-20260430", input: originalTaskId },
    options,
  );
}

// ---------- 大文件导入：STS 换发 + SigV4 直传 S3（官方 /files/upload-credentials 路径） ----------

const S3_SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** STS 只给 s3_host，区域要从主机名里读（如 s3.us-west-2.amazonaws.com → us-west-2） */
export function regionFromS3Host(s3Host: string): string {
  const match = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(s3Host);
  return match?.[1] ?? "us-east-1";
}

/** AWS SigV4 的 S3 PUT（path-style） */
export async function sigV4PutObject(
  s3Host: string,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  creds: { accessKey: string; secretKey: string; sessionToken: string },
  fetchFn: typeof fetch = fetch,
  region = regionFromS3Host(s3Host),
): Promise<void> {
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

/** 上传模型文件（STS 直传，任意大小）→ 可直接当 input 的 file_token */
export async function uploadTripoModelViaSts(
  format: string,
  bytes: Uint8Array,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${V3_BASE}/files/upload-credentials`, {
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
  const fileToken = data.file_token;
  if (typeof fileToken !== "string" || !fileToken) {
    throw new ChatServiceError("Tripo STS 响应缺少 file_token", 502, "tripo_upload_failed");
  }
  return fileToken;
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "banned", "expired"]);

/** 轮询 v3 任务直至 success，返回任务 data；终态失败/超时抛错 */
export async function waitForTripoTask(
  taskId: string,
  options: TripoCallOptions,
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const url = `${V3_BASE}/tasks/${taskId}`;

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
