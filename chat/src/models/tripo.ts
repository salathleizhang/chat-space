import { createHash, createHmac } from "node:crypto";
import { ChatServiceError } from "../common/errors";
import {
  API_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  readBodyWithTimeout,
  sleep,
} from "../common/http";
import { pollProviderTask } from "../common/polling";
import { currentTaskPump } from "../common/taskPump";
import type { GenerationPhase } from "../dto/tasks";
import { tripoCategoryFor, tripoGate } from "./tripoConcurrency";
import { tripoTaskQuerierFor } from "./tripoTaskQuery";

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

/** P 系列低多边形几何模型（v3 端点收带日期的固定 ID，别名 tripo-p1 也可用）。 */
export const TRIPO_P1_MODEL = "P1-20260311";
export const TRIPO_P2_MODEL = "P2-20260801";

/**
 * `/mesh/decimate` 的目标面数区间（三角面 / 四边面）。
 * 工具 schema 与执行前的校验都从这里取，免得 20 000 这个上限在两个文件里各写一遍、
 * 改一处漏一处（降面卡片的推荐档位也照这个上限来，见 creator 提示词）。
 */
export const TRIPO_DECIMATE_FACES = {
  triangle: { min: 500, max: 20_000 },
  quad: { min: 500, max: 10_000 },
} as const;

/** 最新贴图模型（v3.5，2026-09）：新增 texture_quality=fast 与 delight。 */
export const DEFAULT_TRIPO_TEXTURE_MODEL = "v3.5-20260815";

/** 语义分割 v2（Beta，带语义标签）。 */
export const TRIPO_SEGMENT_MODEL = "v2.0-20260430";

/**
 * 贴图版本：v2.5 几何配 v2.5 贴图，其余（v3.x / P 系列）用最新的 v3.5。
 * 官方在省略 texture_version 时会把非 v2.5 几何降到 v3.0 贴图，这里显式升到最新。
 */
export function tripoTextureVersionFor(geometryModel: string): string {
  return geometryModel.startsWith("v2.5") ? "v2.5-20250123" : DEFAULT_TRIPO_TEXTURE_MODEL;
}

export interface TripoCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 单次状态查询的超时预算（默认 API_REQUEST_TIMEOUT_MS） */
  requestTimeoutMs?: number;
  /** 图生 3D 的几何模型版本；缺省用 DEFAULT_TRIPO_IMAGE_MODEL */
  imageModel?: string;
  /** 贴图模型版本；缺省按几何模型推导（v2.5 → v2.5，其余 → 最新 v3.5） */
  textureModel?: string;
  onStatus?: (status: string) => void | Promise<void>;
  /**
   * 阶段推进：Tripo 后处理全是长流程（提交 → 轮询 → 下载几十 MB），不报阶段时任务会全程停在
   * `queued`，看板上跟"卡死"一模一样、`updatedAt` 也不动（2026-10-02 的贴图任务就这样挂了 20 分钟，
   * 而供应商 43 秒就完成了）。调用方把它接到 `TaskExecutionContext.setPhase` 上。
   */
  onPhase?: (phase: GenerationPhase) => void | Promise<void>;
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
  form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
  const response = await fetchWithTimeout(
    fetchFn,
    `${V3_BASE}/files`,
    {
      method: "POST",
      headers: authHeader(options.apiKey),
      body: form,
    },
    UPLOAD_REQUEST_TIMEOUT_MS,
    "Tripo upload",
  );
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo upload failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_upload_failed",
    );
  }
  const token = dataOf(payload).file_token ?? dataOf(payload).image_token;
  if (typeof token !== "string" || !token) {
    throw new ChatServiceError("Tripo upload response is missing file_token", 502, "tripo_upload_failed");
  }
  return token;
}

/** 提交给 Tripo 的一次任务请求：能力端点 + 请求体 */
export interface TripoTaskRequest {
  path: string;
  body: Record<string, unknown>;
}

/** 图生 3D 的请求（file_token 由 uploadTripoFile 得到） */
export function tripoImageToModelRequest(
  fileToken: string,
  options: TripoCallOptions,
): TripoTaskRequest {
  const model = options.imageModel ?? DEFAULT_TRIPO_IMAGE_MODEL;
  return {
    path: "/generation/image-to-model",
    body: {
      input: fileToken,
      model,
      texture_version: options.textureModel ?? tripoTextureVersionFor(model),
    },
  };
}

