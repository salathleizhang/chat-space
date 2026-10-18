import type { ServiceIdentity } from "../../chat/src/blenderService/auth";

/**
 * 火山方舟中继：浏览器（或浏览器里的 Worker）直连 Cloudflare，由 Cloudflare 的出口
 * 转发到火山，**不再经过 Vercel 函数的出口**。
 *
 * 为什么要有这一跳（2026-10-15 / 10-17 / 10-18 三次实测）：Vercel 函数到
 * `ark.cn-beijing.volces.com` 这条跨境链路会整条不通——函数本身健康、别的供应商也通、
 * 火山也健康，但每个 LLM 调用都在固定 ~16.5 秒后失败（10-18 13:54 复测：生产 → 火山
 * 三次全部 502、15.6–15.9 秒，同一刻本机直连火山 0.10 秒）。换区域只是换一条会坏的远路。
 *
 * 认证沿用网站已有的短期票据机制（`issueIdentity`，Vercel 侧签发、5 分钟内有效）：
 * 浏览器拿到票据才能用这里的出口，票据里同时带着允许的模型清单，所以这个中继不是开放代理。
 */

/** 只有这几条方舟路径能过；其余一律 404——不做开放代理。 */
export function arkUpstream(path: string): string | undefined {
  const rest = /^\/v1\/llm(\/.*)$/.exec(path)?.[1];
  if (!rest || !/^\/(chat\/completions|images\/generations|contents\/generations\/tasks(?:\/[A-Za-z0-9_-]+)?)$/.test(rest)) return;
  return `https://ark.cn-beijing.volces.com/api/v3${rest}`;
}

/** 请求体上限：方舟的对话请求带 base64 图片，但也不该无上限地收。 */
export const RELAY_BODY_LIMIT = 16 * 1024 * 1024;
/** 单次转发预算：与浏览器侧一次 AI 尝试的预算同量级（流式长回答要留够）。 */
export const RELAY_BUDGET_MS = 300_000;

/** 跨域只允许网站自己的源（`BLENDER_FRAME_ORIGINS`，与桌面 iframe 同一份清单）。 */
export function relayCors(env: Env, origin: string | null): Record<string, string> | undefined {
  const allowed = (env.BLENDER_FRAME_ORIGINS ?? "").split(/\s+/).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/**
 * 模型归一：票据里签过名的清单之外一律落到默认模型。
 * 这条与 Vercel 侧 `/api/provider` 原来的口径一致——票据是任何人都能拿到的，
 * 不归一就等于把账号里的任意模型开放出去。
 */
export function modelForRequest(requested: unknown, identity: ServiceIdentity): string | undefined {
  return typeof requested === "string" && (identity.models ?? []).includes(requested) ? requested : identity.defaultModel;
}

function relayJson(body: unknown, status: number, cors: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...cors } });
}

export interface RelayOptions { fetchFn?: typeof fetch }

/** 转发一次方舟请求。票据已由调用方验过（`verifyIdentity(..., "llm")`）。 */
export async function relayArk(request: Request, env: Env, identity: ServiceIdentity, options: RelayOptions = {}): Promise<Response> {
  const cors = relayCors(env, request.headers.get("origin"));
  if (!cors) return relayJson({ error: { message: "Origin not allowed" } }, 403, {});
  const upstream = arkUpstream(new URL(request.url).pathname);
  if (!upstream) return relayJson({ error: { message: "LLM route not allowed" } }, 404, cors);
  const key = env.VOLC_KEY;
  if (!key) return relayJson({ error: { message: "AI provider is not configured" } }, 503, cors);
  let body: string;
  try {
    const bytes = await new Response(request.body).arrayBuffer();
    if (bytes.byteLength > RELAY_BODY_LIMIT) return relayJson({ error: { message: "Request too large" } }, 413, cors);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (upstream.endsWith("/chat/completions")) payload.model = modelForRequest(payload.model, identity);
    body = JSON.stringify(payload);
  } catch { return relayJson({ error: { message: "Request body must be JSON" } }, 400, cors); }
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(upstream, {
      // workerd 的 fetch 不接受 `redirect: "error"`（实测报 Invalid redirect value），
      // 用 "manual" 自己把 3xx 当失败处理——与 Vercel 侧原来拒重定向的意图一致。
      method: "POST", redirect: "manual", body,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(RELAY_BUDGET_MS)]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return relayJson({ error: { message: "AI provider redirect not allowed" } }, 502, cors);
    }
    // 原样透传（含 SSE 流）：应用侧解析的就是方舟的响应。
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
        ...cors,
      },
    });
  } catch (error) {
    return relayJson({ error: { message: error instanceof Error ? error.message : "AI relay failed" } }, 502, cors);
  }
}
