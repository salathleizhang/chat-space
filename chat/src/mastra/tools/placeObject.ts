import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SlugSchema, Vec3Schema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import { placeObjects } from "../../services/objectPlacement";
import { requireCurrentProject } from "./requestContext";

/**
 * 显式摆放：给位置就摆，不需要场景分析（SceneSpec）。
 *
 * 与 `place-scene-objects` 的分工写进了 description（模型只看得见描述）：
 * 那个按参考图重算整套布局、要求项目已有已确认场景；这个只回答"把某个资产摆在哪"，
 * 于是"给已有场景补一个玩偶""按真实尺寸纠正比例""手动纠偏"都有路可走。
 */
export const ObjectPlacementItemSchema = z.object({
  slug: SlugSchema,
  /** 物体**包围盒底面中心**的世界落点（不是模型原点）。 */
  position: Vec3Schema.optional(),
  /** 落到另一个资产的上表面；目标必须在同一项目里且已有模型产物。 */
  onSurfaceOf: z
    .object({
      slug: SlugSchema,
      /** x/z 在目标表面上挪采样点、y 抬高落点（米）。 */
      offset: Vec3Schema.optional(),
    })
    .optional(),
  heightMeters: z.number().positive().max(20).optional(),
  scale: z.number().positive().max(100).optional(),
  /** 弧度、XYZ 序，与 scene.json 的摆放同一套。 */
  rotation: Vec3Schema.optional(),
  yawDegrees: z.number().optional(),
});

export const PlaceObjectInputSchema = z.object({
  items: z.array(ObjectPlacementItemSchema).min(1),
});

export const placeObjectTool = createTool({
  id: "place-object",
  description:
    "Place one or several **already generated** models at specified positions in the current scene (free, deterministic, calls no provider, and does **not** require the project to have a complete scene spec). Division of labor with place-scene-objects: that one puts the whole set of furniture back where it was according to the reference image and requires the project to already have a confirmed scene; this one is for placement where the target position is known — adding a new object (for example \"put the teddy bear on the sofa cushion\"), correcting proportions to real size, or fixing an object that was placed crookedly.\n\nThe position of each item is one of two options: ① onSurfaceOf={slug, offset?} lands it on another asset's **top surface**: by default it takes the highest layer along the vertical through the target's bounding-box center (cushions/tabletops/mattresses are all this), and offset=[dx,dy,dz] (meters) moves the sample point around in world XZ (for example to avoid the sofa's backrest and armrests) and raises the landing point by dy; the target you want to land on must already be placed **earlier in the same call** (array order matters). ② position=[x,y,z] gives world coordinates directly, with the semantics of the landing point of the object's **bounding-box bottom-face center** (not the model origin); y=0 is the ground.\n\nThe other three groups of parameters are each mutually exclusive and each group accepts only one — giving both at once is an error: real height heightMeters (meters) versus direct scale scale (the generator normalizes models so the longest edge is 1 unit, so **without a real height there is no comparable scale between different assets** — a doll ends up as big as a sofa); orientation yawDegrees (an angle around +Y only) versus rotation=[rx,ry,rz] (radians, XYZ order).\n\nThe result is written into the project's scene.json (the same table the user edits by dragging the gizmo, so the user can still fine-tune it in the viewport), and it only overwrites the objects named in this call. The return carries placed (the origin position/rotation/scale actually written, the bottom-face landing point, and the world bounding box after placement) and skipped (the objects and the reason: no_model=no model, no_bounds=the bounding box could not be measured, no_surface=no top surface at that sample point, surface_target_missing=the target asset does not exist, surface_target_no_model=the target has no model, world_asset=the background does not take part in placement); relay them faithfully and do not claim something was placed when it was not.",
  inputSchema: PlaceObjectInputSchema,
  execute: async (input, context) =>
    placeObjects(getAssetStorage(), requireCurrentProject(context), input.items),
});
