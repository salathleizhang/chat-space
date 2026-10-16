import { expect, test } from "bun:test";
import { BlenderPlannerError, volcanoPlanner } from "./batchRunner";
const messages = [{ role: "user" as const, content: "Make a bronze figurine" }];
const valid = { action: "tool", tool: "get_addon_status", arguments: {} } as const;
function fixture(data: unknown, observe?: (body: Record<string, unknown>) => void): typeof fetch {
  return (async (_url, init) => { observe?.(JSON.parse(String(init?.body))); return Response.json(data); }) as typeof fetch;
}
function reply(content: unknown = JSON.stringify(valid), finish_reason = "stop", total_tokens: unknown = 100) {
  return { choices: [{ finish_reason, message: { content } }], usage: { total_tokens } };
}
test("GLM Flash's bounded single-step planner uses supported low effort without changing other models", async () => {
  for (const model of ["glm-5-3-flash-260828", "other-model"]) {
    let body!: Record<string, unknown>;
    const result = await volcanoPlanner("fake-key", model, fixture(reply(), value => { body = value; }))(messages);
    expect(result).toEqual({ decision: valid, tokens: 100 });
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe(model.startsWith("glm-5-3-flash-") ? "low" : undefined);
  }
});
test("HTTP rejections preserve status, never raw provider secrets, and are not retried", async () => {
  let calls = 0;
  const request = (async () => { calls++; return new Response("private-provider-body fake-key", { status: 429 }); }) as unknown as typeof fetch;
  try { await volcanoPlanner("fake-key", "model", request)(messages); throw new Error("Expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(BlenderPlannerError); expect((error as Error).message).toBe("planning_http_429"); }
  expect(calls).toBe(1);
});
test("truncated thinking, empty decisions, invalid output and missing usage remain distinguishable", async () => {
  const cases = [
    [reply("", "length", 4096), "planning_output_truncated", 4096],
    [reply(null), "planning_empty_response", 100],
    [reply("   "), "planning_empty_response", 100],
    [reply("private invalid JSON"), "planning_invalid_json", 100],
    [reply('{"action":"tool","tool":"unknown","arguments":{}}'), "planning_invalid_decision", 100],
    [reply(JSON.stringify(valid), "stop", null), "planning_usage_missing", 0],
    [null, "planning_empty_response", 0],
  ] as const;
  for (const [data, code, tokens] of cases) {
    try { await volcanoPlanner("fake-key", "model", fixture(data))(messages); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(BlenderPlannerError);
      expect((error as BlenderPlannerError).code).toBe(code);
      expect((error as BlenderPlannerError).tokens).toBe(tokens);
    }
  }
});
test("malformed HTTP JSON has a safe classification", async () => {
  const request = (async () => new Response("private invalid JSON")) as unknown as typeof fetch;
  await expect(volcanoPlanner("fake-key", "model", request)(messages)).rejects.toThrow("planning_invalid_response");
});
