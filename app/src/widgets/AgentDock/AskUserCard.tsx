import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { useState } from "react";
import type { AskUserAnswer, AskUserQuestion } from "../../shared/lib/chatClient";
import { Badge, Button, Panel } from "../../shared/ui";

/**
 * Agent 的提问卡片（ask-user 工具）：把「需要用户本人决定」的那一步渲染成
 * 可点选的卡片，而不是让 Agent 用自然语言提问后干等用户打字。
 *
 * 卡片内容完全由模型决定——付费同意（同意/停止）、方案取舍、对象多选都只是
 * 同一套形状的不同填法，组件本身不预设任何业务语义。
 *
 * 状态归属：待回答的问题与最终答案都存在消息上（见 ChatMessage），组件只持有
 * 未提交的勾选草稿。因此刷新、切换会话、甚至关掉浏览器再回来，卡片都还在、
 * 还能点——服务端不保存任何提问状态。
 */
export function AskUserCard({
  question,
  answer,
  superseded,
  onAnswer,
}: {
  question: AskUserQuestion;
  /** 已作出的选择；有值即转为只读回执 */
  answer?: AskUserAnswer;
  /** 用户没点卡片、直接用文字回了别的：卡片置灰，不再可点 */
  superseded?: boolean;
  onAnswer: (answer: AskUserAnswer) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const locked = Boolean(answer) || superseded;

  const submit = (optionIds: string[], labels: string[], text?: string) => {
    if (locked) return;
    onAnswer({
      questionId: question.questionId,
      question: question.question,
      optionIds,
      labels,
      ...(text ? { text } : {}),
    });
  };

  const chosenLabel = answer
    ? [...answer.labels, ...(answer.text ? [answer.text] : [])].join("、")
    : "";

  return (
    <Panel
      data-ask-user-card={answer ? "answered" : superseded ? "superseded" : "pending"}
      className="mt-2 w-full max-w-xl self-start bg-fill! px-4 py-3.5"
    >
      <div data-ask-user-header className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-sm font-semibold leading-5 text-ink-strong">
          {question.question}
        </span>
        {question.header && (
          <Badge className="mt-px shrink-0 text-[10px]">{question.header}</Badge>
        )}
      </div>

      {question.details && question.details.length > 0 && (
        <ul
          data-ask-user-details
          className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-ink-subtle"
        >
          {question.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}

      {answer || superseded ? (
        <p
          data-ask-user-result
          className={`mt-3 text-xs leading-5 ${superseded && !answer ? "text-ink-faint" : "text-ink-subtle"}`}
        >
          {answer ? `已选择：${chosenLabel}` : "已忽略（你在输入框里直接回答了）"}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {question.options.map((option) => {
            const isChecked = checked.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                data-ask-user-option={option.id}
                data-ask-user-checked={isChecked ? "true" : "false"}
                aria-pressed={question.multiSelect ? isChecked : undefined}
                className="flex w-full items-start gap-2 rounded-control px-2.5 py-2 text-left transition-colors duration-150 hover:bg-fill-active"
                onClick={() => {
                  if (locked) return;
                  if (!question.multiSelect) {
                    submit([option.id], [option.label]);
                    return;
                  }
                  setChecked((current) =>
                    current.includes(option.id)
                      ? current.filter((id) => id !== option.id)
                      : [...current, option.id],
                  );
                }}
              >
                {question.multiSelect && (
                  <CheckCircleIcon
                    size={15}
                    weight={isChecked ? "fill" : "regular"}
                    aria-hidden="true"
                    className={`mt-0.5 shrink-0 ${isChecked ? "text-accent" : "text-ink-faint"}`}
                  />
                )}
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`text-xs font-medium ${
                        option.tone === "danger" ? "text-signal" : "text-ink"
                      }`}
                    >
                      {option.label}
                    </span>
                    {option.recommended && (
                      <Badge className="text-[10px]">推荐</Badge>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-[11px] leading-4 text-ink-subtle">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {question.allowOther && (
            <div className="flex items-center gap-2">
              <input
                data-ask-user-other
                value={other}
                placeholder="或者直接输入你的决定"
                className="h-8 min-w-0 flex-1 rounded-control border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-accent"
                onChange={(event) => setOther(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const text = other.trim();
                  if (!text) return;
                  const labels = checked
                    .map((id) => question.options.find((o) => o.id === id)?.label)
                    .filter((label): label is string => Boolean(label));
                  submit(checked, labels, text);
                }}
              />
            </div>
          )}

          {question.multiSelect && (
            <div className="flex justify-end">
              <Button
                data-ask-user-confirm
                variant="primary"
                size="sm"
                disabled={checked.length === 0 && other.trim().length === 0}
                onClick={() => {
                  const labels = checked
                    .map((id) => question.options.find((o) => o.id === id)?.label)
                    .filter((label): label is string => Boolean(label));
                  submit(checked, labels, other.trim() || undefined);
                }}
              >
                确认选择
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
