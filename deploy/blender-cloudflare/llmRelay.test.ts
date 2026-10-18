import { expect, test, vi } from "vitest";
import { arkUpstream, modelForRequest, relayArk, type RelayOptions } from "./llmRelay";
import { issueIdentity } from "../../chat/src/blenderService/auth";

const SECRET = "fixture-controller-secret-never-production-12345";
const ORIGIN = "https://www.junwei.cool";
const identity = (extra: Record<string, unknown> = {}) => ({ owner: "11111111-2222-3333-4444-555555555555", scope: "llm" as const, expires: Date.now() + 240_000, models: ["glm-5-3-flash-260828"], defaultModel: "glm-5-3-flash-260828", ...extra });
const env = () => ({ BLENDER_FRAME_ORIGINS: `${ORIGIN} https://chat-space-app.vercel.app`, VOLC_KEY: "fixture-model-key" }) as unknown as Env;
const arkRequest = (path = "/v1/llm/chat/completions") => new Request(`https://blender.test${path}`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-260828", messages: [] }) });

test("只放行方舟的几条路径，其余不做开放代理", () => {
  expect(arkUpstream("/v1/llm/chat/completions")).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  expect(arkUpstream("/v1/llm/contents/generations/tasks/task-1")).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1");
  for (const path of ["/v1/llm/account", "/v1/llm/chat/completions/../account", "/v1/sessions", "/llm/chat/completions", "/v1/llm/"]) expect(arkUpstream(path)).toBeUndefined();
});

test("跨域只放行网站自己的源", async () => {
  const relayed = { fetchFn: (async () => Response.json({ ok: true })) as unknown as typeof fetch } as RelayOptions;
  expect((await relayArk(arkRequest(), env(), identity(), relayed)).status).toBe(200);
  const crossOrigin = new Request("https://blender.test/v1/llm/chat/completions", { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" });
  expect((await relayArk(crossOrigin, env(), identity(), relayed)).status).toBe(403);
  const noOrigin = new Request("https://blender.test/v1/llm/chat/completions", { method: "POST", body: "{}" });
  expect((await relayArk(noOrigin, env(), identity(), relayed)).status).toBe(403);
});

test("票据清单之外的模型落回默认模型（与 Vercel 侧原来的口径一致）", () => {
  expect(modelForRequest("glm-5-3-flash-260828", identity())).toBe("glm-5-3-flash-260828");
  expect(modelForRequest("some-other-model", identity())).toBe("glm-5-3-flash-260828");
  expect(modelForRequest(undefined, identity())).toBe("glm-5-3-flash-260828");
  expect(modelForRequest("anything", identity({ models: [], defaultModel: undefined }))).toBeUndefined();
});

test("转发用 Cloudflare 的出口与自己的密钥，并原样透传响应", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("data: chunk", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const response = await relayArk(arkRequest(), env(), identity(), { fetchFn } as RelayOptions);
  expect(calls[0]?.url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  const sent = new Headers(calls[0]?.init?.headers);
  expect(sent.get("authorization")).toBe("Bearer fixture-model-key");
  expect(String(calls[0]?.init?.body)).toContain("glm-5-3-flash-260828");
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(await response.text()).toBe("data: chunk");
});

test("上游重定向不当跳转（workerd 不接受 redirect:\"error\"，实测过）", async () => {
  const fetchFn = (async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })) as unknown as typeof fetch;
  const response = await relayArk(arkRequest(), env(), identity(), { fetchFn } as RelayOptions);
  expect(response.status).toBe(502);
});

test("没配模型密钥时明确报未配置", async () => {
  const response = await relayArk(arkRequest(), { BLENDER_FRAME_ORIGINS: ORIGIN } as unknown as Env, identity(), {});
  expect(response.status).toBe(503);
});

/** 票据是网站签的：这里用同一把共享密钥签一张，验的是"两端口径一致"。 */
test("网站签的 llm 票据能被这里验过", async () => {
  const { verifyIdentity } = await import("../../chat/src/blenderService/auth");
  const ticket = issueIdentity(identity(), SECRET);
  expect(verifyIdentity(ticket, SECRET, "llm")?.owner).toBe("11111111-2222-3333-4444-555555555555");
  // 作用域不对的票据（api / desktop）不能当中继票据用。
  expect(verifyIdentity(issueIdentity(identity(), SECRET), SECRET, "api")).toBeNull();
  expect(verifyIdentity(ticket, SECRET, "llm", Date.now() + 5 * 60_000)).toBeNull();
  void vi;
});
