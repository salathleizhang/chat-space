import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createCreatorAgent } from "./creator";

describe("creator 工具可用性", () => {
  test("没有当前消息图片时不向模型提供 analyze-reference", async () => {
    const tools = await createCreatorAgent({ apiKey: "sk-test" }).listTools();
    expect(tools["update-plan"]).toBeDefined();
    expect(tools["generate-reference-images"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("edit-reference-image");
    expect(tools["analyze-scene"]).toBeDefined();
    expect(tools["analyze-reference"]).toBeUndefined();
    expect(tools["confirm-reference-assets"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("updatePlanTool");
    expect(Object.keys(tools)).not.toContain("generateReferenceImagesTool");
  });

  test("当前消息有图且明确要求参考图分析时才提供 analyze-reference", async () => {
    const tools = await createCreatorAgent(
      { apiKey: "sk-test" },
      { enableAnalyzeReference: true },
    ).listTools();
    expect(tools["analyze-reference"]).toBeDefined();
  });

  /**
   * 火山方舟 DeepSeek 接入点要求 `tools.N.function.parameters` 顶层是
   * `type: object`；顶层 union 会序列化成 `{ anyOf: [...] }` 并让整轮请求 400
   * （Doubao 接入点容忍 anyOf，所以这条不变量只能靠测试守住）。
   */
  test("每个工具的入参都序列化成顶层 object", async () => {
    const tools = await createCreatorAgent({ apiKey: "sk-test" }).listTools();
    const offenders: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      const schema = (tool as { inputSchema?: z.ZodType }).inputSchema;
      expect(schema, `工具 ${name} 缺少 inputSchema`).toBeDefined();
      const json = z.toJSONSchema(schema!, { io: "input" }) as { type?: string };
      if (json.type !== "object") offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
