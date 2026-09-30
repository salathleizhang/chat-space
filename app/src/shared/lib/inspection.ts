/**
 * "视觉自检"的数据契约。**不得**导入 three / playcanvas / 任何渲染组件。
 *
 * 它描述的是**上层（`pages/AppDashboard` 的 agent 对话逻辑）与执行者（四视角截图）之间**的约定：
 * 上层发起一次检查、执行者完成后回传同一 id 合成的检查图。截图本身在渲染层里做，
 * 但请求与结果都是纯数据，所以定义放在这里。
 *
 * 为什么单独成文件：这个类型原先住在 `widgets/ModelPreviewWindow/index.tsx` 里，
 * 而那个文件是 three 组件。上层只为取一个字段的**类型**就被迫依赖整个渲染组件——
 * 渲染层换引擎时编辑层会被牵连。`pages/editingLayerBoundary.test.ts` 会守住这条边界。
 */

export interface InspectionRequest {
  /** 截图批次 id（来自 agent 工具调用的 toolCallId） */
  id: string;
}
