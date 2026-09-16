import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
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

/** agent 的执行计划卡（no-op 状态：只展示进度，执行由 agent 逐步完成） */
export function PlanCard({ plan }: { plan: ProjectPlan }) {
  const done = plan.steps.filter((s) => s.status === "completed").length;
  return (
    <Panel
      data-plan-card
      className="w-full max-w-xl self-center bg-fill! px-4 py-3.5"
    >
      <div
        data-plan-card-header
        className="flex items-start justify-between gap-4"
      >
        <span className="min-w-0 text-sm font-semibold leading-5 text-ink-strong">
          {plan.title ?? "执行计划"}
        </span>
        <Badge className="mt-px shrink-0 text-[10px]">
          {done}/{plan.steps.length}
        </Badge>
      </div>
      <ol className="mt-3 flex flex-col gap-2.5">
        {plan.steps.map((step) => (
          <li
            key={step.id}
            data-plan-step={step.status}
            className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 text-xs leading-5"
          >
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
          </li>
        ))}
      </ol>
    </Panel>
  );
}
