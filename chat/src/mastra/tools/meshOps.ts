import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GenerationPhase } from "../../dto/tasks";
import { SlugSchema } from "../../dto/library";
import { TRIPO_DECIMATE_FACES } from "../../models/tripo";
import { getAssetStorage } from "../../services/assetStorage";
import { startCustomTask } from "../../services/tasks";
import { runWithGeneratedModelInfo } from "./modelInfo";
import {
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import {
  runTripoAnimationRetarget,
  runTripoRetopology,
  runTripoRig,
} from "./tripoOps";

/** 模型后处理统一使用 Tripo v3；UV 展开是唯一保留的混元能力。 */

export type MeshOperation = "retopo" | "rig" | "animation";

function startTripoTask(
  context: unknown,
  kind: MeshOperation,
  subject: string,
  input: Record<string, unknown>,
  run: (
    projectSlug: string,
    apiKey: string,
    onPhase: (phase: GenerationPhase) => Promise<void>,
  ) => Promise<unknown>,
) {
  const projectSlug = requireCurrentProject(context as never);
  const apiKey = requireContextString(
    context as never,
    "tripo3dApiKey",
    "本机 chat/.env 未配置 TRIPO_KEY",
  );
  const task = startCustomTask(kind, projectSlug, subject, (task) =>
    // 后处理都是「提交 → 轮询 → 下载」，阶段必须落盘（否则全程停在 queued）
    run(projectSlug, apiKey, (phase) => task.setPhase(phase)),
    { assetSlug: String(input.assetSlug), cloudOperation: { operation: kind, input } },
  );
  return { task: { id: task.id, subject: task.subject, status: task.status } };
}

export const retopologizeTool = createTool({
  id: "retopologize",
  description:
    "降面工具：通过 Tripo v3 智能重拓扑/减面资产库中的模型（付费操作——启动前须经用户同意；高模生成完成后要主动用 ask-user 问一次）。三角面目标 500–20000，四边面目标 500–10000；省略 targetPolycount 时由 Tripo 自适应。产物是**新的一代**（原高模保留，视口与摆放自动用最新一代），所以减面糊了也不用重新生成。任务化返回",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    targetPolycount: z
      .number()
      .int()
      .min(TRIPO_DECIMATE_FACES.triangle.min)
      .max(TRIPO_DECIMATE_FACES.triangle.max)
      .optional(),
    topology: z.enum(["quad", "triangle"]).default("triangle"),
    tripoModel: z.enum(["v2.0", "v1.0"]).optional(),
    /** Tripo v2 专用：把纹理烘焙到低模 */
    bake: z.boolean().optional(),
  }),
  execute: async (input, context) =>
    startTripoTask(context, "retopo", `重拓扑：${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
      // 结果里也带 modelInfo：交付时能如实报出"现在多少面"（降面任务本身不再触发降面卡片）
      runWithGeneratedModelInfo(getAssetStorage(), projectSlug, input.assetSlug, () =>
        runTripoRetopology(
          getAssetStorage(),
          {
            projectSlug,
            assetSlug: input.assetSlug,
            faceLimit: input.targetPolycount,
            quad: input.topology === "quad",
            model: input.tripoModel,
            bake: input.bake,
          },
          { apiKey, onPhase },
        ),
      ),
    ),
});

export const rigModelTool = createTool({
  id: "rig-model",
  description:
    "通过 Tripo v3 为资产库中的模型绑骨蒙皮（付费操作——启动前须经用户同意）。支持人形、四足、六足、八足、禽类、蛇形和水生骨架；非 Tripo 资产会自动导入。任务化返回",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    rigType: z
      .enum(["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic"])
      .optional(),
    spec: z.enum(["tripo", "mixamo"]).optional(),
    tripoRigModel: z.enum(["v1.0-20240301", "v2.5-20260210"]).optional(),
  }),
  execute: async (input, context) =>
    startTripoTask(context, "rig", `绑骨蒙皮：${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
      runTripoRig(
        getAssetStorage(),
        {
          projectSlug,
          assetSlug: input.assetSlug,
          rigType: input.rigType,
          spec: input.spec,
          model: input.tripoRigModel,
        },
        { apiKey, onPhase },
      ),
    ),
});

export const generateAnimationTool = createTool({
  id: "generate-animation",
  description:
    "通过 Tripo v3 /animations/retarget 将官方预设动作应用到已有模型（付费操作——启动前须经用户同意）。必须先完成 rig-model 或 generate-character，工具引用该资产最近一次成功的 Tripo 绑骨任务，不会自动重新绑骨。animation 是官方 preset: 标识：v1.0 人形使用 preset:biped:walk/run/idle 等；v2.5 人形使用 preset:walk/run/idle 等，四足使用 preset:quadruped:walk。动作必须匹配绑骨版本和骨架类型，不支持自由文本生成动作。输出包含模型几何与烘焙动画的 GLB；animateInPlace=true 时原地播放。任务化返回，用 list-generation-tasks 跟进。",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    animation: z.string().regex(/^preset:[A-Za-z0-9_:-]+$/),
    animateInPlace: z.boolean().optional(),
  }),
  execute: async (input, context) =>
    startTripoTask(context, "animation", `动画生成：${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
      runTripoAnimationRetarget(
        getAssetStorage(),
        { projectSlug, ...input },
        { apiKey, onPhase },
      ),
    ),
});
