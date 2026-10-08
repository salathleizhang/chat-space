import { BrowserAssetStorage } from "./storage";
const nativeFetch = globalThis.fetch.bind(globalThis);
export function installProviderProxy() {
  const proxy = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url, location.origin);
    if (url.origin === location.origin || url.protocol !== "https:") return nativeFetch(request);
    // Credentials never enter the browser. The public marker only selects the server proxy.
    if (request.headers.get("authorization")?.includes("chatspace-server-proxy") || request.headers.get("x-api-key") === "chatspace-server-proxy" || request.headers.get("WLT-Api-Key") === "chatspace-server-proxy") {
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
