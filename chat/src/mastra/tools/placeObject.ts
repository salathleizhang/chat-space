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
    "把一个或几个**已经生成好的**模型摆到当前场景的指定位置（免费、确定性、不调用任何供应商，**不需要**项目有完整场景规格）。与 place-scene-objects 的分工：那个按参考图把整套家具摆回原位、要求项目已有已确认场景；这个用于已知目标位置的摆放——补一个新对象（例如「把小熊放到沙发坐垫上」）、按真实尺寸纠正比例、或把摆歪的对象纠回来。\n\n每个 item 的位置二选一：① onSurfaceOf={slug, offset?} 落到另一个资产的**上表面**：默认在目标包围盒中心的竖直方向取最高的一层（坐垫/桌面/床垫都是这个），offset=[dx,dy,dz]（米）把采样点在世界 XZ 上挪开（例如避开沙发靠背与扶手）、并把落点抬高 dy；要落上去的目标必须在**同一次调用里先摆好**（数组顺序有效）。② position=[x,y,z] 直接给世界坐标，语义是物体**包围盒底面中心**的落点（不是模型原点），y=0 就是地面。\n\n另外三组参数各自互斥、每组只能给一个，同时给会报错：真实高度 heightMeters（米）与直接缩放 scale（生成器把模型归一化到最长边 1 单位，所以**不给真实高度时不同资产之间没有可比的比例**——一只玩偶会和一张沙发一样大）；朝向 yawDegrees（只绕 +Y 的角度）与 rotation=[rx,ry,rz]（弧度、XYZ 序）。\n\n结果写进工程的 scene.json（与用户手动拖 gizmo 同一张表，用户仍可在视口里微调），只覆盖本次点名的对象。返回 placed（实际写入的原点位置/旋转/缩放、底面落点、摆放后的世界包围盒）与 skipped（对象及原因：no_model=缺模型、no_bounds=量不到包围盒、no_surface=那个采样点取不到上表面、surface_target_missing=目标资产不存在、surface_target_no_model=目标缺模型、world_asset=背景不参与摆放），如实转述，不要谎称已摆好。",
  inputSchema: PlaceObjectInputSchema,
  execute: async (input, context) =>
    placeObjects(getAssetStorage(), requireCurrentProject(context), input.items),
});
