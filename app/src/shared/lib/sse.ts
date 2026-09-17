const localProductionOrigin =
  import.meta.env.PROD &&
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? window.location.origin
    : undefined;

export const CHAT_BASE_URL =
  (import.meta.env.VITE_CHAT_URL as string | undefined) ??
  localProductionOrigin ??
  "http://127.0.0.1:3901";

/** 把 fetch 层异常翻译成用户可读提示；chat 服务未启动时浏览器抛的是无信息量的 "Failed to fetch" */
export function toFriendlyErrorMessage(err: unknown): string {
  return err instanceof Error && err.message === "Failed to fetch"
    ? "无法连接本机 Chatspace 服务，请确认已运行 bun run start 或 bun run dev:local"
    : err instanceof Error
      ? err.message
      : String(err);
}

/** 对 chat 服务发起请求，网络层异常（服务未启动等）翻译为友好提示后抛出 */
export async function chatFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${CHAT_BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(toFriendlyErrorMessage(err));
  }
}

/** 统一读取 chat 的 `{error:{message}}` 错误体；坏 JSON 仍保留调用方给出的状态码文案。 */
export async function chatResponseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(body?.error?.message ?? fallback);
}
