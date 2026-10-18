import { BrowserAssetStorage } from "./storage";

/**
 * AI（火山方舟）走**另一条路**：网站签一张短期票据，浏览器直连 Cloudflare Worker，
 * 由 **Cloudflare 的出口**转发到火山——不再经过 Vercel 函数的出口。
 *
 * 原因见 `deploy/blender-cloudflare/llmRelay.ts`：2026-10-15 / 10-17 / 10-18 三次实测，
 * 坏的都是「Vercel 函数出口 → 火山」这一跳（固定 ~16.5 秒后 502），而函数本身、别的
 * 供应商、火山自己、本机直连都正常。换一个出口就把这一跳整个换掉。
 *
 * 其余供应商（Tripo / World Labs）继续走网站的 `/api/provider`，那条路一直是好的。
 */
const nativeFetch = globalThis.fetch.bind(globalThis);
const ARK_ENDPOINT = /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3\//;

interface RelayTicket { url: string; ticket: string; expiresAt: number }

/** 把方舟请求转到 Cloudflare 的 `/v1/llm/*`：每次现取一张短期票据（5 分钟有效）。 */
export async function relayArk(request: Request, url: URL, fetchFn: typeof fetch = nativeFetch): Promise<Response> {
  const grant = await fetchFn("/api/llm/ticket", { credentials: "same-origin" });
  if (!grant.ok) throw new Error(`AI relay ticket failed (${grant.status})`);
  const { url: base, ticket } = await grant.json() as RelayTicket;
  const headers = new Headers(request.headers); headers.delete("authorization"); headers.delete("x-api-key"); headers.delete("WLT-Api-Key");
  headers.set("authorization", `Bearer ${ticket}`);
  return fetchFn(`${base}${url.pathname.replace(/^\/api\/v3\//, "")}${url.search}`, {
    method: request.method, headers, signal: request.signal, credentials: "omit",
    ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.blob() }) });
}

export function installProviderProxy() {
  const proxy = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url, location.origin);
    if (url.origin === location.origin || url.protocol !== "https:") return nativeFetch(request);
    // Credentials never enter the browser. The public marker only selects the server proxy.
    if (request.headers.get("authorization")?.includes("chatspace-server-proxy") || request.headers.get("x-api-key") === "chatspace-server-proxy" || request.headers.get("WLT-Api-Key") === "chatspace-server-proxy") {
      if (ARK_ENDPOINT.test(url.href)) return relayArk(request, url);
      const headers = new Headers(request.headers); headers.delete("authorization"); headers.delete("x-api-key"); headers.delete("WLT-Api-Key");
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.blob();
      const response = await nativeFetch(`${location.origin}/api/provider?url=${encodeURIComponent(url.href)}`, {
        method: request.method, headers, body, signal: request.signal, credentials: "same-origin" });
      if (response.headers.get("content-type")?.includes("application/json")) {
        const payload = await response.clone().json() as { _chatspaceDownloads?: Record<string, string> };
        const storage = new BrowserAssetStorage();
        await Promise.all(Object.entries(payload._chatspaceDownloads ?? {}).map(async ([url, ticket]) => {
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          await storage.writeText(`.downloads/${hash}.json`, JSON.stringify({ url, ticket }));
        }));
      }
      return response;
    }
    // Provider-signed STS uploads go directly from this device to the provider.
    try { return await nativeFetch(request); }
    catch (error) {
      if (request.signal.aborted || !["GET", "HEAD"].includes(request.method)) throw error;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const storage = new BrowserAssetStorage();
      if (!await storage.exists(`.downloads/${hash}.json`)) throw error;
      const { ticket } = JSON.parse(await storage.readText(`.downloads/${hash}.json`)) as { ticket: string };
      return nativeFetch(`${location.origin}/api/download?ticket=${encodeURIComponent(ticket)}`, { method: request.method, headers: request.headers, signal: request.signal });
    }
  };
  globalThis.fetch = Object.assign(proxy, nativeFetch) as typeof fetch;
}