export type TripoView = "front" | "left" | "back" | "right";

/** 多视角图生 3D：front 必须存在，且总计至少两个视角。 */
export function tripoMultiviewToModelRequest(
  inputs: Partial<Record<TripoView, string>>,
  options: TripoCallOptions,
): TripoTaskRequest {
  const orderedViews: TripoView[] = ["front", "left", "back", "right"];
  const payloadInputs = orderedViews.flatMap((view) =>
    inputs[view] ? [{ [view]: inputs[view] }] : [],
  );
  if (!inputs.front || payloadInputs.length < 2) {
    throw new ChatServiceError(
      "Tripo multi-view generation needs at least front and one other view",
      400,
      "tripo_multiview_invalid",
    );
  }
  const model = options.imageModel ?? DEFAULT_TRIPO_IMAGE_MODEL;
  return {
    path: "/generation/multiview-to-model",
    body: {
      inputs: payloadInputs,
      model,
      texture_version: options.textureModel ?? tripoTextureVersionFor(model),
    },
  };
}

/** 把上传好的模型文件登记成 Tripo 任务（后续分割/贴图等后处理的链头） */
export function tripoImportModelRequest(fileToken: string): TripoTaskRequest {
  return { path: "/models/import", body: { input: fileToken } };
}

// ---------- 429 的两种含义：并发占满（2000）与频率超限（1007） ----------

/**
 * 官方错误码（https://developers.tripo3d.ai/zh/docs/rate-limits）：
 * - `2000` = 该类目**并发**占满（消息是 "You have exceeded the limit of generation"）
 * - `1007` = **请求频率**超限（按 API Key 数时间窗）
 *
 * 两者都是 HTTP 429，但处置不同：并发占满要**让出槽位再排队**（按 Retry-After），
 * 频率超限只是等一会儿（指数退避）。旧的实现把两者一起包成 502 直接判死，
 * 于是 2026-10-01 那批 16 个 P 系列任务里 11 个当场变成 failed（其实等一会儿就能跑）。
 */
const TRIPO_RATE_LIMIT_CODE = 1007;
const TRIPO_CONCURRENCY_CODE = 2000;

/** 指数退避参数（官方「最佳实践」：1 秒起、每次翻倍、上限 32 秒、最多 5 次） */
export const TRIPO_RATE_BACKOFF_BASE_MS = 1_000;
export const TRIPO_RATE_BACKOFF_MAX_MS = 32_000;
export const TRIPO_RATE_MAX_ATTEMPTS = 5;
/** 并发占满时没有 Retry-After 的兜底等待；次数给得比限流多，因为槽位是等出来的 */
export const TRIPO_CONCURRENCY_DEFAULT_WAIT_MS = 5_000;
export const TRIPO_CONCURRENCY_MAX_ATTEMPTS = 8;
/** Retry-After 再大也不超过一分钟：一个坏头不该把任务挂住 */
const RETRY_AFTER_MAX_MS = 60_000;

/**
 * 429 的重试策略。数值就是上面那组官方建议值；单独放一个可变对象只为让测试能把等待
 * 压到毫秒级（生产代码不要改它，改了就绕开了官方建议的退避节奏）。
 */
export const tripoRetryPolicy = {
  rateMaxAttempts: TRIPO_RATE_MAX_ATTEMPTS,
  concurrencyMaxAttempts: TRIPO_CONCURRENCY_MAX_ATTEMPTS,
  backoffBaseMs: TRIPO_RATE_BACKOFF_BASE_MS,
  backoffMaxMs: TRIPO_RATE_BACKOFF_MAX_MS,
  concurrencyDefaultWaitMs: TRIPO_CONCURRENCY_DEFAULT_WAIT_MS,
};

