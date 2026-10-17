import { beforeEach, expect, test, vi } from "vitest";
import { ALERT_REPEAT_MS, LLM_PROBE_CRON, runLlmProbe, scheduledKind } from "./llmProbe";
import worker from "./worker";

const HEALTH_URL = "https://chatspace.test/api/health/llm";
const WEBHOOK = "https://alerts.test/hook";

const healthy = { ok: true, reachable: true, verdict: "ok", provider: "ark.cn-beijing.volces.com", status: 404, code: "InvalidEndpointOrModel.NotFound", latencyMs: 310, detail: "no such model" };
const down = { ok: false, reachable: false, verdict: "down", provider: "ark.cn-beijing.volces.com", latencyMs: 16_512, code: "ECONNRESET", detail: "The socket connection was closed unexpectedly" };

/** 每个用例都从干净的缓存状态开始——去重状态存在 Cache API 里，会跨用例留下痕迹。 */
beforeEach(async () => { await caches.default.delete("https://chatspace-internal.invalid/llm-route-state"); });

/**
 * 时钟必须**跨用例单调前进**，而且每步都要跨过告警静默窗口：去重状态在缓存不可用时
 * 会退回进程内变量，时间往回走会让后面的用例读到上一条用例的"刚报过"。
 */
let clock = 1_000;
const tick = () => (clock += ALERT_REPEAT_MS * 2 + 1);

function stub(routes: { health: () => Response | Promise<Response> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === HEALTH_URL) return await routes.health();
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const alerts = (calls: { url: string }[]) => calls.filter(call => call.url === WEBHOOK);

test("链路健康时不打扰任何人", async () => {
  const { calls, fetchFn } = stub({ health: () => Response.json(healthy) });
  const run = await runLlmProbe({ LLM_HEALTH_URL: HEALTH_URL, LLM_ALERT_WEBHOOK: WEBHOOK } as Env, { fetchFn, now: tick() });
  expect(run.alerted).toBe("none");
  expect(alerts(calls)).toHaveLength(0);
});

test("链路不通时推一条带 cause 与耗时的告警，30 分钟内不重复推", async () => {
  const { calls, fetchFn } = stub({ health: () => Response.json(down, { status: 503 }) });
  const env = { LLM_HEALTH_URL: HEALTH_URL, LLM_ALERT_WEBHOOK: WEBHOOK } as Env;
  const base = tick();
  const first = await runLlmProbe(env, { fetchFn, now: base });
  expect(first.alerted).toBe("down");
  const body = JSON.parse(String(alerts(calls)[0].init?.body)) as { text: string };
  expect(body.text).toContain("AI 链路不可用");
  expect(body.text).toContain("ECONNRESET");
  expect(body.text).toContain("16512ms");

  const second = await runLlmProbe(env, { fetchFn, now: base + ALERT_REPEAT_MS - 1 });
  expect(second.alerted).toBe("suppressed");
  expect(alerts(calls)).toHaveLength(1);

  const third = await runLlmProbe(env, { fetchFn, now: base + ALERT_REPEAT_MS + 1 });
  expect(third.alerted).toBe("down");
  expect(alerts(calls)).toHaveLength(2);
});

test("恢复时补一条通知，并把状态翻回健康（此后不再重复）", async () => {
  let response: () => Response = () => Response.json(down, { status: 503 });
  const { calls, fetchFn } = stub({ health: () => response() });
  const env = { LLM_HEALTH_URL: HEALTH_URL, LLM_ALERT_WEBHOOK: WEBHOOK } as Env;
  expect((await runLlmProbe(env, { fetchFn, now: tick() })).alerted).toBe("down");
  response = () => Response.json(healthy);
  const recovered = await runLlmProbe(env, { fetchFn, now: tick() });
  expect(recovered.alerted).toBe("recovered");
  expect(JSON.parse(String(alerts(calls)[1].init?.body)).text).toContain("已恢复");
  expect((await runLlmProbe(env, { fetchFn, now: tick() })).alerted).toBe("none");
  expect(alerts(calls)).toHaveLength(2);
});

test("自检端点本身连不上也算链路故障（网站挂了比火山挂了更该知道）", async () => {
  const { calls, fetchFn } = stub({ health: () => { throw new Error("network unreachable"); } });
  const run = await runLlmProbe({ LLM_HEALTH_URL: HEALTH_URL, LLM_ALERT_WEBHOOK: WEBHOOK } as Env, { fetchFn, now: tick() });
  expect(run.alerted).toBe("down");
  expect(JSON.parse(String(alerts(calls)[0].init?.body)).text).toContain("自检端点不可达");
});

test("没配 webhook 时只写日志、不抛错（判据仍然可用）", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { fetchFn } = stub({ health: () => Response.json(down, { status: 503 }) });
    expect((await runLlmProbe({ LLM_HEALTH_URL: HEALTH_URL } as Env, { fetchFn, now: tick() })).alerted).toBe("down");
    expect(logged.mock.calls.some(call => String(call[0]).includes("LLM route probe failed"))).toBe(true);
    expect(logged.mock.calls.some(call => String(call[0]).includes("no LLM_ALERT_WEBHOOK configured"))).toBe(true);
  } finally { logged.mockRestore(); }
});

/**
 * 去重状态寄存在 Cache API 上——如果这个绑定在 workerd 里不成立，`put` 会静默失败、
 * 退回进程内变量，长时间故障就会每 5 分钟推一条。这条钉住"寄存真的落地了"，
 * 而不是只钉住我们自己的分支逻辑。
 */
test("告警去重状态确实存在 Cache API 里（不是靠进程内变量兜着）", async () => {
  const url = "https://chatspace-internal.invalid/llm-route-state";
  await caches.default.put(url, Response.json({ ok: false, at: 42 }, { headers: { "Cache-Control": "max-age=86400" } }));
  const hit = await caches.default.match(url);
  expect(hit).toBeDefined();
  expect(await hit?.json()).toEqual({ ok: false, at: 42 });
});

test("Cron 分派：五分钟那条做巡检，分钟级那条不动巡检", async () => {
  expect(scheduledKind(LLM_PROBE_CRON)).toBe("llm-probe");
  expect(scheduledKind("* * * * *")).toBe("pool");

  const { calls, fetchFn } = stub({ health: () => Response.json(healthy) });
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(fetchFn);
  try {
    await worker.scheduled({ cron: LLM_PROBE_CRON } as ScheduledController, { LLM_HEALTH_URL: HEALTH_URL } as Env);
    expect(calls.map(call => call.url)).toEqual([HEALTH_URL]);
    calls.length = 0;
    // 分钟级事件只唤醒资源池；测试绑定下池子未配置，这里只断言它**没有**去打自检端点。
    await worker.scheduled({ cron: "* * * * *" } as ScheduledController, { LLM_HEALTH_URL: HEALTH_URL } as Env).catch(() => {});
    expect(calls).toHaveLength(0);
  } finally { network.mockRestore(); }
});
