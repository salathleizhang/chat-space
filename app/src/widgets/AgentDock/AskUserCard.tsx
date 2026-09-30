import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { useId, useState } from "react";
import type { AskUserAnswer, AskUserQuestion } from "../../shared/lib/chatClient";
import { Badge, Button, Panel } from "../../shared/ui";

/** 跟帧入视的上限：只防内容一直变时无限跟下去，正常展开 300ms 内就稳定了。 */
const CARD_FOLLOW_MAX_MS = 1500;
/** 尺寸静默多久算长完了。ResizeObserver 只在真的变尺寸时回调，所以这个值只决定"何时收手"。 */
const CARD_SETTLE_MS = 120;

/**
 * 展开后逐帧把卡片自己的底部带进视野，直到卡片高度连续两帧不变。
 *
 * 判据照搬 followScroll.ts（计划卡那套）：跟固定时长在帧率低或被降频时会提前
 * 过期，动画还没长完就收手，露出来的明细留在容器外。
 *
 * 动作不一样，不能直接复用那个函数：计划卡永远在历史末尾，把容器贴到底就等于
 * 露出卡片底部；提问卡在历史中间（答完下面还有用户消息和回复），贴容器底会把
 * 刚点开的这张卡滚出视野。这里用 block:"nearest"，露够就停、不越界。
 */
function followCardIntoView(card: Element) {
  /*
    用 `ResizeObserver` 而不是**每帧读 `offsetHeight`**：后者是每帧一次强制同步布局
    （展开后最多 1.5 s，约 90 次），而这里真正要等的只有"卡片不再长高"这一件事。
    ResizeObserver 只在尺寸真的变化时回调，静默 `CARD_SETTLE_MS` 就收手；热路径上一次
    布局读都不做。上限仍然保留，防止内容一直变时无限跟下去。
  */
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(settle);
    observer.disconnect();
  };
  const observer = new ResizeObserver(() => {
    if (!card.isConnected) { stop(); return; }
    // 判据照旧用 block:"nearest"：露够就停、不越界（见上面与 followScroll.ts 的差异说明）。
    card.scrollIntoView({ block: "nearest" });
    clearTimeout(settle);
    settle = setTimeout(stop, CARD_SETTLE_MS);
  });
  observer.observe(card);
  card.scrollIntoView({ block: "nearest" });
  settle = setTimeout(stop, CARD_FOLLOW_MAX_MS);
}

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
  const locked = Boolean(answer) || Boolean(superseded);
  const details = question.details ?? [];

  /*
    折叠规则对齐 PlanCard：默认态由状态推导（答完/被跳过 = 收），用户手动开关按
    questionId 记成偏好，换一个问题就回到默认。待回答时不可折叠——选项就是这一步
    的全部意义，收起来等于把问题藏了；只有终态、且确实有明细可收时才给折叠入口。
  */
  const foldable = locked && details.length > 0;
  const [preference, setPreference] = useState<{
    questionId: string;
    open: boolean;
  } | null>(null);
  const manualOpen =
    preference?.questionId === question.questionId ? preference.open : null;
  const collapsed = foldable && !(manualOpen ?? false);
  const bodyId = useId();

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

  const headerContent = (
    <>
      <span className="min-w-0 text-sm font-semibold leading-5 text-ink-strong">
        {question.question}
      </span>
      <span className="mt-px flex shrink-0 items-center gap-1.5">
        {question.header && (
          <Badge className="text-[10px]">{question.header}</Badge>
        )}
        {foldable && (
          <CaretRightIcon
            size={11}
            weight="bold"
            aria-hidden="true"
            className={`text-ink-faint transition-transform duration-150 ease-spring ${
              collapsed ? "" : "rotate-90"
            }`}
          />
        )}
      </span>
    </>
  );

  return (
    <Panel
      data-ask-user-card={answer ? "answered" : superseded ? "superseded" : "pending"}
      data-ask-user-card-state={collapsed ? "collapsed" : "expanded"}
      /*
        mx-auto 而不是 self-center：这张卡在 assistant 消息气泡内部（消息容器不是
        flex），self-* 不会生效；PlanCard 是历史容器的直接 flex 子项才用 self-center。
        两者最终都以 max-w-xl 居中在同一阅读宽度上。
      */
      className="mx-auto mt-2 w-full max-w-xl bg-fill! px-4 py-3.5"
    >
      {foldable ? (
        <button
          type="button"
          data-ask-user-header
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={(event) => {
            setPreference({ questionId: question.questionId, open: collapsed });
            // 只有"展开"需要跟：收起时内容在变短，不存在看不到底部的问题
            if (!collapsed) return;
            const card = event.currentTarget.closest("[data-ask-user-card]");
            if (card) followCardIntoView(card);
          }}
          className="flex w-full items-start justify-between gap-3 text-left"
        >
          {headerContent}
        </button>
      ) : (
        <div
          data-ask-user-header
          className="flex items-start justify-between gap-3"
        >
          {headerContent}
        </div>
      )}

      {details.length > 0 && (
        /*
          明细逐行收放：grid-template-rows 的 fr 可插值，不用量高度；行距放在被
          裁剪的内层，收起后不残留间距（与 PlanCard 的 StepRow 同一套做法）。
        */
        <div
          id={bodyId}
          aria-hidden={collapsed || undefined}
          data-ask-user-details-fold={collapsed ? "collapsed" : "expanded"}
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-spring motion-reduce:duration-100 ${
            collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <ul
              data-ask-user-details
              className="flex list-disc flex-col gap-1 pl-4 pt-2 text-xs leading-5 text-ink-subtle"
            >
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        </div>
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
