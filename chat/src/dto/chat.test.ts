import { describe, expect, test } from "bun:test";
import { ChatStreamEventSchema, ChatStreamRequestSchema } from "./chat";

const baseRequest = {
  projectSlug: "demo",
  messages: [{ role: "user" as const, content: "生成一张参考图" }],
  llm: { apiKey: "test-key" },
};

describe("ChatStreamRequestSchema 图片生成模型偏好", () => {
  test.each(["seedream", "seedream-5", "seedream-5-pro"])(
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

  test("拒绝旧版图片偏好，旧版 3D 渠道字段被丢弃而不是当成选择", () => {
    expect(() => ChatStreamRequestSchema.parse({ ...baseRequest, imageGenerateModel: "nano-banana" })).toThrow();
    const parsed = ChatStreamRequestSchema.parse({ ...baseRequest, threeDProvider: "hyper3d-volc" });
    expect(parsed.threeDModel).toBeUndefined();
    expect(parsed).not.toHaveProperty("threeDProvider");
  });

  test.each(["seed3d-2", "hyper3d-gen2", "hi3d-2", "tripo-3-1", "tripo-p1", "tripo-p2"])(
    "接受已注册的 3D 模型：%s",
    (threeDModel) => {
      expect(ChatStreamRequestSchema.parse({ ...baseRequest, threeDModel }).threeDModel)
        .toBe(threeDModel);
    },
  );

  test("拒绝未注册的 3D 模型选择键", () => {
    expect(() =>
      ChatStreamRequestSchema.parse({ ...baseRequest, threeDModel: "hyper3d-direct" }),
    ).toThrow();
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

describe("ChatStreamEventSchema ask-user 提问", () => {
  const question = {
    questionId: "q-1",
    header: "付费确认",
    question: "是否按上述计划生成？",
    options: [
      { id: "approve", label: "同意", recommended: true },
      { id: "stop", label: "停止", tone: "danger" as const },
    ],
    multiSelect: false,
    allowOther: false,
  };

  test("提问随 tool-result 透传，缺 questionId 的结果不算提问", () => {
    expect(
      ChatStreamEventSchema.parse({
        type: "tool-result",
        name: "ask-user",
        toolCallId: "tool-q",
        question,
      }),
    ).toMatchObject({ question: { questionId: "q-1" } });
    expect(() =>
      ChatStreamEventSchema.parse({
        type: "tool-result",
        name: "ask-user",
        question: { ...question, questionId: undefined },
      }),
    ).toThrow();
  });

  test("请求接受顶层 answer 字段，并带上问题原文与可读选项", () => {
    const parsed = ChatStreamRequestSchema.parse({
      ...baseRequest,
      answer: {
        questionId: "q-1",
        question: "是否按上述计划生成？",
        optionIds: ["approve"],
        labels: ["同意"],
      },
    });
    expect(parsed.answer).toEqual({
      questionId: "q-1",
      question: "是否按上述计划生成？",
      optionIds: ["approve"],
      labels: ["同意"],
    });
  });

  test("回答不再是一条用户消息：answer 不能作为消息部件出现", () => {
    expect(() =>
      ChatStreamRequestSchema.parse({
        ...baseRequest,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "answer",
                questionId: "q-1",
                question: "是否继续？",
                optionIds: [],
                labels: [],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  test("回答必须能定位到问题：缺问题原文或选项文字对不上都拒绝", () => {
    const withAnswer = (patch: Record<string, unknown>) => ({
      ...baseRequest,
      answer: {
        questionId: "q-1",
        question: "是否继续？",
        optionIds: [],
        labels: [],
        ...patch,
      },
    });
    expect(() =>
      ChatStreamRequestSchema.parse(withAnswer({ question: undefined })),
    ).toThrow();
    // labels 与 optionIds 必须一一对应，否则报给模型的"用户选了什么"就是错的
    expect(() =>
      ChatStreamRequestSchema.parse(withAnswer({ labels: ["同意"] })),
    ).toThrow();
    expect(
      ChatStreamRequestSchema.parse(withAnswer({ text: "先只做底板" })).answer,
    ).toMatchObject({ text: "先只做底板" });
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

describe("ChatStreamRequestSchema 续跑上下文", () => {
  test("接受 Agent 自发续跑的指令与库内图片", () => {
    const parsed = ChatStreamRequestSchema.parse({
      ...baseRequest,
      resume: {
        kind: "inspection",
        text: "[Self-check] dog: four views.",
        images: ["projects/demo/assets/dog/inspections/check.png"],
      },
    });
    expect(parsed.resume).toMatchObject({ kind: "inspection" });
  });

  test("拒绝逃逸资产库的续跑图片与未知续跑类型", () => {
    expect(() =>
      ChatStreamRequestSchema.parse({
        ...baseRequest,
        resume: { kind: "inspection", text: "看这张图", images: ["../../secret.png"] },
      }),
    ).toThrow();
    expect(() =>
      ChatStreamRequestSchema.parse({
        ...baseRequest,
        resume: { kind: "unknown", text: "继续" },
      }),
    ).toThrow();
  });
});
