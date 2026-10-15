import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CREATOR_INSTRUCTIONS } from "../prompts/creator";
import * as toolsIndex from "../tools";
import { BLENDER_TOOLS } from "../tools/blenderOps";
import { BLENDER_SERVICE_TOOLS } from "../tools/blenderService";
import { createCreatorAgent } from "./creator";

/**
 * 产品里所有工具 id 的词汇表（含配置开关控制、默认不注册的那些）。
 *
 * 从模块导出里现取而不是手写清单：手写清单会随新增工具过期，而这条测试的全部价值
 * 就在于"提示词点名了一个不在工具表里的工具"必须立刻变红。
 */
/** createTool 的产物：有字符串 id 就是工具，否则当成"名字 → 工具"的表继续展开。 */
function isTool(value: unknown): value is { id: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function collectToolIds(target: Set<string>, map: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(map)) target.add(isTool(value) ? value.id : name);
}

function allToolIds(): string[] {
  const ids = new Set<string>();
  for (const value of Object.values(toolsIndex)) {
    if (isTool(value)) ids.add(value.id);
    else if (value && typeof value === "object") collectToolIds(ids, value as Record<string, unknown>);
  }
  collectToolIds(ids, BLENDER_TOOLS);
  collectToolIds(ids, BLENDER_SERVICE_TOOLS);
  return [...ids];
}

/** 按标识符边界匹配：`inspect` 不该被 `inspection` 命中，`analyze-scene` 不该被 `analyze-reference` 命中。 */
function mentionsTool(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

describe("creator 工具可用性", () => {
  test("常驻工具与各自入参形状（含「提示词答应了的能力都挂上」的定点断言）", async () => {
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
    expect(tools["generate-animation"]).toBeDefined();
    expect(tools["generate-character"]).toBeDefined();
    // 提示词点名了 unwrap-uv（"only unwrap-uv uses Hunyuan"），它就必须真的在工具表里：
    // 2026-09-26 e0d5f27 只挂了 Tripo 那几个，把这条漏了，用户要 UV 只会拿到 Unknown tool。
    expect(tools["unwrap-uv"]).toBeDefined();
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
    /*
      2026-10-15 事故的定点回归：analyze-reference 必须**常驻**。它以前按"本条消息恰好
      一张图 + 关键词命中"裁剪，用户说「将这个场景生成出来」时工具表里没有它，模型硬调
      拿到 Unknown tool，退而调 start-scene-job 又拿到一句叫它去调这个不存在工具的 404。
    */
    expect(tools["analyze-reference"]).toBeDefined();
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

  /**
   * **类级不变量**：系统提示词里点名的工具，必须在模型看到的工具表里。
   *
   * 这条守的不是某一个工具，而是一整类事故：提示词无条件叫模型调 X，而工具表按
   * 本条消息的措辞/图片把它裁掉 → 模型硬调拿到 `Unknown tool`（浏览器本地版），再拿
   * 常驻的下一步工具去撞前置条件，得到一条无法执行的报错。2026-10-15 的
   * 「Unknown tool: analyze-reference」+「no reference image analysis pending
   * confirmation」就是这一类的实例。
   *
   * 词汇表直接从工具模块取（含配置开关控制的 blender 工具，它们默认不注册，所以提示词
   * 一旦点名就会红）：新增工具或新增提示词措辞都会自动被这条守住，不需要维护例外表。
   */
  test("提示词点名的工具必须在工具表里", async () => {
    const tools = await createCreatorAgent({ apiKey: "sk-test" }).listTools();
    const mentioned = allToolIds().filter((id) => mentionsTool(CREATOR_INSTRUCTIONS, id));
    // 词汇表本身要有效，否则"没点名"会让这条测试空转。
    expect(mentioned.length).toBeGreaterThan(15);
    expect(mentioned.filter((id) => !(id in tools))).toEqual([]);
  });

  test("analyze-reference 常驻，不随本条消息或任何请求参数变化", async () => {
    const tools = await createCreatorAgent({ apiKey: "sk-test" }).listTools();
    expect(tools["analyze-reference"]).toBeDefined();
    expect(tools["start-scene-job"]).toBeDefined();
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
