export const LOCAL_CHAT_URL = "http://127.0.0.1:3901";

/** Production uses the deployed API; only development defaults to loopback. */
export function resolveChatBaseUrl(options: {
  configuredUrl?: string;
  production: boolean;
  pageOrigin?: string;
}): string {
  if (options.configuredUrl !== undefined) return options.configuredUrl.trim().replace(/\/+$/, "");
  if (options.production && options.pageOrigin) return options.pageOrigin;
  return LOCAL_CHAT_URL;
}

export function isLocalChatUrl(baseUrl: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