/** 429 的分类结果；调用方据此决定「让出槽位重排」还是「指数退避重试」 */
export class TripoRateLimitError extends ChatServiceError {
  constructor(
    message: string,
    readonly kind: "concurrency" | "rate",
    /** 服务端给的 Retry-After（毫秒）；没有这个头就是 undefined */
    readonly retryAfterMs: number | undefined,
  ) {
    super(message, 429, "tripo_rate_limited");
    this.name = "TripoRateLimitError";
  }

  /** 第 attempt 次（从 1 起）重试前该等多久 */
  waitMs(attempt: number): number {
    if (this.kind === "concurrency" && this.retryAfterMs !== undefined) {
      return Math.min(this.retryAfterMs, RETRY_AFTER_MAX_MS);
    }
    const base = this.kind === "concurrency"
      ? tripoRetryPolicy.concurrencyDefaultWaitMs
      : tripoRetryPolicy.backoffBaseMs;
    return Math.min(base * 2 ** Math.max(0, attempt - 1), tripoRetryPolicy.backoffMaxMs);
  }
}

/**
 * `Retry-After` 允许是秒数，也允许是 HTTP 日期；两种都认。
 *
 * ⚠️ 实测（2026-10-01）Tripo 的成功响应里**没有**官方文档承诺的 `X-RateLimit-*` 头，
 * 所以退避不能只依赖响应头——本函数取不到值时必须回落到指数退避。
 */
export function retryAfterMsFrom(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_MAX_MS);
}

function tripoRateLimitError(
  path: string,
  response: Response,
  payload: Record<string, unknown>,
): TripoRateLimitError | undefined {
  const concurrency = payload.code === TRIPO_CONCURRENCY_CODE;
  if (!concurrency && payload.code !== TRIPO_RATE_LIMIT_CODE && response.status !== 429) {
    return undefined;
  }
  return new TripoRateLimitError(
    // 文案保持与旧实现一致的形状，失败原因仍然一眼可见
    `Tripo submit failed (${path} ${response.status}): ${JSON.stringify(payload).slice(0, 300)}`,
    concurrency ? "concurrency" : "rate",
    retryAfterMsFrom(response.headers),
  );
}

/**
 * v3 系任务（生成 / 后处理 / 导入等能力端点）的**单次提交**；429 抛 TripoRateLimitError。
 * 只由 `runTripoTask` 调用——并发与重排都在那一层，别直接用它提交。
 */
