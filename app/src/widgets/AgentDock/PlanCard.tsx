import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useId, useState } from "react";
import type { PlanStep, ProjectPlan } from "../../shared/lib/libraryApi";
import { Badge } from "../../shared/ui/Badge";
import { Panel } from "../../shared/ui/Panel";

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "completed") {
    return <CheckCircleIcon size={13} weight="fill" className="shrink-0 text-ink-subtle" />;
  }
  if (status === "in_progress") {
    return (
      <CircleNotchIcon size={13} className="shrink-0 animate-spin text-ink" />
    );
  }
  if (status === "cancelled") {
    return <XCircleIcon size={13} className="shrink-0 text-ink-faint" />;
  }
  return <CircleIcon size={13} className="shrink-0 text-ink-faint" />;
}

/**
 * 一行步骤。折叠时把行高收到 0fr + 淡出（grid-template-rows 的 fr 可插值，
 * 无需量高度），行距放在被裁剪的内层，收起的行不残留间距。
 */
function StepRow({ step, folded }: { step: PlanStep; folded: boolean }) {
  return (
    <li
      data-plan-step={step.status}
      {...(folded
        ? { "data-plan-step-folded": "true", "aria-hidden": "true" }
        : {})}
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-spring motion-reduce:duration-100 ${
        folded ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
      }`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 pb-2.5 text-xs leading-5">
          <span className="flex h-5 items-center justify-center" aria-hidden="true">
            <StepIcon status={step.status} />
          </span>
          <span
            className={`min-w-0 ${
              step.status === "cancelled"
                ? "text-ink-faint line-through"
                : step.status === "completed"
                  ? "text-ink-faint"
                  : step.status === "in_progress"
                    ? "text-ink-strong"
                    : "text-ink-subtle"
            }`}
          >
            {step.content}
          </span>
        </div>
      </div>
    </li>
  );
}

/** 折叠时留下的那一步：优先进行中，其次最后推进过的一步，都没有就退回第一步。 */
function currentStep(steps: PlanStep[]): PlanStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.filter((step) => step.status !== "pending").at(-1) ??
    steps[0]
  );
}

/**
 * agent 的执行计划卡（no-op 状态：只展示进度，执行由 agent 逐步完成）。
 * 计划刚开始列出来时完整铺开让用户过目；一旦有步骤离开 pending（= 开始执行），
 * 就默认收成「标题 + 当前这一步」，把纵向空间还给对话；点标题栏随时展开/收起，
 * 手动选择在本次计划内保持（replan 或换计划后回到默认）。收放是逐行动画：
 * 当前步骤推进时，上一步收起、下一步展开，卡片高度跟着平滑变化。
 *
 * 卡片长在历史末尾，展开后下面那截会落在滚动容器外，所以把「刚展开」告诉父级，
 * 由它把滚动位置跟到底（见 MessageHistory 的 ResizeObserver）。
 */
export function PlanCard({
  plan,
  onToggle,
}: {
  plan: ProjectPlan;
  onToggle?: (open: boolean) => void;
}) {
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const started = plan.steps.some((step) => step.status !== "pending");
  // 计划身份：revision 或步骤集合变化 = 换了计划，用户此前的手动展开偏好不再适用。
  const planKey = `${plan.revision ?? 0}:${plan.steps.map((step) => step.id).join(",")}`;
  const [preference, setPreference] = useState<{ planKey: string; open: boolean } | null>(
    null,
  );
  const manualOpen = preference?.planKey === planKey ? preference.open : null;
  const collapsed = manualOpen === null ? started : !manualOpen;
  const active = currentStep(plan.steps);
  const stepsId = useId();

  return (
    <Panel
      data-plan-card
      data-plan-card-state={collapsed ? "collapsed" : "expanded"}
      className="w-full max-w-xl self-center bg-fill! px-4 py-3.5"
    >
      <button
        type="button"
        data-plan-card-header
        aria-expanded={!collapsed}
        aria-controls={stepsId}
        onClick={() => {
          const nextOpen = collapsed;
          setPreference({ planKey, open: nextOpen });
          onToggle?.(nextOpen);
        }}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <span className="min-w-0 text-sm font-semibold leading-5 text-ink-strong">
          {plan.title ?? "Execution plan"}
        </span>
        <span className="mt-px flex shrink-0 items-center gap-1.5">
          <Badge className="text-[10px]">
            {done}/{plan.steps.length}
          </Badge>
          <CaretRightIcon
            size={11}
            weight="bold"
            aria-hidden="true"
            className={`text-ink-faint transition-transform duration-150 ease-spring ${
              collapsed ? "" : "rotate-90"
            }`}
          />
        </span>
      </button>
      <ol id={stepsId} className="mt-3 -mb-2.5 flex flex-col">
        {plan.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            folded={collapsed && step.id !== active?.id}
          />
        ))}
      </ol>
    </Panel>
  );
}
