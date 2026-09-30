import type { CameraEstimate, ObjectBox, Vec3 } from "../dto/library";
import type { ModelBounds } from "./modelBounds";

/**
 * 单目反投影：把参考图上的一个物体框换算成 3D 世界里的摆放。
 *
 * 这套推导的全部假设都写在这里，因为它们是这套摆放精度的天花板：
 *
 * 1. **世界是米制、地面在 y=0**（World Labs 的 `metric_scale_factor` /
 *    `ground_plane_offset` 已经在 app 侧对齐过，见 `worldTransform.ts`），
 *    所以算出来的纵深直接就是米。
 * 2. **相机水平、位于原点、看向 −Z**，主点行 == 地平线行 == `horizonRow`：
 *    竖直方向 `纵深 = 相机高 × f / (接地行 − 地平线行)`，横向
 *    `X = 纵深 × (中心列 − 0.5) × aspect / f`，其中 `f = 0.5 / tan(竖直视场角/2)`
 *    是归一化焦距。
 * 3. **物体接地像素 = 框的底边中点**，且物体落在它自己的接地点的地面上。
 *
 * 生成出来的世界不是对原照片的度量重建（Marble 不回传相机位姿），所以这不是
 * 精确解，而是"左右顺序、相对远近、米制尺度"都站得住的近似解；用户可以再用
 * gizmo 微调——这份结果会写进 `scene.json`，与手动摆放同一条通路。
 */

export interface PlacementCamera {
  /** 地平线所在的归一化行（0 = 图顶）。 */
  horizonRow: number;
  /** 拍摄高度（米）。 */
  cameraHeightMeters: number;
  /** 竖直视场角（度）。 */
  verticalFovDeg: number;
}

export const DEFAULT_PLACEMENT_CAMERA: PlacementCamera = {
  horizonRow: 0.5,
  cameraHeightMeters: 1.5,
  verticalFovDeg: 60,
};

/**
 * 接地像素离地平线过近时推算出的纵深趋于无穷。夹到 12 m：比任何真实室内都远，
 * 又不会把物体甩到几公里外——那种位置连手动纠回来都困难。
 */
export const MAX_PLACEMENT_DEPTH = 12;

/** 低于这个归一化行距就认定"贴着地平线"，按最远纵深处理。 */
const MIN_HORIZON_GAP = 0.02;

export function resolvePlacementCamera(estimate?: CameraEstimate): PlacementCamera {
  return {
    horizonRow: estimate?.horizonRow ?? DEFAULT_PLACEMENT_CAMERA.horizonRow,
    cameraHeightMeters:
      estimate?.cameraHeightMeters ?? DEFAULT_PLACEMENT_CAMERA.cameraHeightMeters,
    verticalFovDeg: estimate?.verticalFovDeg ?? DEFAULT_PLACEMENT_CAMERA.verticalFovDeg,
  };
}

export interface PlacementSubject {
  box: ObjectBox;
  /** 真实世界高度（米）；给了就把模型缩放到这个高度。 */
  heightMeters?: number;
  /** 模型自身的包围盒（未摆放）；缺了就只能贴到地面而不做尺寸归一。 */
  bounds?: ModelBounds;
}

export interface PlacementContext {
  camera: PlacementCamera;
  /** 源图宽高比 W/H；归一化横向要乘它才是真实横向视场。 */
  aspect: number;
  /** 某个 (x, z) 处的地面高度；没有地形数据时返回 null，按 y=0 处理。 */
  sampleGround?: (x: number, z: number) => number | null;
}

export interface Placement {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** 推算出的纵深（米），只为让调用方能如实报告依据。 */
  depth: number;
  /** 脚底高度是否来自真实地形（false = 落在假定的 y=0 平面上）。 */
  grounded: boolean;
  /** 纵深是否被夹到上限（物体几乎贴着地平线）。 */
  clamped: boolean;
}

export function computePlacement(
  subject: PlacementSubject,
  context: PlacementContext,
): Placement {
  const { camera, aspect } = context;
  const [x0, , x1, y1] = subject.box;
  const centerU = (x0 + x1) / 2;
  // 接地像素：框的底边中点。
  const contactV = y1;
  const focal = 0.5 / Math.tan((camera.verticalFovDeg * Math.PI) / 360);
  const gap = contactV - camera.horizonRow;
  const clamped = gap < MIN_HORIZON_GAP;
  const depth = clamped
    ? MAX_PLACEMENT_DEPTH
    : Math.min(MAX_PLACEMENT_DEPTH, (camera.cameraHeightMeters * focal) / gap);
  const x = (depth * (centerU - 0.5) * aspect) / focal;
  const z = -depth;
  // 模型正面（+Z）朝向相机所在的原点，也就是朝向拍摄方向。
  const yaw = Math.atan2(-x, depth);

  const scale = placementScale(subject);
  const meshMinY = subject.bounds?.min[1];
  const groundHeight = context.sampleGround?.(x, z) ?? null;
  const floor = groundHeight ?? 0;
  // 脚底贴地：包围盒最低点落到地面上，而不是让模型原点落在地面上。
  const y = Number.isFinite(meshMinY) ? floor - scale * meshMinY! : floor;

  return {
    position: [x, y, z],
    rotation: [0, yaw, 0],
    scale: [scale, scale, scale],
    depth,
    grounded: groundHeight !== null,
    clamped,
  };
}

function placementScale(subject: PlacementSubject): number {
  const target = subject.heightMeters;
  const measured = subject.bounds?.size[1];
  if (target === undefined || measured === undefined) return 1;
  if (!Number.isFinite(measured) || measured <= 1e-6 || !Number.isFinite(target)) return 1;
  const scale = target / measured;
  // 量到的包围盒异常小（退化网格）时比例会炸到几百倍，宁可保留原尺寸。
  return scale > 0.02 && scale < 50 ? scale : 1;
}