async function createTripoV3Task(
  path: string,
  body: Record<string, unknown>,
  options: TripoCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchWithTimeout(
    fetchFn,
    `${V3_BASE}${path}`,
    {
      method: "POST",
      headers: { ...authHeader(options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    API_REQUEST_TIMEOUT_MS,
    `Tripo submit ${path}`,
  );
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    const limited = tripoRateLimitError(path, response, payload);
    if (limited) throw limited;
    throw new ChatServiceError(
      `Tripo submit failed (${path} ${response.status}): ${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_submit_failed",
    );
  }
  const taskId = dataOf(payload).task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new ChatServiceError("Tripo submit response is missing task_id", 502, "tripo_submit_failed");
  }
  return taskId;
}

/**
 * 跑一个 Tripo 任务：**按类目取并发槽 → 提交 → 交给 afterSubmit（里面应当一直等到终态）→ 放槽**。
 *
 * 两道防线：
 * ① 本进程的类目闸门（`tripoConcurrency.ts`）——一批 16 个对象会排队，P 系列最多 5 个在跑，
 *    不再齐发撞 429；
 * ② 撞上账户里**别的**占用者（另一个进程/机器）时，429 会带 code 2000 → 放掉槽、按
 *    `Retry-After` 等一会儿再排队；code 1007 则是频率限流 → 指数退避。
 *
 * 槽必须持到任务终态：Tripo 数的是"正在跑"的任务数，只包住提交等于没限并发。
 */
export async function runTripoTask<T>(
  request: TripoTaskRequest,
  options: TripoCallOptions,
  afterSubmit: (taskId: string) => Promise<T>,
): Promise<T> {
  const category = tripoCategoryFor(request.path, request.body);
  for (let attempt = 1; ; attempt += 1) {
    const release = await tripoGate.acquire(category);
    let taskId: string;
    try {
      taskId = await createTripoV3Task(request.path, request.body, options);
    } catch (error) {
      // 提交没成功就没有占住 Tripo 的槽，先放掉本地槽再等（等待期间不占坑）
      release();
      if (!(error instanceof TripoRateLimitError)) throw error;
      const maxAttempts = error.kind === "concurrency"
        ? tripoRetryPolicy.concurrencyMaxAttempts
        : tripoRetryPolicy.rateMaxAttempts;
      if (attempt >= maxAttempts) throw error;
      // 退避等待同样交给任务闸门：本进程定时器停摆时由工作台的外部心跳放行。
      const backoffMs = error.waitMs(attempt);
      await (currentTaskPump()?.wait(backoffMs) ?? sleep(backoffMs));
      continue;
    }
    try {
      return await afterSubmit(taskId);
    } finally {
      release();
    }
  }
}

/** v3 分割任务（Segmentation v2 模型）：输入是已有 Tripo 任务 id */
export function tripoSegmentRequest(originalTaskId: string): TripoTaskRequest {
  return { path: "/mesh/segment", body: { model: TRIPO_SEGMENT_MODEL, input: originalTaskId } };
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

  const response = await fetchWithTimeout(
    fetchFn,
    `https://${s3Host}${canonicalUri}`,
    {
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
      body: new Uint8Array(bytes),
    },
    UPLOAD_REQUEST_TIMEOUT_MS,
    "Tripo S3 direct upload",
  );
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo S3 direct upload failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
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
  const response = await fetchWithTimeout(
    fetchFn,
    `${V3_BASE}/files/upload-credentials`,
    {
      method: "POST",
      headers: { ...authHeader(options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    },
    API_REQUEST_TIMEOUT_MS,
    "Tripo STS issue",
  );
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Tripo STS issue failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "tripo_upload_failed",
    );
  }
  const data = dataOf(payload);
  const required = ["s3_host", "sts_ak", "sts_sk", "session_token", "resource_bucket", "resource_uri"];
  for (const field of required) {
    if (typeof data[field] !== "string" || !data[field]) {
      throw new ChatServiceError(`Tripo STS response is missing ${field}`, 502, "tripo_upload_failed");
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
    throw new ChatServiceError("Tripo STS response is missing file_token", 502, "tripo_upload_failed");
  }
  return fileToken;
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "banned", "expired"]);

/**
 * 轮询 v3 任务直至 success，返回任务 data；终态失败/超时抛错。
 *
 * 查询走**批量**端点 `POST /tasks/list`（官方建议，见 tripoTaskQuery.ts）：同一时刻到点的
 * 多个任务会被合并成一个请求。轮询间隔、总预算、状态回调仍是**每任务一份**，所以
 * 「16 个任务 = 16 个请求/轮」变成「16 个任务 = 1 个请求/轮」，单个任务的超时语义不变。
 */
export async function waitForTripoTask(
  taskId: string,
  options: TripoCallOptions,
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  const label = "Tripo task query";
  const timeoutError = () =>
    new ChatServiceError(
      `Tripo task timed out (task_id=${taskId}; you can keep polling from the sidecar)`,
      504,
      "tripo_timeout",
    );
  // 同一把 key + 同一个 fetch 的查询共用合并器（并发是账户级的）
  const querier = tripoTaskQuerierFor({
    baseUrl: V3_BASE,
    apiKey: options.apiKey,
    fetchFn,
    requestTimeoutMs: options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
  });

  const result = await pollProviderTask<{ data: Record<string, unknown>; status: string }>({
    label,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 10_000,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    timeoutError,
    // 超时信号由合并器内部那一次请求持有（fetchWithTimeout），外层 pollProviderTask 的
    // 硬预算仍然是这个任务的兜底：合并请求挂住也不会让任务停在 running。
    attempt: async (_signal, requestTimeoutMs) => {
      const data = await querier.query(taskId, requestTimeoutMs);
      return { data, status: typeof data.status === "string" ? data.status : "unknown" };
    },
    statusOf: (result) => result.status,
    isDone: (result) => result.status === "success",
    failureOf: (result) =>
      TERMINAL_FAILURES.has(result.status)
        ? new ChatServiceError(`Tripo task failed: ${result.status}`, 502, "tripo_task_failed")
        : undefined,
  });

  return result.data;
}
