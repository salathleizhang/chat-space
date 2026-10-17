import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
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

/**
 * 自检端点是"出口到火山"这条腿唯一可测的位置（见 providerHealth.ts 的说明）。
 * 它对内要能区分"通 / 通但不可用 / 不通"，对外要能用状态码直接接监控。
 */
test("链路自检端点按判定回 200/503，并带上 cause 与耗时", async () => {
  const key = process.env.VOLC_KEY;
  process.env.VOLC_KEY = "fixture-key";
  try {
    const healthy = await proxyFetch(new Request("https://chatspace.test/api/health/llm"), {
      healthCacheMs: 0,
      fetchFn: (async () => Response.json({ error: { code: "InvalidEndpointOrModel.NotFound", message: "no such model" } }, { status: 404 })) as unknown as typeof fetch,
    });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ ok: true, reachable: true, verdict: "ok", status: 404, probeModel: "chatspace-connectivity-probe" });

    const dead = await proxyFetch(new Request("https://chatspace.test/api/health/llm"), {
      healthCacheMs: 0,
      fetchFn: (async () => { throw Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" }); }) as unknown as typeof fetch,
    });
    expect(dead.status).toBe(503);
    expect(dead.headers.get("Cache-Control")).toBe("no-store");
    expect(await dead.json()).toMatchObject({ ok: false, reachable: false, verdict: "down", code: "ECONNRESET" });
  } finally {
    if (key === undefined) delete process.env.VOLC_KEY; else process.env.VOLC_KEY = key;
  }
});

test("上游正常时原样透传状态与 body（兜底 502 不该吞掉上游的答案）", async () => {
  const key = process.env.VOLC_KEY, sessionSecret = process.env.CHATSPACE_SESSION_SECRET;
  process.env.VOLC_KEY = "fixture-key";
  process.env.CHATSPACE_SESSION_SECRET = "fixture-session-secret-at-least-32-characters";
  try {
    const response = await proxyFetch(new Request("https://chatspace.test/api/provider?url=" + encodeURIComponent("https://ark.cn-beijing.volces.com/api/v3/chat/completions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-5.3" }) }), {
      fetchFn: (async () => Response.json({ choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "ok" } }], _chatspaceDownloads: {} });
  } finally {
    if (key === undefined) delete process.env.VOLC_KEY; else process.env.VOLC_KEY = key;
    if (sessionSecret === undefined) delete process.env.CHATSPACE_SESSION_SECRET; else process.env.CHATSPACE_SESSION_SECRET = sessionSecret;
  }
});

/**
 * 2026-10-15 / 10-17 两次"出口到火山整体不通"都只留下一行
 * `Stateless provider proxy failed Error`——看不出是超时、reset 还是证书问题，也看不出耗时。
 * 这条钉住新的日志形状，同时钉住用户看到的文案没有被顺手改掉。
 */
test("兜底 502 把 cause 与耗时写进日志，且用户看到的文案不变", async () => {
  const key = process.env.VOLC_KEY, sessionSecret = process.env.CHATSPACE_SESSION_SECRET;
  process.env.VOLC_KEY = "fixture-key";
  process.env.CHATSPACE_SESSION_SECRET = "fixture-session-secret-at-least-32-characters";
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(part => typeof part === "string" ? part : String(part)).join(" ")); };
  try {
    const response = await proxyFetch(new Request("https://chatspace.test/api/provider?url=" + encodeURIComponent("https://ark.cn-beijing.volces.com/api/v3/chat/completions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), {
      fetchFn: (async () => { throw Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" }); }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: "The AI forwarding service is temporarily unavailable, please try again later" } });
    const line = logged.find(entry => entry.startsWith("Stateless provider proxy failed"));
    expect(line).toBeDefined();
    expect(line).toContain('"route":"/api/provider"');
    expect(line).toContain('"code":"ECONNRESET"');
    expect(line).toMatch(/"ms":\d+/);
    expect(line).toContain("socket connection was closed");
  } finally {
    console.error = original;
    if (key === undefined) delete process.env.VOLC_KEY; else process.env.VOLC_KEY = key;
    if (sessionSecret === undefined) delete process.env.CHATSPACE_SESSION_SECRET; else process.env.CHATSPACE_SESSION_SECRET = sessionSecret;
  }
});
