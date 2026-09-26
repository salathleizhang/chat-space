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
    if (!step.content) conflict(`步骤 ${step.id} 缺少 content`);
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
      conflict("普通进度更新不能改计划标题；确需改结构请使用 mode=replan 并填写 reason");
    }
    const patches = new Map(input.steps.map((step) => [step.id, step]));
    for (const patch of patches.values()) {
      const existing = current.steps.find((step) => step.id === patch.id);
      if (!existing) {
        conflict(`计划中不存在步骤 ${patch.id}；确需新增步骤请使用 mode=replan 并填写 reason`);
      }
      if (patch.content && patch.content !== existing.content) {
        conflict(`普通进度更新不能改写步骤 ${patch.id} 的内容；确需改结构请使用 mode=replan`);
      }
      if (
        existing.status === "completed" &&
        patch.status &&
        patch.status !== "completed"
      ) {
        conflict(`已完成步骤 ${patch.id} 不能回退；确需推翻请显式重新规划`);
      }
    }
    const steps = current.steps.map((step) => {
      const status = patches.get(step.id)?.status;
      return status ? { ...step, status } : step;
    });
    if (steps.filter((step) => step.status === "in_progress").length > 1) {
      conflict("同一计划最多只能有一个进行中步骤");
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
    conflict("重新规划必须填写 reason，说明为什么改变原计划");
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
    conflict("同一计划最多只能有一个进行中步骤");
  }
  await writeJson(storage, path, ProjectPlanSchema, plan);
  return plan;
}

// ---------- Mastra tool 包装 ----------

export const updatePlanTool = createTool({
  id: "update-plan",
  description:
    "维护当前项目的执行计划：首次调用传 title 与完整步骤创建计划；之后默认 mode=update，只传已有稳定 id 与新 status，不要传 title，也不要改写步骤 content——普通进度更新只推进度。只有用户改变目标或事实证明原路线不可行时才用 mode=replan，并填写 reason 与完整新步骤。计划不会被自动执行，执行仍由你逐步调用其他工具完成",
  inputSchema: PlanInputSchema,
  execute: async (input, context) => {
    const plan = await writePlan(getAssetStorage(), requireCurrentProject(context), input);
    return { plan };
  },
});
