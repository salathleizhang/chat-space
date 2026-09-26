import { createHash, createHmac } from "node:crypto";
import { ChatServiceError } from "../common/errors";

/** 腾讯混元 UV 展开客户端；其余 3D 能力已移除。 */

const HOST = "ai3d.tencentcloudapi.com";
const SERVICE = "ai3d";
const VERSION = "2025-05-13";

export interface HunyuanCallOptions {
  /** "SecretId:SecretKey" */
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

export type HunyuanUvAction =
  | "SubmitHunyuanTo3DUVJob"
  | "DescribeHunyuanTo3DUVJob";

function splitKey(apiKey: string): { secretId: string; secretKey: string } {
  const sep = apiKey.indexOf(":");
  if (sep <= 0 || sep === apiKey.length - 1) {
    throw new ChatServiceError(
      "混元 API key 格式应为「SecretId:SecretKey」（腾讯云访问密钥两段用冒号拼接）",
      400,
      "invalid_hunyuan_key",
    );
  }
  return { secretId: apiKey.slice(0, sep), secretKey: apiKey.slice(sep + 1) };
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** TC3-HMAC-SHA256 签名调用（POST JSON） */
export async function callHunyuanAction(
  action: HunyuanUvAction,
  payload: Record<string, unknown>,
  options: HunyuanCallOptions,
): Promise<Record<string, unknown>> {
  const { secretId, secretKey } = splitKey(options.apiKey);
  const fetchFn = options.fetchFn ?? fetch;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = createHmac("sha256", `TC3${secretKey}`).update(date).digest();
  const secretService = createHmac("sha256", secretDate).update(SERVICE).digest();
  const secretSigning = createHmac("sha256", secretService).update("tc3_request").digest();
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

  const response = await fetchFn(`https://${HOST}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: HOST,
      "X-TC-Action": action,
      "X-TC-Version": VERSION,
      "X-TC-Timestamp": String(timestamp),
      Authorization:
        `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as {
    Response?: Record<string, unknown> & { Error?: { Code?: string; Message?: string } };
  };
  const result = json.Response ?? {};
  if (!response.ok || result.Error) {
    const error = result.Error;
    throw new ChatServiceError(
      `混元 ${action} 失败：${error?.Code ?? response.status} ${error?.Message ?? ""}`.trim(),
      502,
      "hunyuan_request_failed",
    );
  }
  return result;
}

const TERMINAL_FAIL = new Set(["FAIL", "FAILED"]);

/** 轮询直至 DONE（Status：WAIT/RUN/FAIL/DONE），返回查询响应（含 ResultFile3Ds） */
export async function waitForHunyuanJob(
  queryAction: "DescribeHunyuanTo3DUVJob",
  jobId: string,
  options: HunyuanCallOptions,
): Promise<Record<string, unknown>> {
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const result = await callHunyuanAction(queryAction, { JobId: jobId }, options);
    const status = String(result.Status ?? "").toUpperCase();
    await options.onStatus?.(status);
    if (status === "DONE") return result;
    if (TERMINAL_FAIL.has(status)) {
      throw new ChatServiceError(
        `混元任务失败：${result.ErrorMessage ?? status}`,
        502,
        "hunyuan_task_failed",
      );
    }
    if (Date.now() > deadline) {
      throw new ChatServiceError(
        `混元任务超时（JobId=${jobId}，可凭侧写续查）`,
        504,
        "hunyuan_timeout",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
