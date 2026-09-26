import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AskUserQuestionDraftSchema } from "../../dto/chat";
import { askUserQuestionFromToolResult, buildAskUserQuestion } from "./askUser";

/**
 * ask-user 的形状约束：选项内容完全由模型决定，所以这里盯的是
 * 「服务端补齐了什么」「什么样的提问不算数」——而不是任何业务语义。
 */

const DRAFT = {
  header: "付费确认",
  question: "是否按上述计划生成？",
  details: ["Seedream 生成参考图 1 张", "Seed3D 生成模型 1 个"],
  options: [
    { id: "approve", label: "同意", recommended: true },
    { id: "stop", label: "停止", tone: "danger" as const },
  ],
};

describe("buildAskUserQuestion", () => {
  test("补齐服务端 questionId，并把两个可选开关归一化成布尔", () => {
    const question = buildAskUserQuestion(DRAFT);
    expect(question.questionId).toMatch(/^q-[0-9a-f-]{36}$/);
    expect(question.multiSelect).toBe(false);
    expect(question.allowOther).toBe(false);
    expect(question.options.map((option) => option.id)).toEqual(["approve", "stop"]);
    expect(question.details).toEqual(DRAFT.details);
  });

  test("每次提问拿到不同的 id（同一轮里问两次也不能串）", () => {
    expect(buildAskUserQuestion(DRAFT).questionId).not.toBe(
      buildAskUserQuestion(DRAFT).questionId,
    );
  });
});

describe("askUserQuestionFromToolResult", () => {
  test("只接受带完整形状的提问结果", () => {
    const question = buildAskUserQuestion(DRAFT);
    expect(askUserQuestionFromToolResult({ question })).toEqual(question);
    expect(
      askUserQuestionFromToolResult({ question: { ...question, questionId: undefined } }),
    ).toBeUndefined();
    expect(
      askUserQuestionFromToolResult({ question: { ...question, options: [] } }),
    ).toBeUndefined();
    expect(askUserQuestionFromToolResult({ note: "没有问题" })).toBeUndefined();
    expect(askUserQuestionFromToolResult(null)).toBeUndefined();
  });

  test("别的工具的结果不会被误认成提问", () => {
    expect(askUserQuestionFromToolResult({ plan: { steps: [] } })).toBeUndefined();
  });
});

describe("AskUserQuestionDraftSchema", () => {
  test("选项 id、数量与问题正文都受约束", () => {
    expect(AskUserQuestionDraftSchema.safeParse({ ...DRAFT, options: [] }).success).toBe(false);
    expect(AskUserQuestionDraftSchema.safeParse({ ...DRAFT, question: "" }).success).toBe(false);
    expect(
      AskUserQuestionDraftSchema.safeParse({
        ...DRAFT,
        options: [{ id: "a b", label: "x" }],
      }).success,
    ).toBe(false);
    expect(
      AskUserQuestionDraftSchema.safeParse({
        ...DRAFT,
        options: Array.from({ length: 7 }, (_, index) => ({
          id: `o${index}`,
          label: `选项 ${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  /**
   * 火山方舟 DeepSeek 接入点要求 tools.N.function.parameters 顶层是 type: object；
   * 这条不变量和 creator.test.ts 里那条同源，单独再钉一次是因为提问卡片的入参
   * 比其他工具深一层（数组套对象）。
   */
  test("入参序列化成顶层 object", () => {
    const json = z.toJSONSchema(AskUserQuestionDraftSchema, { io: "input" }) as {
      type?: string;
    };
    expect(json.type).toBe("object");
  });
});
