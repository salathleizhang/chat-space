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
    "TRIPO_KEY is not configured in the local chat/.env",
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
    "Decimation tool: intelligently retopologize/decimate a model in the asset library via Tripo v3 (paid operation — user consent is required before starting; after a high-poly model is generated, proactively ask once with ask-user). Triangle target 500–20000, quad target 500–10000; when targetPolycount is omitted, Tripo adapts automatically. The output is a **new generation** (the original high-poly model is kept, and the viewport and placement automatically use the latest generation), so you do not need to regenerate if the decimation looks bad. Returns a task",
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
    startTripoTask(context, "retopo", `Retopology: ${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
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
    "Rig and skin a model in the asset library via Tripo v3 (paid operation — user consent is required before starting). Supports humanoid, quadruped, hexapod, octopod, avian, serpentine and aquatic skeletons; non-Tripo assets are imported automatically. Returns a task",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    rigType: z
      .enum(["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic"])
      .optional(),
    spec: z.enum(["tripo", "mixamo"]).optional(),
    tripoRigModel: z.enum(["v1.0-20240301", "v2.5-20260210"]).optional(),
  }),
  execute: async (input, context) =>
    startTripoTask(context, "rig", `Rigging and skinning: ${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
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
    "Apply an official preset animation to an existing model via Tripo v3 /animations/retarget (paid operation — user consent is required before starting). You must first complete rig-model or generate-character; the tool references the asset's most recent successful Tripo rig task and will not rig automatically. animation is an official preset: identifier: v1.0 humanoids use preset:biped:walk/run/idle etc.; v2.5 humanoids use preset:walk/run/idle etc., and quadrupeds use preset:quadruped:walk. The animation must match the rig version and skeleton type; free-text animation generation is not supported. The output is a GLB containing the model geometry and baked animation; with animateInPlace=true it plays in place. Returns a task; follow up with list-generation-tasks.",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    animation: z.string().regex(/^preset:[A-Za-z0-9_:-]+$/),
    animateInPlace: z.boolean().optional(),
  }),
  execute: async (input, context) =>
    startTripoTask(context, "animation", `Animation generation: ${input.assetSlug}`, input, (projectSlug, apiKey, onPhase) =>
      runTripoAnimationRetarget(
        getAssetStorage(),
        { projectSlug, ...input },
        { apiKey, onPhase },
      ),
    ),
});
