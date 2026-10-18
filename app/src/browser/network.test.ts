import { expect, test } from "bun:test";
import { relayArk } from "./network";

const WORKER = "https://blender.test/v1/llm/";
const ARK = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

function stub(ticket: unknown, relay = () => new Response("stream", { status: 200, headers: { "Content-Type": "text/event-stream" } })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return url === "/api/llm/ticket" ? Response.json(ticket) : relay();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test("方舟请求转到 Cloudflare 的 /v1/llm/*，凭据换成短期票据", async () => {
  const { calls, fetchFn } = stub({ url: WORKER, ticket: "ticket-1", expiresAt: Date.now() + 240_000 });
  const request = new Request(ARK, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer chatspace-server-proxy" }, body: JSON.stringify({ model: "glm-5-3-flash-260828" }) });
  const response = await relayArk(request, new URL(ARK), fetchFn);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("stream");
  expect(calls.map(call => call.url)).toEqual(["/api/llm/ticket", `${WORKER}chat/completions`]);
  const relayed = new Headers(calls[1]?.init?.headers);
  expect(relayed.get("authorization")).toBe("Bearer ticket-1");
  expect(await (calls[1]?.init?.body as Blob).text()).toContain("glm-5-3-flash-260828");
});

test("票据接口失败就报错，不静默退回旧路径", async () => {
  const fetchFn = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  await expect(relayArk(new Request(ARK, { method: "POST", body: "{}" }), new URL(ARK), fetchFn)).rejects.toThrow("AI relay ticket failed (503)");
});
