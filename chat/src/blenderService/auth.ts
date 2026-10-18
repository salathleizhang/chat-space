import { createHmac, timingSafeEqual } from "node:crypto";
export interface ServiceIdentity {
  owner: string; expires: number; scope: "api" | "desktop" | "llm"; session?: string; epoch?: number;
  /** 只对 `llm` 票据有意义：这条票据允许的模型清单与默认模型（见 llmRelay.ts）。 */
  models?: string[]; defaultModel?: string;
}
export function issueIdentity(value: ServiceIdentity, secret: string): string {
  if (secret.length < 32) throw new Error("Blender service secret must have 32 characters");
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + createHmac("sha256", secret).update("blender-v1:" + payload).digest("base64url");
}
export function verifyIdentity(token: string, secret: string, scope: ServiceIdentity["scope"], now = Date.now()): ServiceIdentity | null {
  if (secret.length < 32 || token.length > 2048) return null;
  const [payload, mac, extra] = token.split("."); if (!payload || !mac || extra) return null;
  const expected = createHmac("sha256", secret).update("blender-v1:" + payload).digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString()) as ServiceIdentity;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.owner) || identity.scope !== scope || !Number.isSafeInteger(identity.expires) || identity.expires <= now || identity.expires > now + 5 * 60_000) return null;
    if (scope === "desktop" && (!/^[a-f0-9-]{36}$/.test(identity.session ?? "") || !Number.isInteger(identity.epoch) || identity.epoch! < 1)) return null;
    return identity;
  } catch { return null; }
}
