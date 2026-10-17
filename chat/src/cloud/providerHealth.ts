import { config } from "../config";

/**
 * 「代理 → 供应商」这一跳的连通性探针。
 *
 * 为什么需要它：2026-10-15（香港 hkg1）与 2026-10-17（大阪 kix1）各出过一次
 * **同一形态**的故障——Vercel 函数到火山的出口整体不通：函数本身健康、别的供应商
 * 也通，但每个 LLM 调用都在 ~16.5 秒后落进 `proxy.ts` 的兜底 502。两次都是用户先
 * 发现的，而且当时的日志只记了 `error.name`（"Error"，连超时还是 reset 都看不出），
 * 排查只能靠现场重测。
 *
 * 这里补两件事：
 *   ① **零成本探针**：故意发一个不存在的模型名，火山会立刻回
 *      `InvalidEndpointOrModel.NotFound`（实测 0.2–0.3 秒、不产生 token）。**拿到任何
 *      HTTP 响应就说明这一跳通**，抛错就说明不通——所以它可以每 5 分钟打一次而不花钱。
 *      注意"通"与"能用"是两件事：401/402/429/5xx 属于"通但不可用"，单独判成 degraded。
 *   ② **失败详情**：把 cause 的 `code` 与耗时一起带出来（`UND_ERR_CONNECT_TIMEOUT`、
 *      `ECONNRESET`、证书错误…），这是原来最缺的一条信息。
 */

/** 探针模型名：必须永远不是一个真实模型 ID（撞上就等于开始按 token 计费了）。 */
export const PROBE_MODEL = "chatspace-connectivity-probe";
/**
 * 探针自己的兜底预算。要**大于**实测的失败耗时（~16.5 秒），
 * 否则会把"运行时自己的连接错误"替换成我们的 abort，反而丢掉 cause。
 */
export const PROBE_TIMEOUT_MS = 25_000;

export type ProviderVerdict = "ok" | "degraded" | "down" | "unconfigured";

export interface ProviderHealth {
  /** 拿到过任何 HTTP 响应 ⇒ 传输层是通的。 */
  reachable: boolean;
  /** `ok` 才表示"这一跳通、且供应商接受了我们的凭据与额度"。 */
  ok: boolean;
  verdict: ProviderVerdict;
  provider: string;
  status?: number;
  /** 火山错误码（`InvalidEndpointOrModel.NotFound`…）或运行时错误码（`ECONNRESET`…）。 */
  code?: string;
  latencyMs: number;
  detail: string;
  checkedAt: number;
  /** 探针用的模型名，写进结果里是为了让"这次没花钱"这件事可被核对。 */
  probeModel: string;
}

/** 运行时/供应商错误的可日志形状。**只取白名单字段**，绝不把 body 或凭据带进日志。 */
export interface FailureDetail {
  name: string;
  message: string;
  code?: string;
  causeName?: string;
  causeMessage?: string;
}

export function failureDetail(error: unknown): FailureDetail {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error).slice(0, 300) };
  const detail: FailureDetail = { name: error.name, message: error.message.slice(0, 300) };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") detail.code = code;
  // undici 把 `UND_ERR_*` 放在 cause 上；Bun 把 `ECONNRESET` 放在错误自身。
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    detail.causeName = cause.name;
    detail.causeMessage = cause.message.slice(0, 300);
    const causeCode = (cause as Error & { code?: unknown }).code;
    if (typeof causeCode === "string") detail.code ??= causeCode;
  }
  return detail;
}

/** 拿到响应之后的判读：4xx 里只有"凭据/额度/限流"算不可用，其余（如模型不存在）说明链路是好的。 */
export function verdictForStatus(status: number): ProviderVerdict {
  if (status === 401 || status === 402 || status === 403) return "degraded";
  if (status === 429) return "degraded";
  if (status >= 500) return "degraded";
  return "ok";
}

export function providerHost(baseUrl: string): string {
  try { return new URL(baseUrl).hostname; } catch { return baseUrl; }
}

export interface ProbeOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  now?: () => number;
}

/** 打一次真实请求（零成本），**永不抛错**：任何异常都折成 `verdict: "down"`。 */
export async function probeProvider(options: ProbeOptions = {}): Promise<ProviderHealth> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? config.llm.defaultBaseUrl).replace(/\/+$/, "");
  const apiKey = options.apiKey ?? process.env.VOLC_KEY;
  const now = options.now ?? Date.now;
  const provider = providerHost(baseUrl);
  const startedAt = now();
  if (!apiKey) return { reachable: false, ok: false, verdict: "unconfigured", provider, latencyMs: 0, detail: "VOLC_KEY is not configured on this deployment", checkedAt: now(), probeModel: PROBE_MODEL };
  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: PROBE_MODEL, messages: [{ role: "user", content: "connectivity probe" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    const latencyMs = now() - startedAt;
    const text = await response.text().catch(() => "");
    let code: string | undefined;
    let message: string | undefined;
    try {
      const payload = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      if (typeof payload?.error?.code === "string") code = payload.error.code;
      if (typeof payload?.error?.message === "string") message = payload.error.message;
    } catch { /* 不是 JSON（网关 HTML 等）：状态码本身已经足够判定 */ }
    const verdict = verdictForStatus(response.status);
    return { reachable: true, ok: verdict === "ok", verdict, provider, status: response.status, code, latencyMs, detail: (message ?? `HTTP ${response.status}`).slice(0, 200), checkedAt: now(), probeModel: PROBE_MODEL };
  } catch (error) {
    const detail = failureDetail(error);
    return {
      reachable: false, ok: false, verdict: "down", provider,
      latencyMs: now() - startedAt,
      code: detail.code ?? detail.causeName ?? detail.name,
      detail: [detail.message, detail.causeMessage].filter(Boolean).join(" / ").slice(0, 300),
      checkedAt: now(), probeModel: PROBE_MODEL,
    };
  }
}
