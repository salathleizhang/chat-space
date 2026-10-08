import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const WORKSPACE_COOKIE = "__Host-chatspace-workspace";
function signature(id: string, secret: string) {
  return createHmac("sha256", secret).update(id).digest("base64url");
}
export function workspaceIdentity(cookie: string | null, secret: string) {
  if (secret.length < 32) throw new Error("CHATSPACE_SESSION_SECRET 至少需要 32 个字符");
  const raw = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(WORKSPACE_COOKIE + "="))?.slice(WORKSPACE_COOKIE.length + 1);
  const [id = "", mac = ""] = raw?.split(".") ?? [];
  const expected = signature(id, secret);
  if (/^[a-f0-9-]{36}$/.test(id) && Buffer.byteLength(mac) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { id, setCookie: undefined };
  }
  const next = randomUUID();
  return { id: next, setCookie: `${WORKSPACE_COOKIE}=${next}.${signature(next, secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` };
}
