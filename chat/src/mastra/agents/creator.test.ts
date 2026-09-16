import { describe, expect, test } from "bun:test";
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
});
