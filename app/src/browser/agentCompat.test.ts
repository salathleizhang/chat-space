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
