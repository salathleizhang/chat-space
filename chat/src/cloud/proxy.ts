import { createHmac, timingSafeEqual } from "node:crypto";
import { config, configuredEnvLlmProviders, configuredProviders } from "../config";
import { workspaceIdentity } from "./identity";
import { forwardBlender, serviceConfigured } from "./blenderProxy";
import { failureDetail, probeProvider, type ProviderHealth } from "./providerHealth";

/** Stateless credential proxy. No project, conversation, task or asset is stored here. */
export function allowedProviderUrl(value: string): URL | undefined {
  let url: URL; try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  if (url.hostname === "ark.cn-beijing.volces.com" && /^\/api\/v3\/(chat\/completions|images\/generations|contents\/generations\/tasks(?:\/[A-Za-z0-9_-]+)?)$/.test(url.pathname)) return url;
  if (url.hostname === "openapi.tripo3d.ai" && /^\/v3\/(files(?:\/upload-credentials)?|generation\/[a-z-]+|models\/[a-z-]+|mesh\/[a-z-]+|animations\/[a-z-]+|tasks(?:\/[A-Za-z0-9_-]+|\/batch)?)$/.test(url.pathname)) return url;
  if (url.hostname === "api.worldlabs.ai" && url.pathname.startsWith("/marble/v1/")) return url;
  return;
}
function publicDownloadUrl(value: string): URL | undefined {
  let url: URL; try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  // Only artifacts on provider-controlled CDNs, never user-supplied arbitrary destinations.
  const allowed = ["volces.com", "volccdn.com", "byteimg.com", "bytecdn.cn", "tripo3d.ai", "tripo3d.com", "amazonaws.com", "worldlabs.ai", "worldlabs.io", "storage.googleapis.com"];
  return allowed.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain)) ? url : undefined;
}
function signDownload(url: string, secret: string): string {
  const value = Buffer.from(JSON.stringify({ url })).toString("base64url");
  return `${value}.${createHmac("sha256", secret).update(`download:${value}`).digest("base64url")}`;
}
export function verifiedDownload(token: string, secret: string): URL | undefined {
  const [value, mac, extra] = token.split("."); if (!value || !mac || extra || token.length > 16384) return;
  const expected = createHmac("sha256", secret).update(`download:${value}`).digest();
  const supplied = Buffer.from(mac, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return;
  try { return publicDownloadUrl(JSON.parse(Buffer.from(value, "base64url").toString()).url); } catch { return; }
}
function downloadsIn(value: unknown, secret: string, result: Record<string, string> = {}): Record<string, string> {
  if (typeof value === "string" && publicDownloadUrl(value)) result[value] = signDownload(value, secret);
  else if (value && typeof value === "object") for (const child of Object.values(value)) downloadsIn(child, secret, result);
  return result;
}
// Best-effort instance rate protection, alongside the provider account's actual quotas.
// Durable per-day global counters intentionally require external storage and are not claimed here.
const rates = new Map<string, { since: number; count: number }>();
function limited(visitor: string) {
  const now = Date.now(); let rate = rates.get(visitor);
  if (!rate || now - rate.since > 60_000) { rate = { since: now, count: 0 }; rates.set(visitor, rate); }
  if (rates.size > 10_000) for (const [key, value] of rates) if (now - value.since > 60_000) rates.delete(key);
  return ++rate.count > 120;
}
/**
 * 探针结果缓存窗口。巡检是每 5 分钟一次，这个窗口只需要挡住"有人拿这个端点刷量"；
 * 太大会把刚断掉的链路报成健康，所以取 15 秒。
 */
const HEALTH_CACHE_MS = 15_000;
let healthCache: { at: number; value: ProviderHealth } | undefined;

/** 近 `ttl` 毫秒内已经探过的结果直接复用；判定发生变化（而不是每次探测）才写日志。 */
async function cachedProviderHealth(fetchFn: typeof fetch, ttl: number): Promise<ProviderHealth> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < ttl) return healthCache.value;
  const value = await probeProvider({ fetchFn, baseUrl: config.llm.defaultBaseUrl });
  if (healthCache?.value.ok !== value.ok) console.error("Provider health probe", JSON.stringify(value));
  healthCache = { at: now, value };
  return value;
}

export interface ProxyDeps {
  /** 测试注入点；生产一律走全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 自检端点结果缓存窗口；测试传 0 表示每次真探。 */
  healthCacheMs?: number;
}

