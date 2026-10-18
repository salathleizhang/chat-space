import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyIdentity } from "../blenderService/auth";
import { allowedProviderUrl, proxyFetch, verifiedDownload } from "./proxy";
test("credential proxy rejects destination and URL credential tricks", () => {
  for (const url of ["http://ark.cn-beijing.volces.com/api/v3/chat/completions", "https://ark.cn-beijing.volces.com.evil.test/api/v3/chat/completions", "https://user@openapi.tripo3d.ai/v3/tasks/fixture", "https://openapi.tripo3d.ai:444/v3/files", "https://openapi.tripo3d.ai/v3/account", "https://127.0.0.1/v3/files"]) expect(allowedProviderUrl(url)).toBeUndefined();
  expect(allowedProviderUrl("https://ark.cn-beijing.volces.com/api/v3/chat/completions")?.hostname).toBe("ark.cn-beijing.volces.com");
  expect(allowedProviderUrl("https://openapi.tripo3d.ai/v3/tasks/list")?.hostname).toBe("openapi.tripo3d.ai");
});
test("cross-origin proxy requests are rejected before credentials or fetch", async () => {
  const response = await proxyFetch(new Request("https://chatspace.test/api/provider?url=https://openapi.tripo3d.ai/v3/files", { method: "POST", headers: { Origin: "https://untrusted.test" } }));
  expect(response.status).toBe(403);
});
test("health does not require any database, Blob or session credential", async () => {
  const response = await proxyFetch(new Request("https://chatspace.test/api/health"));
  expect(await response.json()).toMatchObject({ ok: true, storage: "browser-local" });
});

/**
 * AI 中继的票据端点：签一张 4 分钟的 `llm` 票据，让浏览器直连 Cloudflare 的出口
 * （见 `deploy/blender-cloudflare/llmRelay.ts`）。判据是**票据能被对端验过**
 * 且带着允许的模型清单——只发一张字符串是不够的。
 */
test("AI 中继票据能被对端验过，并带着允许的模型清单", async () => {
  const serviceSecret = "fixture-blender-secret-at-least-32-characters";
  const sessionSecret = process.env.CHATSPACE_SESSION_SECRET, service = process.env.BLENDER_SERVICE_URL, blenderSecret = process.env.BLENDER_SERVICE_SECRET;
  process.env.CHATSPACE_SESSION_SECRET = "fixture-session-secret-at-least-32-characters";
  process.env.BLENDER_SERVICE_URL = "https://blender.test/";
  process.env.BLENDER_SERVICE_SECRET = serviceSecret;
  try {
    const response = await proxyFetch(new Request("https://chatspace.test/api/llm/ticket"));
    expect(response.status).toBe(200);
    const payload = await response.json() as { url: string; ticket: string; expiresAt: number };
    expect(payload.url).toBe("https://blender.test/v1/llm/");
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
    const identity = verifyIdentity(payload.ticket, serviceSecret, "llm");
    expect(identity?.owner).toMatch(/^[a-f0-9-]{36}$/);
    expect(identity?.models).toContain("glm-5-3-flash-260828");
    expect(identity?.defaultModel).toBe("glm-5-3-flash-260828");

    // 没配 Blender 服务时明确报"未配置"，而不是发一张用不了的票据。
    delete process.env.BLENDER_SERVICE_URL;
    expect((await proxyFetch(new Request("https://chatspace.test/api/llm/ticket"))).status).toBe(503);
  } finally {
    if (sessionSecret === undefined) delete process.env.CHATSPACE_SESSION_SECRET; else process.env.CHATSPACE_SESSION_SECRET = sessionSecret;
    if (service === undefined) delete process.env.BLENDER_SERVICE_URL; else process.env.BLENDER_SERVICE_URL = service;
    if (blenderSecret === undefined) delete process.env.BLENDER_SERVICE_SECRET; else process.env.BLENDER_SERVICE_SECRET = blenderSecret;
  }
});
test("signed download tickets cannot be altered or point to private hosts", () => {
  const secret = "fixture-only-session-secret";
  const ticket = (url: string) => {
    const value = Buffer.from(JSON.stringify({ url })).toString("base64url");
    return `${value}.${createHmac("sha256", secret).update(`download:${value}`).digest("base64url")}`;
  };
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb"), secret)?.pathname).toBe("/model.glb");
  expect(verifiedDownload(ticket("https://127.0.0.1/model.glb"), secret)).toBeUndefined();
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb") + "tampered", secret)).toBeUndefined();
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb"), "other-secret")).toBeUndefined();
});
