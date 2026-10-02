/**
 * 视口工具栏需要的"撤销/重做"形状。**独立成文件**是为了让 `ViewportToolbar` 不依赖
 * `widgets/Viewport/index.tsx`（那是 three 侧那一版，工具栏要两版共用）。
 * `ViewportProps.history` 按结构兼容它，不需要改任何调用点。
 */
export interface ViewportHistory {
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** 上一步/下一步的动作名，用作按钮提示，例如"移动 黑猫" */
  undoLabel?: string;
  redoLabel?: string;
}