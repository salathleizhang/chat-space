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
 *
 * 产物（图片/视频/模型）也走这里取：方舟把结果放在**不发 CORS** 的 TOS 桶上，
 * 浏览器直连必失败，所以回包里附带 `/v1/download` 的签名链接（见下方 `downloadsIn`）。
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
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, range",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/*
  产物下载：方舟把图片/视频/模型放在 `*.tos-cn-beijing.volces.com` 这类 CDN 上，
  而那个桶**不发 `Access-Control-Allow-Origin`**（2026-11-03 实测：GET 200、无该头）。
  浏览器里的 Worker 直连必然 `TypeError: Failed to fetch`，于是「图生成出来了、却落不了盘」。
  Vercel 的 `/api/provider` 分支会为响应里的产物地址签下载票据，但方舟请求走的是本中继
  （见文件头），**拿不到那些票据**——这就是 2026-11-03 那两条 `Failed: generating image` 的根因。
  所以票据在这里签、产物也由这里取：凡是中继回包里出现供应商 CDN 地址，就附带
  `_chatspaceDownloads`（值是可直连的完整地址），浏览器存下来，直连被跨域拦下时改走 `/v1/download`。
*/
const ARTIFACT_HOSTS = ["volces.com", "volccdn.com", "byteimg.com", "bytecdn.cn", "worldlabs.ai", "worldlabs.io", "tripo3d.ai", "tripo3d.com", "storage.googleapis.com", "amazonaws.com"];

/** 只认供应商自己的 CDN；用户给的任意地址一律不签。 */
export function artifactUrl(value: string): URL | undefined {
  let url: URL; try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  return ARTIFACT_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url : undefined;
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")), char => char.charCodeAt(0));
}

async function downloadSignature(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`download:${value}`)));
}

/** 票据一天有效：方舟产物的预签名地址本身也只有 24 小时。 */
export const DOWNLOAD_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export async function signDownloadTicket(url: string, secret: string, now = Date.now()): Promise<string | undefined> {
  if (secret.length < 16 || !artifactUrl(url)) return;
  const value = base64url(new TextEncoder().encode(JSON.stringify({ url, exp: now + DOWNLOAD_TICKET_TTL_MS })));
  return `${value}.${base64url(await downloadSignature(secret, value))}`;
}

export async function verifiedDownloadTicket(ticket: string, secret: string, now = Date.now()): Promise<URL | undefined> {
  if (secret.length < 16 || ticket.length > 16384) return;
  const [value, mac, extra] = ticket.split(".");
  if (!value || !mac || extra) return;
  const expected = await downloadSignature(secret, value);
  let supplied: Uint8Array; try { supplied = fromBase64url(mac); } catch { return; }
  if (expected.length !== supplied.length) return;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected[index]! ^ supplied[index]!;
  if (diff !== 0) return;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as { url?: unknown; exp?: unknown };
    if (typeof payload.exp !== "number" || payload.exp < now) return;
    return typeof payload.url === "string" ? artifactUrl(payload.url) : undefined;
  } catch { return; }
}

/** 递归找出回包里的供应商产物地址，签成 `_chatspaceDownloads`（地址 → 本中继的下载链接）。 */
export async function downloadsIn(value: unknown, secret: string, origin: string, result: Record<string, string> = {}): Promise<Record<string, string>> {
  if (typeof value === "string") {
    const ticket = await signDownloadTicket(value, secret);
    if (ticket) result[value] = `${origin}/v1/download?ticket=${encodeURIComponent(ticket)}`;
  } else if (value && typeof value === "object") for (const child of Object.values(value)) await downloadsIn(child, secret, origin, result);
  return result;
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
    // JSON 回包里带产物地址时补上本中继的下载链接；SSE 流照旧原样透传。
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const payload = await response.json() as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const downloads = await downloadsIn(payload, env.BLENDER_SERVICE_SECRET ?? "", new URL(request.url).origin);
        return relayJson(Object.keys(downloads).length ? { ...payload, _chatspaceDownloads: downloads } : payload, response.status, cors);
      }
      return relayJson(payload, response.status, cors);
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

/**
 * 取一件供应商产物：票据在 URL 里（和 Vercel 的 `/api/download` 同一形状），
 * 不受 `Authorization` 约束——`<img src>` / Range 续传这类请求带不了自定义头。
 * 只取票据里那一个地址、且只认供应商 CDN，所以它不是一个开放代理。
 */
export async function relayDownload(request: Request, env: Env, options: RelayOptions = {}): Promise<Response> {
  const cors = relayCors(env, request.headers.get("origin"));
  if (!cors) return relayJson({ error: { message: "Origin not allowed" } }, 403, {});
  if (!["GET", "HEAD"].includes(request.method)) return relayJson({ error: { message: "Method not allowed" } }, 405, cors);
  let target = await verifiedDownloadTicket(new URL(request.url).searchParams.get("ticket") ?? "", env.BLENDER_SERVICE_SECRET ?? "");
  if (!target) return relayJson({ error: { message: "Invalid download ticket" } }, 403, cors);
  const headers = new Headers(); const range = request.headers.get("range"); if (range) headers.set("Range", range);
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response | undefined;
  for (let hops = 0; hops < 4; hops += 1) {
    response = await fetchFn(target, { method: request.method, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get("location");
    await response.body?.cancel();
    target = next ? artifactUrl(new URL(next, target).href) : undefined;
    if (!target) return relayJson({ error: { message: "Provider download redirect not allowed" } }, 403, cors);
  }
  if (!response || (response.status >= 300 && response.status < 400)) return relayJson({ error: { message: "Too many download redirects" } }, 502, cors);
  const output = new Headers({ "Cache-Control": "no-store", ...cors });
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = response.headers.get(key); if (value) output.set(key, value);
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output });
}
