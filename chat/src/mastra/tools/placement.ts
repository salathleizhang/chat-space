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
    "Place all generated models back at their corresponding positions in the 3D world according to the reference image (free, calls no provider). Positions are computed from the normalized boxes recorded by analyze-reference and the camera estimate: the lower an object's ground-contact pixel, the closer it is, horizontal position is converted through the field of view, and the soles sit on the world's real ground. Use it to backfill placement after a complete scene generation, to re-lay-out an old scene, or to place furniture newly added by revise-scene-job. Its result is written straight into scene.json and the user can still fine-tune with the gizmo. The return lists the objects that could not be placed and why: when a box is missing, pass the normalized box you see in the reference image via items (or run analyze-reference again); when a model is missing, generate it first. **It refuses outright when the project does not yet have a confirmed complete scene (no SceneSpec)** — in that case do not re-run the complete scene just to place things; use place-object to place by explicit position or onto a target asset's surface.",
  inputSchema: PlaceSceneObjectsInputSchema,
  execute: async (input, context) =>
    runScenePlacement(getAssetStorage(), requireCurrentProject(context), input),
});
