import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "./agentCompat";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const options = { instructions: "fixture", model: { modelId: "fixture", url: "https://fixture.invalid", apiKey: "marker" } };
function stream(deltas: unknown[]) {
  const encoder = new TextEncoder();
  const text = deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream({ start(controller) {
    // Split within JSON and UTF-8 boundaries, as a real network can.
    const bytes = encoder.encode(text);
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
describe("browser agent provider/tool boundary", () => {
  test("fragmented tool arguments execute with request context and feed the next model step", async () => {
    const bodies: any[] = []; const context = { project: "local" }; let execution: unknown;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return bodies.length === 1 ? stream([
        { tool_calls: [{ index: 0, id: "call-1", function: { name: "place", arguments: '{"x":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: "3}" } }] },
      ]) : stream([{ content: "摆放完成" }]);
    }) as unknown as typeof fetch;
    const agent = new Agent({ ...options, tools: { place: { inputSchema: z.object({ x: z.number() }), execute: async (args, ctx) => { execution = [args, ctx.requestContext]; return { saved: true }; } } } });
    const result = await agent.stream([{ role: "user", content: "place" }], { requestContext: context });
    const chunks = []; for await (const chunk of result.fullStream) chunks.push(chunk);
    expect(execution).toEqual([{ x: 3 }, context]);
    expect(bodies[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"saved":true}' });
    expect(chunks.at(-1)).toEqual({ type: "text-delta", payload: { text: "摆放完成" } });
  });
  test("ask-user prevents subsequent paid tool execution in the same response", async () => {
    let paid = 0;
    globalThis.fetch = (async () => stream([{ tool_calls: [
      { index: 0, id: "ask", function: { name: "ask-user", arguments: "{}" } },
      { index: 1, id: "paid", function: { name: "generate", arguments: "{}" } },
    ] }])) as unknown as typeof fetch;
    const agent = new Agent({ ...options, tools: {
      "ask-user": { inputSchema: z.object({}), execute: async () => ({ question: "confirm" }) },
      generate: { inputSchema: z.object({}), execute: async () => { paid++; } },
    } });
    const result = await agent.stream([], { requestContext: {} });
    const chunks = []; for await (const chunk of result.fullStream) chunks.push(chunk);
    expect(paid).toBe(0); expect(chunks.at(-1).payload.toolName).toBe("ask-user");
  });
  test("scene analysis rejects invalid structured output", async () => {
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: '{"count":"bad"}' } }] })) as unknown as typeof fetch;
    await expect(new Agent(options).generate([], { structuredOutput: { schema: z.object({ count: z.number() }) } })).rejects.toThrow();
  });
});

describe("思维链与上游卡死（这两条以前都会让界面长时间空白）", () => {
  test("reasoning_content 照原样转发，不再被静默丢弃", async () => {
    globalThis.fetch = (async () => stream([
      { reasoning_content: "先看场景" },
      { reasoning: "再想摆放" },
      { content: "好了" },
    ])) as unknown as typeof fetch;
    const agent = new Agent(options);
    const result = await agent.stream([{ role: "user", content: "hi" }], { requestContext: {} });
    const chunks = []; for await (const chunk of result.fullStream) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === "reasoning-delta").map((chunk) => chunk.payload.text))
      .toEqual(["先看场景", "再想摆放"]);
    // 思维链不能混进正文：正文只该有模型真正回答的那一段
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.payload.text)).toEqual(["好了"]);
  });

  test("上游连接活着但不发数据：按卡死上限失败，并在没有产出前重试", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // 第一次：连接建立、永不发字节——正是 300 秒被平台砍掉之前的真实形态
      if (calls === 1) return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } });
      return stream([{ content: "第二次成功" }]);
    }) as unknown as typeof fetch;
    const agent = new Agent({ ...options, stallTimeoutMs: 30, maxAttempts: 2 });
    const result = await agent.stream([{ role: "user", content: "hi" }], { requestContext: {} });
    const chunks = []; for await (const chunk of result.fullStream) chunks.push(chunk);
    expect(calls).toBe(2);
    expect(chunks.at(-1)).toEqual({ type: "text-delta", payload: { text: "第二次成功" } });
  });

  test("已经吐过内容就不再重试：宁可失败也不能把同一段回复发两遍", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const encoder = new TextEncoder();
      let delivered = false;
      return new Response(new ReadableStream({
        /*
          用 pull 而不是在 start 里 enqueue+error：同一个 tick 里 error 会把已经排队的
          分片一起丢掉（流进入 errored 态），那样"吐过内容"这个前提根本没建立。
        */
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "半句" } }] })}\n\n`));
            return;
          }
          controller.error(new Error("socket closed"));
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const agent = new Agent({ ...options, stallTimeoutMs: 30, maxAttempts: 3 });
    const chunks: unknown[] = [];
    const run = async () => {
      const result = await agent.stream([{ role: "user", content: "hi" }], { requestContext: {} });
      for await (const chunk of result.fullStream) chunks.push(chunk);
    };
    await expect(run()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(chunks.filter((chunk) => (chunk as { type: string }).type === "text-delta").length).toBe(1);
  });

  test("结构化输出超时会重试（这一步没有半截结果可留下）", async () => {
    let calls = 0;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise((resolve, reject) => {
      calls += 1;
      const signal = init?.signal;
      if (calls === 1) {
        // 模拟浏览器：预算到点用 abort 原因兑现这个 fetch
        signal?.addEventListener("abort", () => reject(signal.reason));
        return;
      }
      resolve(Response.json({ choices: [{ message: { content: '{"count":1}' } }] }));
    })) as unknown as typeof fetch;
    const agent = new Agent({ ...options, attemptTimeoutMs: 30, maxAttempts: 2 });
    expect(await agent.generate([], { structuredOutput: { schema: z.object({ count: z.number() }) } }))
      .toEqual({ object: { count: 1 } });
    expect(calls).toBe(2);
  });

  test("响应不合 schema 是确定性失败：绝不重试（重试就是再花一次钱拿同样的坏结果）", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: '{"count":"bad"}' } }] });
    }) as unknown as typeof fetch;
    const agent = new Agent({ ...options, maxAttempts: 3 });
    await expect(agent.generate([], { structuredOutput: { schema: z.object({ count: z.number() }) } })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("供应商明确回 4xx 也不重试", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    const agent = new Agent({ ...options, maxAttempts: 3 });
    const result = await agent.stream([{ role: "user", content: "hi" }], { requestContext: {} });
    await expect((async () => { for await (const _chunk of result.fullStream) { /* drain */ } })()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
