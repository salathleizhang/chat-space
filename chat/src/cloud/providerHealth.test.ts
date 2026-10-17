import { expect, test } from "bun:test";
import { PROBE_MODEL, failureDetail, probeProvider, verdictForStatus } from "./providerHealth";

/** 记录探针实际发出去的东西——"零成本"这条不变量必须能被核对。 */
function recorder(response: () => Response | Promise<Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return await response();
  }) as typeof fetch;
  return { seen, fetchFn };
}

/** 可预测的时钟：每次调用 +100ms，用来断言 latencyMs 真被量了。 */
function clock() { let value = 0; return () => (value += 100); }

test("探针用不存在的模型名换连通性，并明确标注没有真实模型被调用", async () => {
  const { seen, fetchFn } = recorder(() => Response.json({ error: { code: "InvalidEndpointOrModel.NotFound", message: "The model or endpoint … does not exist" } }, { status: 404 }));
  const health = await probeProvider({ fetchFn, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "fixture-key", now: clock() });
  expect(health).toMatchObject({ reachable: true, ok: true, verdict: "ok", provider: "ark.cn-beijing.volces.com", status: 404, code: "InvalidEndpointOrModel.NotFound", probeModel: PROBE_MODEL, latencyMs: 100 });
  expect(seen).toHaveLength(1);
  const [sent] = seen;
  expect(sent?.url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  const body = JSON.parse(String(sent?.init?.body));
  expect(body.model).toBe(PROBE_MODEL);
  expect(body.max_tokens).toBe(1);
  expect(new Headers(sent?.init?.headers).get("Authorization")).toBe("Bearer fixture-key");
});

test("连得上但不可用（凭据/额度/限流/供应商 5xx）判成 degraded，不当作健康", async () => {
  for (const [status, expected] of [[401, "degraded"], [402, "degraded"], [429, "degraded"], [503, "degraded"]] as const) {
    const { fetchFn } = recorder(() => Response.json({ error: { code: "AuthenticationError" } }, { status }));
    const health = await probeProvider({ fetchFn, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k" });
    expect(health).toMatchObject({ reachable: true, ok: false, verdict: expected, status, code: "AuthenticationError" });
  }
  // 判定表本身也钉住：4xx 里只有这三类 + 429 不是"链路健康"。
  expect(verdictForStatus(400)).toBe("ok");
  expect(verdictForStatus(404)).toBe("ok");
  expect(verdictForStatus(403)).toBe("degraded");
});

test("连接层失败判成 down，并把运行时的码带出来（Bun 放在错误自身、undici 放在 cause）", async () => {
  const bunStyle = Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
  const { fetchFn } = recorder(() => { throw bunStyle; });
  const down = await probeProvider({ fetchFn, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k", now: clock() });
  expect(down).toMatchObject({ reachable: false, ok: false, verdict: "down", code: "ECONNRESET", latencyMs: 100 });
  expect(down.detail).toContain("socket connection was closed");

  const undiciStyle = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  const second = await probeProvider({ fetchFn: recorder(() => { throw undiciStyle; }).fetchFn, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k" });
  expect(second).toMatchObject({ verdict: "down", code: "UND_ERR_CONNECT_TIMEOUT", detail: "fetch failed / Connect Timeout Error" });
});

test("没有凭据时报 unconfigured，而不是伪装成链路不通", async () => {
  const { seen, fetchFn } = recorder(() => Response.json({}));
  const health = await probeProvider({ fetchFn, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "" });
  expect(health).toMatchObject({ reachable: false, ok: false, verdict: "unconfigured", latencyMs: 0 });
  expect(seen).toHaveLength(0);
});

test("failureDetail 只取白名单字段，不把响应体或凭据带进日志", () => {
  expect(failureDetail(Object.assign(new Error("boom"), { code: "ECONNRESET", body: "secret" })))
    .toEqual({ name: "Error", message: "boom", code: "ECONNRESET" });
  expect(failureDetail("not an error")).toEqual({ name: "string", message: "not an error" });
});