export async function proxyFetch(request: Request, deps: ProxyDeps = {}): Promise<Response> {
  const address = new URL(request.url);
  const fetchFn = deps.fetchFn ?? fetch;
  const startedAt = Date.now();
  if (address.pathname === "/api/health") return Response.json({ ok: true, service: "chatspace-chat", storage: "browser-local" });
  /*
    链路自检：在**这个函数自己的出口**上打一次零成本的火山请求。
    这是唯一能测到"Vercel 出口 → 火山"这一跳的位置——从用户电脑、从 Cloudflare
    或从 CI 测都不作数（那几条路一直是通的，坏的正是这一条）。
    可用返回 200、不可用返回 503，body 里带判定与 cause。
  */
  if (address.pathname === "/api/health/llm") {
    const health = await cachedProviderHealth(fetchFn, deps.healthCacheMs ?? HEALTH_CACHE_MS);
    return Response.json(health, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  }
  if (address.pathname === "/api/capabilities") return Response.json({ llmProviders: configuredEnvLlmProviders, providers: configuredProviders, blenderCloud: serviceConfigured() });
  const origin = request.headers.get("origin");
  if (origin && origin !== address.origin) return Response.json({ error: { message: "AI forwarding is only allowed for this site" } }, { status: 403 });
  const secret = process.env.CHATSPACE_SESSION_SECRET ?? "";
  try {
    const identity = workspaceIdentity(request.headers.get("cookie"), secret);
    let response: Response;
    if (address.pathname.startsWith("/api/blender/")) {
      response = await forwardBlender(request, identity.id);
    } else if (address.pathname === "/api/download" && ["GET", "HEAD"].includes(request.method)) {
      let target = verifiedDownload(address.searchParams.get("ticket") ?? "", secret);
      if (!target) return Response.json({ error: { message: "Invalid download ticket" } }, { status: 403 });
      const headers = new Headers(); const range = request.headers.get("range"); if (range) headers.set("Range", range);
      let upstream: Response | undefined;
      for (let redirects = 0; redirects < 4; redirects++) {
        upstream = await fetch(target, { method: request.method, headers, redirect: "manual", signal: request.signal });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const next = upstream.headers.get("location"); target = next ? publicDownloadUrl(new URL(next, target).href) : undefined;
        await upstream.body?.cancel();
        if (!target) return Response.json({ error: { message: "Provider download redirect not allowed" } }, { status: 403 });
      }
      if (!upstream || upstream.status >= 300 && upstream.status < 400) throw new Error("Too many download redirects");
      const outputHeaders = new Headers({ "Cache-Control": "no-store" });
      for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(key); if (value) outputHeaders.set(key, value);
      }
      response = new Response(upstream.body, { status: upstream.status, headers: outputHeaders });
    } else if (address.pathname === "/api/provider") {
      const target = allowedProviderUrl(address.searchParams.get("url") ?? "");
      if (!target || !["GET", "POST"].includes(request.method)) return Response.json({ error: { message: "Provider request not allowed" } }, { status: 403 });
      if (limited(identity.id)) return Response.json({ error: { message: "Too many requests, please try again later" } }, { status: 429 });
      const key = target.hostname === "openapi.tripo3d.ai" ? process.env.TRIPO_KEY : target.hostname === "api.worldlabs.ai" ? process.env.WORLDLABS_KEY : process.env.VOLC_KEY;
      if (!key) return Response.json({ error: { message: "This provider is not configured" } }, { status: 503 });
      const headers = new Headers(); const contentType = request.headers.get("content-type"); if (contentType) headers.set("content-type", contentType);
      headers.set(target.hostname === "api.worldlabs.ai" ? "WLT-Api-Key" : "Authorization", target.hostname === "api.worldlabs.ai" ? key : `Bearer ${key}`);
      let body: string | ArrayBuffer | undefined;
      if (request.method === "POST") {
        if (contentType?.includes("application/json")) {
          const input = await request.json() as Record<string, unknown>;
          if (target.pathname.endsWith("/chat/completions")) {
            const models = new Map([["glm-5.3", config.llm.glmModel], [config.llm.glmModel, config.llm.glmModel],
              [config.llm.deepseekModel, config.llm.deepseekModel], [config.llm.evolvingModel, config.llm.evolvingModel], [config.llm.proModel, config.llm.proModel]]);
            input.model = models.get(String(input.model)) ?? config.llm.defaultModel;
          }
          body = JSON.stringify(input);
        } else body = await request.arrayBuffer();
      }
      const upstream = await fetchFn(target, { method: request.method, headers, body, redirect: "error", signal: request.signal });
      if (upstream.headers.get("content-type")?.includes("application/json")) {
        const payload = await upstream.json() as Record<string, unknown>;
        const tickets = downloadsIn(payload, secret);
        response = new Response(new Blob([JSON.stringify({ ...payload, _chatspaceDownloads: tickets })], { type: "application/json" }).stream(), { status: upstream.status, headers: { "Content-Type": "application/json" } });
      } else response = new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
    } else return Response.json({ error: { message: "Projects and files are now stored locally in the browser" } }, { status: 404 });
    response.headers.set("Cache-Control", "private, no-store");
    if (identity.setCookie) response.headers.append("Set-Cookie", identity.setCookie);
    return response;
  } catch (error) {
    /*
      这条兜底文案曾经把排查拖了很久：它只记 `error.name`（结果永远是 "Error"），
      看不出是连接超时、reset 还是证书问题，也看不出耗时——2026-10-15 / 10-17 两次
      "出口到火山整体不通"因此只能靠现场重测定位。现在把白名单字段与耗时一起打成
      一行 JSON（前缀保持不变，历史日志过滤还能用）。
    */
    console.error("Stateless provider proxy failed", JSON.stringify({ route: address.pathname, ms: Date.now() - startedAt, ...failureDetail(error) }));
    return Response.json({ error: { message: "The AI forwarding service is temporarily unavailable, please try again later" } }, { status: 502 });
  }
}
