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
    /*
      上传直连：用户本条消息带一张干净的单物体照片时，参考图不必是生成出来的——
      attach-source-image 免费把它登记为参考图（不碰任何供应商、不需要付费同意）。
      少了它，"把这张照片做成模型"只能靠花钱重画一张，保真度也会掉。
    */
    expect(tools["attach-source-image"]).toBeDefined();
    const attachSchema = z.toJSONSchema(
      (tools["attach-source-image"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(Object.keys(attachSchema.properties ?? {}).sort()).toEqual([
      "assetIntent",
      "assetName",
      "assetSlug",
      "image",
    ]);
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
    /*
      摆放有两条路，都要常驻：place-scene-objects 按参考图重算整套布局（要求项目已有
      已确认场景），place-object 按显式位置/目标表面摆单个对象（不需要 SceneSpec）。
      少了后者，"给小熊找个地方放"在没跑过完整场景的项目里就没有任何工具可用。
    */
    expect(tools["place-scene-objects"]).toBeDefined();
    expect(tools["place-object"]).toBeDefined();
    const placeObjectSchema = z.toJSONSchema(
      (tools["place-object"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(Object.keys(placeObjectSchema.properties ?? {})).toEqual(["items"]);
    expect(tools["analyze-reference"]).toBeUndefined();
    /*
      检查工具只有 inspect 一个（target 区分模型/场景）；旧的 inspect-asset 已并入它。
      schema 形状由下面那条"顶层 object"不变量守着——判别联合会序列化成 anyOf 并让请求 400。
    */
    expect(tools["inspect"]).toBeDefined();
    expect(Object.keys(tools)).not.toContain("inspect-asset");
    const inspectSchema = z.toJSONSchema(
      (tools["inspect"] as unknown as { inputSchema: z.ZodType }).inputSchema,
      { io: "input" },
    ) as { properties?: Record<string, unknown> };
    expect(Object.keys(inspectSchema.properties ?? {}).sort()).toEqual([
      "assetSlug",
      "target",
      "views",
    ]);
    expect(Object.keys(tools)).not.toContain("confirm-reference-assets");
    expect(Object.keys(tools)).not.toContain("updatePlanTool");
    expect(Object.keys(tools)).not.toContain("generateReferenceImagesTool");
  });

  test("完整场景通过 SceneJob 工具启动", async () => {
    const agent = createCreatorAgent({ apiKey: "sk-test" });
    const tools = await agent.listTools();
    expect(tools["start-scene-job"]).toBeDefined();
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
