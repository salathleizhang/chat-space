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

/**
 * `.downloads/<hash>.json`：直连供应商 CDN 被跨域拦下时的退路。
 * `href` 是完整地址（方舟中继自签，见 `deploy/blender-cloudflare/llmRelay.ts`），
 * `ticket` 是 Vercel `/api/download` 的旧口径（`/api/provider` 那条路仍在用）。
 */
export interface DownloadRecord { url: string; href?: string; ticket?: string }

async function downloadRecordPath(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `.downloads/${hash}.json`;
}

type DownloadStore = Pick<BrowserAssetStorage, "writeText" | "readText" | "exists">;

/** 记下这份回包里可下载的产物：`href` 已经是完整地址，`ticket` 留给网站拼 `/api/download`。 */
export async function rememberDownloads(entries: Record<string, string>, storage: DownloadStore): Promise<void> {
  await Promise.all(Object.entries(entries).map(async ([url, value]) => {
    // 键必须与下载时那个 `url.href` 一致（URL 规范化过），否则回填查不到记录。
    let normalized: string; try { normalized = new URL(url).href; } catch { return; }
    const record: DownloadRecord = { url: normalized, ...(/^https:\/\//i.test(value) ? { href: value } : { ticket: value }) };
    await storage.writeText(await downloadRecordPath(normalized), JSON.stringify(record));
  }));
}

/** 记录指向哪里取：`href` 直接可用；旧口径的 `ticket` 由网站的 `/api/download` 换。 */
export function downloadTarget(record: DownloadRecord, origin: string): string | undefined {
  if (record.href) return record.href;
  return record.ticket ? `${origin}/api/download?ticket=${encodeURIComponent(record.ticket)}` : undefined;
}

/** 把中继回包里的 `_chatspaceDownloads` 落进本地库，再把回包**原样**交还给调用方。 */
export async function keepRelayDownloads(response: Response, storage: DownloadStore): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  let payload: { _chatspaceDownloads?: Record<string, string> };
  try { payload = await response.clone().json() as typeof payload; } catch { return response; }
  await rememberDownloads(payload._chatspaceDownloads ?? {}, storage);
  return response;
}

/** 把方舟请求转到 Cloudflare 的 `/v1/llm/*`：每次现取一张短期票据（5 分钟有效）。 */
export async function relayArk(request: Request, url: URL, fetchFn: typeof fetch = nativeFetch, storage: DownloadStore = new BrowserAssetStorage()): Promise<Response> {
  const grant = await fetchFn("/api/llm/ticket", { credentials: "same-origin" });
  if (!grant.ok) throw new Error(`AI relay ticket failed (${grant.status})`);
  const { url: base, ticket } = await grant.json() as RelayTicket;
  const headers = new Headers(request.headers); headers.delete("authorization"); headers.delete("x-api-key"); headers.delete("WLT-Api-Key");
  headers.set("authorization", `Bearer ${ticket}`);
  const response = await fetchFn(`${base}${url.pathname.replace(/^\/api\/v3\//, "")}${url.search}`, {
    method: request.method, headers, signal: request.signal, credentials: "omit",
    ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.blob() }) });
  return keepRelayDownloads(response, storage);
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
        await rememberDownloads(payload._chatspaceDownloads ?? {}, new BrowserAssetStorage());
      }
      return response;
    }
    // Provider-signed STS uploads go directly from this device to the provider.
    try { return await nativeFetch(request); }
    catch (error) {
      if (request.signal.aborted || !["GET", "HEAD"].includes(request.method)) throw error;
      const storage = new BrowserAssetStorage();
      const recordPath = await downloadRecordPath(url.href);
      if (!await storage.exists(recordPath)) throw error;
      const record = JSON.parse(await storage.readText(recordPath)) as DownloadRecord;
      // `href` 是完整地址（方舟中继）；`ticket` 走网站的 `/api/download`。两条都不需要凭据。
      const href = downloadTarget(record, location.origin);
      if (!href) throw error;
      return nativeFetch(href, { method: request.method, headers: request.headers, signal: request.signal });
    }
  };
  globalThis.fetch = Object.assign(proxy, nativeFetch) as typeof fetch;
}
