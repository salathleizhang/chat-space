/**
 * 变换工具的**纯数据契约**。这里刻意不导入任何渲染库。
 *
 * 为什么单独成一个文件：这三个类型原先住在 `TransformGizmo.tsx` 里，而那个文件是 three/drei 的
 * 实现（`TransformControls` + `useFrame`）。上层 `pages/AppDashboard`（撤销栈）与
 * `useSceneHistory` 都要用 `TransformMode`，于是一旦重写 gizmo 实现，**编辑层就被迫跟着改**。
 *
 * 渲染层全量迁移到 PlayCanvas 时，`TransformGizmo.tsx` 会被删掉重写，而本文件不变——
 * 编辑层因此保持零改动。**不要把任何 `three` / `playcanvas` / React 导入加进来。**
 */

export const TRANSFORM_MODES = ["translate", "rotate", "scale"] as const;
export type TransformMode = (typeof TRANSFORM_MODES)[number];

/** 变换参考系：world = 世界轴，local = 对象自身轴（Blender 的 Global/Local） */
export type TransformSpace = "world" | "local";
