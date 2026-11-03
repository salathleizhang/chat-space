import { expect, test } from "bun:test";
import { downloadTarget, relayArk } from "./network";

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

test("中继回包里的产物地址落进 .downloads，值仍原样交还调用方", async () => {
  const url = "https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream/chair_0.jpeg";
  const body = { data: [{ url }], _chatspaceDownloads: { [url]: "https://blender.test/v1/download?ticket=t1" } };
  const fetchFn = (async (input: RequestInfo | URL) => String(input) === "/api/llm/ticket"
    ? Response.json({ url: WORKER, ticket: "ticket-1", expiresAt: Date.now() + 240_000 })
    : Response.json(body)) as unknown as typeof fetch;
  const { store, files } = fakeStore();
  const response = await relayArk(new Request(ARK, { method: "POST", body: "{}" }), new URL(ARK), fetchFn, store);
  expect(await response.json()).toEqual(body);
  expect([...files.values()]).toEqual([JSON.stringify({ url, href: "https://blender.test/v1/download?ticket=t1" })]);
});

test("旧口径的 ticket 仍走网站的 /api/download，新口径的 href 直接用", () => {
  expect(downloadTarget({ url: "https://cdn/x", ticket: "a b" }, "https://www.junwei.cool"))
    .toBe("https://www.junwei.cool/api/download?ticket=a%20b");
  expect(downloadTarget({ url: "https://cdn/x", href: "https://blender.test/v1/download?ticket=t" }, "https://www.junwei.cool"))
    .toBe("https://blender.test/v1/download?ticket=t");
  expect(downloadTarget({ url: "https://cdn/x" }, "https://www.junwei.cool")).toBeUndefined();
});

function fakeStore() {
  const files = new Map<string, string>();
  return {
    files,
    store: {
      writeText: async (path: string, text: string) => { files.set(path, text); },
      readText: async (path: string) => files.get(path) ?? "",
      exists: async (path: string) => files.has(path),
    },
  };
}
