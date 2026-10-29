import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GenerationPhase } from "../../dto/tasks";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import { LOCAL_RETOPO_FACES, runLocalRetopology } from "../../services/localRetopo";
import { startCustomTask } from "../../services/tasks";
import { runWithGeneratedModelInfo } from "./modelInfo";
import {
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import { runTripoAnimationRetarget, runTripoRig } from "./tripoOps";

/** 绑定/动画仍走 Tripo v3；减面已改成本地 meshoptimizer（不调任何 API）。UV 展开是唯一保留的混元能力。 */

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
    "Decimate a model in the asset library **locally** (meshoptimizer in-process — no API key, no credits, no cost; do not ask for payment consent). You choose the target face count. Triangle target 40–40000; when targetPolycount is omitted the system picks a size-aware default (roughly sqrt(triangles)×3, capped at 2,000). Practical guidance for furniture/props: 5,000–20,000 keeps the model looking identical and keeps its texture; 1,000–3,000 is a usable LOD; 300–800 starts to lose shape; below 300 thin parts (legs, handles) collapse and the result no longer reads as the same object. The output is a **new generation** (the original high-poly is kept, and the viewport and placement switch to the latest generation automatically), so a bad result costs nothing to redo with a different number. Returns a task",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    /** 省略时按资产面数自适应；Agent 可以按用途自己给数 */
    targetPolycount: z
      .number()
      .int()
      .min(LOCAL_RETOPO_FACES.min)
      .max(LOCAL_RETOPO_FACES.max)
      .optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context as never);
    const task = startCustomTask(
      "retopo",
      projectSlug,
      `Decimation: ${input.assetSlug}`,
      (task) =>
        // 结果里带 modelInfo：交付时能如实报出"现在多少面"
        runWithGeneratedModelInfo(getAssetStorage(), projectSlug, input.assetSlug, () =>
          runLocalRetopology(getAssetStorage(), {
            projectSlug,
            assetSlug: input.assetSlug,
            targetPolycount: input.targetPolycount,
            onPhase: (phase) => task.setPhase(phase),
          }),
        ),
      {
        assetSlug: input.assetSlug,
        // 浏览器本地版把这个操作丢给 Worker 执行（同一个函数，WebIO 替换 NodeIO）
        cloudOperation: { operation: "retopo", input },
      },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
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
