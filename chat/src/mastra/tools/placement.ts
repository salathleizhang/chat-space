import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  CameraEstimateSchema,
  ObjectBoxSchema,
  SlugSchema,
} from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import { runScenePlacement } from "../../services/scenePlacementRun";
import { requireCurrentProject } from "./requestContext";

/**
 * 把已生成的模型按参考图摆回 3D 世界（免费、确定性）。
 *
 * 位置来源于 analyze-reference 落盘的归一化包围框与相机估计：接地像素离地平线
 * 越近纵深越大，横向位置按视场角换算，脚底贴到世界真实地面上（collider 采样，
 * 采样不到就退回 y=0）。结果写进 `scene.json` 的 transforms，与用户用 gizmo
 * 手动摆放同一张表——所以工具跑完，视口里的位置就是这份结果，并且可以继续手调。
 */
export const PlaceSceneObjectsInputSchema = z.object({
  /**
   * 逐对象的框覆盖。规格里已经有框时不必传；**旧分析没有框、或对象是
   * revise-scene-job 后加的**，就把你在这张参考图上看到的归一化框传进来。
   */
  items: z
    .array(
      z.object({
        slug: SlugSchema,
        box: ObjectBoxSchema.optional(),
        heightMeters: z.number().positive().max(20).optional(),
      }),
    )
    .optional(),
  /** 覆盖场景记录里的相机估计；不传就用 analyze-reference 当时填的。 */
  camera: CameraEstimateSchema.optional(),
});

export const placeSceneObjectsTool = createTool({
  id: "place-scene-objects",
  description:
    "按参考图把所有已生成模型摆回 3D 世界的对应位置（免费，不调用任何供应商）。位置由 analyze-reference 记录的归一化框和相机估计算出：物体接地像素越靠下越近、横向按视场角换算，脚底贴到世界真实地面。用于完整场景生成完成后补摆、旧场景重新布局、或 revise-scene-job 新增家具后的摆放。它的结果直接写进 scene.json，用户仍可用 gizmo 微调。返回里会列出没能摆放的对象及原因：缺 box 时请把你从参考图看到的归一化框用 items 传进来（或重新 analyze-reference），缺模型时先补生成。**项目还没有已确认的完整场景（没有 SceneSpec）时它会直接拒绝**——那种情况不要为了摆放去重跑完整场景，改用 place-object 按显式位置或目标资产的表面摆放。",
  inputSchema: PlaceSceneObjectsInputSchema,
  execute: async (input, context) =>
    runScenePlacement(getAssetStorage(), requireCurrentProject(context), input),
});
