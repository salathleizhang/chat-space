/**
 * "视觉自检"的数据契约。**不得**导入 three / playcanvas / 任何渲染组件。
 *
 * 它描述的是**上层（`pages/AppDashboard` 的 agent 对话逻辑）与执行者（截图）之间**的约定：
 * 上层发起一次检查、执行者完成后回传同一 id 合成的检查图。截图本身在渲染层里做，
 * 但请求与结果都是纯数据，所以定义放在这里。
 *
 * 为什么单独成文件：这个类型原先住在 `widgets/ModelPreviewWindow/index.tsx` 里，
 * 而那个文件是 three 组件。上层只为取一个字段的**类型**就被迫依赖整个渲染组件——
 * 渲染层换引擎时编辑层会被牵连。`pages/editingLayerBoundary.test.ts` 会守住这条边界。
 */

import type { InspectionViewId } from "./inspectionSheet";

/**
 * 检查谁：
 * - `asset`：一个资产自己的模型，执行者是预览小窗（拍几个面，默认四视角）；
 * - `scene`：当前项目的整个场景，执行者是主视口（按一个机位拍一张）。
 *
 * 两者共用"截图 → 落盘 → resume 交回模型"的回传通道，只是执行者与版式不同。
 */
export type InspectionTarget = "asset" | "scene";

export interface InspectionRequest {
  /** 截图批次 id（来自 agent 工具调用的 toolCallId） */
  id: string;
  target: InspectionTarget;
  /**
   * 要拍的视角 id（见 `inspectionSheet.ts` 的 `INSPECTION_VIEW_IDS`）。
   * `asset` 省略 = 默认四视角 ISO/前/右/顶；`scene` 只取第一个作为机位，省略 = ISO。
   */
  views?: InspectionViewId[];
}
