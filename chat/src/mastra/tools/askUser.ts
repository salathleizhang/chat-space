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
    "Show a clickable question card when the user themself needs to make a decision (free): consent to a paid operation, choosing between several options, " +
    "confirming which objects to work on, or irreversible or high-cost actions. After the call this turn ends immediately; the user clicks an option on the card or types " +
    "text directly, and the answer comes back as the next user message." +
    "Filling requirements: options must be specific and mutually exclusive, 2~4 is best; mark the recommended option with recommended; " +
    "consent to a paid operation must offer both \"Approve\" (recommended) and \"Stop\" (tone=danger), " +
    "and write which platform will be called and what will be done into details or the option description; " +
    "use multiSelect=true when the user needs to pick multiple objects, and use stable asset slugs as option ids; " +
    "use allowOther=true when you also want the user to describe something freely beyond the options. " +
    "Usage boundaries: do not ask for information you can find in the context or via tools; do not use this tool merely to report progress; " +
    "this tool must occupy a reply of its own and must never be called in the same reply as any other tool.",
  inputSchema: AskUserQuestionDraftSchema,
  execute: async (input) => {
    const question = buildAskUserQuestion(input);
    return {
      question,
      note:
        "The question has been given to the user and this turn ends here. Do not call any more tools; " +
        "the user's choice comes back as the next user message, and you continue the original task once you receive it.",
    };
  },
});
