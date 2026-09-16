export type LayoutMode = 1 | 2 | 4;
export type CameraKind = "perspective" | "top" | "front" | "right";
/** 与 CameraKind 解耦：CameraKind 只决定窗格的初始机位预设，Projection 决定当前实际渲染用透视还是正交投影，可自由切换 */
export type Projection = "perspective" | "orthographic";

export interface PaneSpec {
  id: string;
  camera: CameraKind;
  label: string;
}

const PERSPECTIVE: PaneSpec = { id: "persp", camera: "perspective", label: "透视" };
const TOP: PaneSpec = { id: "top", camera: "top", label: "顶视图" };
const FRONT: PaneSpec = { id: "front", camera: "front", label: "前视图" };
const RIGHT: PaneSpec = { id: "right", camera: "right", label: "右视图" };

/** Blender 式布局预设：4 视图 DOM 顺序即 2x2 CSS grid 的左上/右上/左下/右下 */
export const LAYOUTS: Record<LayoutMode, PaneSpec[]> = {
  1: [PERSPECTIVE],
  2: [PERSPECTIVE, TOP],
  4: [TOP, PERSPECTIVE, FRONT, RIGHT],
};

const GRID_TEMPLATE: Record<LayoutMode, { columns: string; rows: string }> = {
  1: { columns: "1fr", rows: "1fr" },
  2: { columns: "1fr 1fr", rows: "1fr" },
  4: { columns: "1fr 1fr", rows: "1fr 1fr" },
};

export function gridTemplateFor(layout: LayoutMode) {
  const { columns, rows } = GRID_TEMPLATE[layout];
  return { gridTemplateColumns: columns, gridTemplateRows: rows };
}
