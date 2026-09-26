import { createTool } from "@mastra/core/tools";
import { randomUUID } from "node:crypto";
import {
  AskUserQuestionDraftSchema,
  AskUserQuestionSchema,
  type AskUserQuestion,
  type AskUserQuestionDraft,
} from "../../dto/chat";

/**
 * 交互式提问卡片（免费）：Agent 需要用户本人做决定时不再用自然语言提问后干等，
 * 而是把问题交出来渲染成可点选的卡片；用户的点选以下一条用户消息回到对话。
 *
 * 本工具和 identify-asset / inspect-asset 同款「本轮不返回答案」：问题经 SSE
 * tool-result 交给工作台后，chatService 会立即中止这一轮 agent run——这是比
 * 提示词纪律更硬的保证，付费工具不可能在同一条回复里抢先执行。
 *
 * 因此这里不做任何等待、不落任何状态：服务端每轮都是无状态的，问题的上下文
 * 随用户的选择一起回来（见 ChatContentPartSchema 的 answer 部件）。
 */

/** 补齐服务端才知道的字段，并归一化两个可选开关。 */
export function buildAskUserQuestion(
  draft: AskUserQuestionDraft,
): AskUserQuestion {
  return AskUserQuestionSchema.parse({
    ...draft,
    questionId: `q-${randomUUID()}`,
    multiSelect: draft.multiSelect ?? false,
    allowOther: draft.allowOther ?? false,
  });
}

/** 只接受本工具返回且通过契约校验的完整问题（与 planFromToolResult 同款）。 */
export function askUserQuestionFromToolResult(
  result: unknown,
): AskUserQuestion | undefined {
  if (!result || typeof result !== "object") return undefined;
  const parsed = AskUserQuestionSchema.safeParse(
    (result as { question?: unknown }).question,
  );
  return parsed.success ? parsed.data : undefined;
}

export const askUserTool = createTool({
  id: "ask-user",
  description:
    "需要用户本人做决定时弹出可点选的问题卡片（免费）：付费操作同意、多个方案取舍、" +
    "确认要处理的对象、不可逆或高成本的动作。调用后本轮立即结束，用户会点选卡片或直接" +
    "输入文字，答案以下一条用户消息返回。" +
    "填写要求：选项要具体且互斥，2~4 个为宜；推荐项标 recommended；" +
    "付费同意必须同时给出「同意」（recommended）和「停止」（tone=danger），" +
    "并把将调用哪个平台、要做什么写进 details 或选项 description；" +
    "需要用户挑选多个对象时用 multiSelect=true，选项 id 用稳定的资产 slug；" +
    "选项之外还想让用户自由描述时用 allowOther=true。" +
    "使用边界：能从上下文或工具查到的信息不要问；单纯汇报进度不要用本工具；" +
    "本工具必须单独占一条回复，禁止与任何其他工具在同一条回复里调用。",
  inputSchema: AskUserQuestionDraftSchema,
  execute: async (input) => {
    const question = buildAskUserQuestion(input);
    return {
      question,
      note:
        "问题已交给用户，本轮到此结束。不要继续调用任何工具；" +
        "用户的选择会以下一条用户消息返回，收到后再继续原任务。",
    };
  },
});
