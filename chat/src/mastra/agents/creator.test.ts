import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createCreatorAgent } from "./creator";

describe("creator 工具可用性", () => {
  test("没有当前消息图片时不向模型提供 analyze-reference", async () => {
    const tools = await createCreatorAgent({ apiKey: "sk-test" }).listTools();
    expect(tools["ask-user"]).toBeDefined();
    const askUserSchema = z.toJSONSchema(
      (tools["ask-user"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    // 选项内容由模型决定，工具只暴露这些字段（questionId 由服务端补，模型看不到）
    expect(Object.keys(askUserSchema.properties ?? {}).sort()).toEqual([
      "allowOther",
      "details",
      "header",
      "multiSelect",
      "options",
      "question",
    ]);
    expect(tools["update-plan"]).toBeDefined();
    const worldSchema = z.toJSONSchema(
      (tools["start-world-task"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(worldSchema.properties).toHaveProperty("sourceMode");
    expect(tools["generate-reference-images"]).toBeDefined();
    expect(tools["generate-clean-plate"]).toBeDefined();
    expect(tools["start-scene-job"]).toBeDefined();
    expect(tools["revise-scene-job"]).toBeDefined();
    expect(tools["retry-scene-job-nodes"]).toBeDefined();
    expect(tools["get-scene-job"]).toBeDefined();
    expect(tools["generate-skybox"]).toBeDefined();
    const skyboxSchema = z.toJSONSchema(
      (tools["generate-skybox"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(skyboxSchema.properties).toHaveProperty("prompt");
    expect(skyboxSchema.properties).not.toHaveProperty("model");
    expect(tools["generate-texture"]).toBeDefined();
    const textureSchema = z.toJSONSchema(
      (tools["generate-texture"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(textureSchema.properties).not.toHaveProperty("model");
    expect(textureSchema.properties).not.toHaveProperty("channel");
    const segmentSchema = z.toJSONSchema(
      (tools["segment-parts"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(segmentSchema.properties).toHaveProperty("assetSlug");
    expect(segmentSchema.properties).not.toHaveProperty("channel");
    expect(tools["retopologize"]).toBeDefined();
    expect(tools["rig-model"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("generate-animation");
    expect(tools["generate-character"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("unwrap-uv");
    expect(Object.keys(tools)).not.toContain("build-cad-model");
    expect(Object.keys(tools)).not.toContain("get-cad-source");
    expect(Object.keys(tools)).not.toContain("generate-plate");
    expect(Object.keys(tools)).not.toContain("edit-reference-image");
    expect(tools["analyze-scene"]).toBeDefined();
    expect(tools["analyze-reference"]).toBeUndefined();
    expect(Object.keys(tools)).not.toContain("confirm-reference-assets");
    expect(Object.keys(tools)).not.toContain("run-one-shot");
    expect(Object.keys(tools)).not.toContain("updatePlanTool");
    expect(Object.keys(tools)).not.toContain("generateReferenceImagesTool");
  });

  test("新完整场景以 SceneJob 工具启动，旧 Workflow 不再向 Agent 暴露", async () => {
    const agent = createCreatorAgent({ apiKey: "sk-test" });
    const workflows = await agent.listWorkflows();
    expect(workflows["one-shot-scene"]).toBeUndefined();
    const tools = await agent.listTools();
    expect(tools["start-scene-job"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("run-one-shot");
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
