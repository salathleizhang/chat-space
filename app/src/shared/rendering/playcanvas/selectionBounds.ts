import type { Vec3 } from "../../../shared/lib/cameraRig";

/**
 * 选中/悬浮**线框包围盒**的纯数学。对应 three 侧 `widgets/Viewport/ModelMesh.tsx` 的
 * `localBounds` + `HighlightBox`（三态、白线、`depthTest=false`、外扩 2%）。
 *
 * ### 与 three 侧的两处**有意**差异
 * ① **世界坐标盒，不是"root 局部盒"**：three 侧要局部盒是因为它把 `Box3Helper` 挂成资产的
 *    子节点（挂世界盒会整体错位）。这里线框是**独立实体**，直接按世界 AABB 摆位置/缩放，
 *    不需要局部空间换算，也就没有那类错位风险。
 * ② **用单位立方体的棱网格 + 实体缩放**，而不是每次重建顶点：`set(bounds)` 只改实体的
 *    位置与缩放，改选中目标是常数代价。
 */

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/** 高亮线框颜色：与 three 侧同源（本产品是单色 chrome，没有品牌色）。 */
export const HIGHLIGHT_COLOR: [number, number, number] = [1, 1, 1];
/** 悬浮态透明度（three 侧 `HOVER_OPACITY`）。 */
export const HOVER_OPACITY = 0.35;
/** 外扩比例：严丝合缝贴着模型表面画会共面 z-fighting（three 侧 `BOX_PADDING_RATIO`）。 */
export const BOX_PADDING_RATIO = 0.02;

/** 三态只影响线框，不碰模型自身材质（three 侧 `Highlight`）。 */
export type Highlight = "none" | "hover" | "selected";

/** 由"中心 + 半长"的盒（拾取模块给的就是这个形状）转成 min/max。 */
export function boundsFromCenterHalfExtents(center: Vec3, halfExtents: Vec3): Bounds3 {
  return {
    min: [center[0] - halfExtents[0], center[1] - halfExtents[1], center[2] - halfExtents[2]],
    max: [center[0] + halfExtents[0], center[1] + halfExtents[1], center[2] + halfExtents[2]],
  };
}

/** 合并多个盒（多选时把成员的盒并起来）。空列表返回 null。 */
export function unionBounds(boxes: readonly Bounds3[]): Bounds3 | null {
  if (boxes.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (box.min[axis]! < min[axis]!) min[axis] = box.min[axis]!;
      if (box.max[axis]! > max[axis]!) max[axis] = box.max[axis]!;
    }
  }
  return { min, max };
}

export function boundsCenter(bounds: Bounds3): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

export function boundsSize(bounds: Bounds3): Vec3 {
  return [
    Math.abs(bounds.max[0] - bounds.min[0]),
    Math.abs(bounds.max[1] - bounds.min[1]),
    Math.abs(bounds.max[2] - bounds.min[2]),
  ];
}

/** 外扩：按**最大边长**的 `ratio` 撑开（三轴同量，避免非等比变形）。 */
export function paddedBounds(bounds: Bounds3, ratio: number = BOX_PADDING_RATIO): Bounds3 {
  const size = boundsSize(bounds);
  const pad = Math.max(size[0], size[1], size[2]) * ratio;
  if (!Number.isFinite(pad) || pad <= 0) return bounds;
  return {
    min: [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad],
    max: [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad],
  };
}

/** 单位立方体（±0.5）的 12 条棱、24 个顶点：`PRIMITIVE_LINES` 的 line-list。 */
export const UNIT_CUBE_EDGE_POSITIONS: readonly number[] = (() => {
  const corners: Vec3[] = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) corners.push([x, y, z]);
    }
  }
  // 角点按二进制编号：bit0=x、bit1=y、bit2=z；只有一位不同的两角之间连一条棱
  const edges: number[] = [];
  for (let a = 0; a < corners.length; a += 1) {
    for (let b = a + 1; b < corners.length; b += 1) {
      const differing = (a ^ b).toString(2).split("").filter((bit) => bit === "1").length;
      if (differing === 1) edges.push(...corners[a]!, ...corners[b]!);
    }
  }
  return edges;
})();

/**
 * 任意盒的 12 条棱顶点（`PRIMITIVE_LINES` 顺序）。
 * 引擎侧其实用单位立方体 + 实体缩放，这个函数是它的**可测参照**（两者必须一致）。
 */
export function wireframePositions(bounds: Bounds3): number[] {
  const center = boundsCenter(bounds);
  const size = boundsSize(bounds);
  const out: number[] = [];
  for (let i = 0; i < UNIT_CUBE_EDGE_POSITIONS.length; i += 3) {
    out.push(
      center[0] + UNIT_CUBE_EDGE_POSITIONS[i]! * size[0],
      center[1] + UNIT_CUBE_EDGE_POSITIONS[i + 1]! * size[1],
      center[2] + UNIT_CUBE_EDGE_POSITIONS[i + 2]! * size[2],
    );
  }
  return out;
}

/** 三态 → 是否可见 + 透明度（three 侧：none 不画、hover 淡、selected 实）。 */
export function highlightAppearance(style: Highlight): { visible: boolean; opacity: number } {
  if (style === "none") return { visible: false, opacity: 0 };
  return { visible: true, opacity: style === "hover" ? HOVER_OPACITY : 1 };
}
