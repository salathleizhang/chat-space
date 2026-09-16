import { describe, expect, test } from "bun:test";
import { ChatStreamEventSchema, ChatStreamRequestSchema } from "./chat";

const baseRequest = {
  projectSlug: "demo",
  messages: [{ role: "user" as const, content: "生成一张参考图" }],
  llm: { apiKey: "test-key" },
};

describe("ChatStreamRequestSchema 图片生成模型偏好", () => {
  test.each(["seedream"])(
    "接受已启用模型：%s",
    (imageGenerateModel) => {
      expect(
        ChatStreamRequestSchema.parse({ ...baseRequest, imageGenerateModel })
          .imageGenerateModel,
      ).toBe(imageGenerateModel);
    },
  );

  test("拒绝未注册模型", () => {
    expect(() =>
      ChatStreamRequestSchema.parse({
        ...baseRequest,
        imageGenerateModel: "unknown-image-model",
      }),
    ).toThrow();
  });

  test("拒绝旧版图片与 3D 供应商偏好", () => {
    expect(() => ChatStreamRequestSchema.parse({ ...baseRequest, imageGenerateModel: "nano-banana" })).toThrow();
    expect(() => ChatStreamRequestSchema.parse({ ...baseRequest, threeDProvider: "hyper3d-direct" })).toThrow();
  });

  test.each(["hyper3d-volc", "hi3d-volc"])("接受火山方舟 3D 模型：%s", (threeDProvider) => {
    expect(ChatStreamRequestSchema.parse({ ...baseRequest, threeDProvider }).threeDProvider)
      .toBe(threeDProvider);
  });
});

describe("ChatStreamEventSchema 工具图片结果", () => {
  test("接受参考图工具返回的库内图片路径", () => {
    const event = ChatStreamEventSchema.parse({
      type: "tool-result",
      name: "generate-reference-images",
      toolCallId: "tool-1",
      images: ["projects/demo/source/0-ref.png"],
    });
    expect(event).toMatchObject({
      images: ["projects/demo/source/0-ref.png"],
    });
  });

  test("拒绝逃逸资产库的图片路径", () => {
    expect(() =>
      ChatStreamEventSchema.parse({
        type: "tool-result",
        name: "generate-reference-images",
        images: ["../../secret.png"],
      }),
    ).toThrow();
  });
});

describe("ChatStreamEventSchema 工具错误", () => {
  test("透传工具自身的可读错误详情", () => {
    expect(
      ChatStreamEventSchema.parse({
        type: "tool-error",
        name: "analyze-reference",
        message: "参考图不存在",
      }),
    ).toMatchObject({ message: "参考图不存在" });
  });
});

describe("ChatStreamRequestSchema 会话计划", () => {
  test("接受当前会话计划并为旧快照补 revision", () => {
    const parsed = ChatStreamRequestSchema.parse({
      projectSlug: "demo",
      messages: [{ role: "user", content: "继续" }],
      llm: { apiKey: "test" },
      plan: {
        schemaVersion: 1,
        steps: [{ id: "model", content: "生成模型", status: "in_progress" }],
        updatedAt: new Date().toISOString(),
      },
    });
    expect(parsed.plan?.revision).toBe(1);
  });
});
