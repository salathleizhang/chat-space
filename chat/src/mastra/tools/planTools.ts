import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { projectPlanFile } from "../../common/libraryPaths";
import {
  PlanStepSchema,
  PlanStepStatusSchema,
  ProjectPlanSchema,
  type ProjectPlan,
} from "../../dto/library";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { requireProject } from "./projectTools";
import { requireCurrentProject } from "./requestContext";

/**
 * 计划是 no-op 状态，不是可执行结构（opencode todowrite / Manus todo.md 模式）：
 * 工具只把步骤清单落盘成 plan.json，执行者始终是 creator agent 本人。
 * 落盘的价值：UI 渲染进度卡、跨会话/重启可恢复、把全局目标复诵进上下文。
 */

const PlanPatchStepSchema = z.object({
  id: z.string().min(1),
  /** 首次建计划或显式 replan 时必填；普通 update 不会用它改写原文。 */
  content: z.string().min(1).optional(),
  status: PlanStepStatusSchema.optional(),
});

export const PlanInputSchema = z.object({
  /** update 只改已有步骤状态；replan 才允许替换结构。首次调用自动创建。 */
  mode: z.enum(["update", "replan"]).default("update"),
  /** 只在首次创建或 replan 时传；update 传与当前不同的标题会被拒绝，普通进度更新不改计划身份。 */
  title: z.string().optional(),
  /** replan 必填，说明为什么推翻原结构；update 不要传。 */
  reason: z.string().min(1).optional(),
  steps: z.array(PlanPatchStepSchema).min(1),
});
export type PlanInput = z.input<typeof PlanInputSchema>;

function conflict(message: string): never {
  throw new ChatServiceError(message, 409, "plan_conflict");
}

function createSteps(input: z.output<typeof PlanInputSchema>) {
  return input.steps.map((step) => {
    if (!step.content) conflict(`Step ${step.id} is missing content`);
    return PlanStepSchema.parse({
      id: step.id,
      content: step.content,
      status: step.status ?? "pending",
    });
  });
}

/**
 * 首次调用创建计划；之后默认只按稳定 id 合并状态。
 * 结构变化必须显式 `mode=replan` 并说明原因，避免“继续”变成无声重写。
 */
export async function writePlan(
  storage: AssetStorage,
  projectSlug: string,
  rawInput: PlanInput,
): Promise<ProjectPlan> {
  const input = PlanInputSchema.parse(rawInput);
  await requireProject(storage, projectSlug);
  const path = projectPlanFile(projectSlug);
  const current = (await storage.exists(path))
    ? await readJson(storage, path, ProjectPlanSchema)
    : null;

  if (current && input.mode === "update") {
    if (input.title && input.title !== current.title) {
      conflict("A normal progress update cannot change the plan title; if you really need to change the structure, use mode=replan and provide reason");
    }
    const patches = new Map(input.steps.map((step) => [step.id, step]));
    for (const patch of patches.values()) {
      const existing = current.steps.find((step) => step.id === patch.id);
      if (!existing) {
        conflict(`Step ${patch.id} does not exist in the plan; if you really need to add a step, use mode=replan and provide reason`);
      }
      if (patch.content && patch.content !== existing.content) {
        conflict(`A normal progress update cannot rewrite the content of step ${patch.id}; if you really need to change the structure, use mode=replan`);
      }
      if (
        existing.status === "completed" &&
        patch.status &&
        patch.status !== "completed"
      ) {
        conflict(`Completed step ${patch.id} cannot be reverted; if you really need to overturn it, replan explicitly`);
      }
    }
    const steps = current.steps.map((step) => {
      const status = patches.get(step.id)?.status;
      return status ? { ...step, status } : step;
    });
    if (steps.filter((step) => step.status === "in_progress").length > 1) {
      conflict("A plan can have at most one in-progress step");
    }
    const plan = ProjectPlanSchema.parse({
      ...current,
      steps,
      updatedAt: new Date().toISOString(),
    });
    await writeJson(storage, path, ProjectPlanSchema, plan);
    return plan;
  }

  if (current && input.mode === "replan" && !input.reason) {
    conflict("Replanning requires a reason explaining why the original plan is being changed");
  }
  const plan: ProjectPlan = {
    schemaVersion: 1,
    revision: current ? current.revision + 1 : 1,
    ...(current && input.reason ? { revisionReason: input.reason } : {}),
    ...(input.title ? { title: input.title } : {}),
    steps: createSteps(input),
    updatedAt: new Date().toISOString(),
  };
  if (plan.steps.filter((step) => step.status === "in_progress").length > 1) {
    conflict("A plan can have at most one in-progress step");
  }
  await writeJson(storage, path, ProjectPlanSchema, plan);
  return plan;
}

// ---------- Mastra tool 包装 ----------

export const updatePlanTool = createTool({
  id: "update-plan",
  description:
    "Maintain the current project's execution plan: the first call passes title and the complete list of steps to create the plan; afterwards the default mode=update passes only existing stable ids with their new status — do not pass title and do not rewrite a step's content, because a normal progress update only advances status. Use mode=replan only when the user changes the goal or the facts show the original route is not viable, and provide reason along with the complete new step list. The plan is never executed automatically; carrying it out is still up to you, step by step, by calling other tools",
  inputSchema: PlanInputSchema,
  execute: async (input, context) => {
    const plan = await writePlan(getAssetStorage(), requireCurrentProject(context), input);
    return { plan };
  },
});
