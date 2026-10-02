import { ArrowUUpLeftIcon } from "@phosphor-icons/react/ArrowUUpLeft";
import { ArrowUUpRightIcon } from "@phosphor-icons/react/ArrowUUpRight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowsOutCardinalIcon } from "@phosphor-icons/react/ArrowsOutCardinal";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { BoundingBoxIcon } from "@phosphor-icons/react/BoundingBox";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { CubeTransparentIcon } from "@phosphor-icons/react/CubeTransparent";
import { GlobeSimpleIcon } from "@phosphor-icons/react/GlobeSimple";
import { GridFourIcon } from "@phosphor-icons/react/GridFour";
import { MountainsIcon } from "@phosphor-icons/react/Mountains";
import { PerspectiveIcon } from "@phosphor-icons/react/Perspective";
import { PersonSimpleWalkIcon } from "@phosphor-icons/react/PersonSimpleWalk";
import { SquareIcon } from "@phosphor-icons/react/Square";
import { SquareSplitHorizontalIcon } from "@phosphor-icons/react/SquareSplitHorizontal";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { VideoCameraIcon } from "@phosphor-icons/react/VideoCamera";
import { Badge, Panel, ToolbarButton, Tooltip } from "../../shared/ui";
import type { ViewportHistory } from "./historyTypes";
import type { LayoutMode, Projection } from "./paneLayouts";
import { TRANSFORM_MODES, type TransformMode, type TransformSpace } from "./transformMode";

/**
 * 视口 chrome（**three 与 PlayCanvas 两版共用**）：右下角控制簇 + 底部徽章 + 第一人称提示。
 *
 * ### 为什么抽出来
 * 迁移期 PlayCanvas 分支自带过一版"最小工具栏"（纯文字药丸 + 内联样式），于是同一个位置
 * 两版长得不一样。**产品只有一套观感**：这里就是 three 侧那段 JSX 的原样搬家，PlayCanvas
 * 分支按同一批 props 喂它，`aria-label`/顺序/尺寸/位置一个都没动。
 *
 * ### 纪律
 * - **纯展示**：所有状态与副作用留在调用方（"进第一人称要强制单窗格"这种规则在父组件里）。
 * - 按钮的 `aria-label` 与 three 侧**同一套文案**：探针与可信驱动按它找按钮
 *   （`Single view` / `Two views` / `Four views (Blender layout)` / `Hide grid` / `Show grid` /
 *   `Undo` / `Redo` / `Enter first-person view` / `Toggle perspective/orthographic view` /
 *   `Toggle world/local coordinates` / `…shading (Shift+Z)` / `Hide world terrain (collider mesh)`）。
 * - **能没有的控件就传 `null`**：调用方给不出这段话的前置条件时（没有选中、不是单窗格、
 *   没有世界地形层…）该按钮整只不出现，不许留一个点了没反应的按钮。
 *
 * ### 与引擎无关
 * 这里不 import three / playcanvas，只依赖 `shared/ui` 与纯数据类型（`transformMode` /
 * `paneLayouts` / `historyTypes`），所以渲染层换引擎时它不动。
 */

const LAYOUT_ICON = {
  1: SquareIcon,
  2: SquareSplitHorizontalIcon,
  4: SquaresFourIcon,
} as const;

const TRANSFORM_ICON = {
  translate: ArrowsOutCardinalIcon,
  rotate: ArrowsClockwiseIcon,
  scale: ArrowsOutIcon,
} as const;

/** 快捷键跟 Blender 对齐（G/R/S），写进 tooltip 里让用户发现得到 */
export const TRANSFORM_LABEL: Record<TransformMode, string> = {
  translate: "Move (G)",
  rotate: "Rotate (R)",
  scale: "Scale (S)",
};

export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  1: "Single view",
  2: "Two views",
  4: "Four views (Blender layout)",
};

export interface ViewportChromeProps {
  /** 撤销/重做：栈在上层（两张表都归它管），这里只出按钮。不传就不显示这两个按钮 */
  history?: ViewportHistory;
  /** 变换工具组：`null` = 当前没有可变换的选中（整组按钮不出现，不留空按钮） */
  transform?: {
    mode: TransformMode;
    onMode(mode: TransformMode): void;
    space: TransformSpace;
    onSpace(space: TransformSpace): void;
  } | null;
  /** 分屏布局：第一人称下传 `null`（那个模式只有单窗格） */
  layout?: { value: LayoutMode; onChange(next: LayoutMode): void } | null;
  /** 透视/正交切换：只有单窗格才有意义，其余传 `null` */
  projection?: { value: Projection; onToggle(): void } | null;
  grid?: { visible: boolean; onToggle(): void } | null;
  /** 线框着色（`Shift+Z`）：第一人称里也留着，所以不是可空项 */
  wireframe: { on: boolean; onToggle(): void };
  /** world 的地形参照层（collider 网格）：分支里没有这条渲染路径就传 `null` */
  worldCollider?: { visible: boolean; onToggle(): void } | null;
  /** 第一人称切换：场景里没有内容就传 `null` */
  firstPerson?: { active: boolean; onToggle(): void } | null;
  /** 底部徽章与第一人称提示整块出不出现（"场景里有没有内容"） */
  hasContent: boolean;
  /** 摆进场景的模型数（three 侧 `placedAssets.length`） */
  objectCount: number;
  selectedCount: number;
  /** 世界点云背景是否真的在画（three 侧 `worldAsset != null`） */
  splatBackground: boolean;
  /**
   * 探针挂载点：PlayCanvas 分支传 `"1"`（驱动按 `[data-pc-toolbar="1"]` 找它）。
   * 真实产品与 three 分支都不传——那个钩子是给探针的，不该出现在产品 DOM 里。
   */
  "data-pc-toolbar"?: string;
}

export function ViewportChrome(props: ViewportChromeProps) {
  const { history, transform, layout, projection, grid, wireframe, worldCollider, firstPerson } = props;
  const firstPersonActive = firstPerson?.active ?? false;

  return (
    <>
      {/*
        右下角悬浮控件：撤销/重做、变换工具与视图控制是三件事，各自一个面板并排（变换那组只在有选中时出现）。

        **`z-20` 不是随手写的大数**（2026-10-02 实测）：应用外壳那排输入框的容器也是 `z-10`
        （`AgentDock` 的 `pointer-events-none absolute inset-x-0 bottom-5 z-10`），而它在 DOM 里
        排在视口**之后**——平级 z-index 下后来者赢，于是窄窗口（实测 1500×950）里输入框盖住控制簇
        左半截：`document.elementFromPoint()` 在 `Undo/Redo/Move/Rotate/Scale` 的按钮中心返回的是
        外壳的 DIV，**这几个按钮点不动**（右半截在外面，正常）。抬到 20 之后它们全部可点；代价是
        重叠的那 ~11 px 从输入框的"发送"按钮底边换成控制簇（发送按钮中心仍在原位，仍可点）。
        上限不能被下面这层压住、也不能压住浮层：下拉/气泡是 `z-40/z-50`，预览小窗在右上角的 `z-20`。
      */}
      <div
        className="absolute bottom-4 right-4 z-20 flex items-center gap-2"
        {...(props["data-pc-toolbar"] ? { "data-pc-toolbar": props["data-pc-toolbar"] } : {})}
      >
        {/*
          撤销/重做：栈在上层（两张表都归它管），这里只出按钮。
          空栈时保持禁用而不是隐藏——按钮忽隐忽现会让这一排控件整体位移。
        */}
        {history && (
          <Panel className="flex items-center gap-1 rounded-full! p-1 animate-chrome-enter">
            <Tooltip
              content={history.undoLabel ? `Undo: ${history.undoLabel} (Cmd/Ctrl+Z)` : "Undo (Cmd/Ctrl+Z)"}
              side="top"
            >
              <ToolbarButton
                disabled={!history.canUndo}
                icon={ArrowUUpLeftIcon}
                aria-label="Undo"
                onClick={history.undo}
              />
            </Tooltip>
            <Tooltip
              content={history.redoLabel ? `Redo: ${history.redoLabel} (Cmd/Ctrl+Shift+Z)` : "Redo (Cmd/Ctrl+Shift+Z)"}
              side="top"
            >
              <ToolbarButton
                disabled={!history.canRedo}
                icon={ArrowUUpRightIcon}
                aria-label="Redo"
                onClick={history.redo}
              />
            </Tooltip>
          </Panel>
        )}

        {/* 变换工具只在选中了东西时出现——没有作用对象的移动/旋转/缩放按钮是空按钮 */}
        {transform && (
          <Panel className="flex items-center gap-1 rounded-full! p-1 animate-chrome-enter">
            {TRANSFORM_MODES.map((m) => (
              <Tooltip key={m} content={TRANSFORM_LABEL[m]} side="top">
                <ToolbarButton
                  selected={transform.mode === m}
                  aria-pressed={transform.mode === m}
                  icon={TRANSFORM_ICON[m]}
                  aria-label={TRANSFORM_LABEL[m]}
                  onClick={() => transform.onMode(m)}
                />
              </Tooltip>
            ))}
            <Tooltip
              content={
                transform.mode === "scale"
                  ? "Scale uses the object's local axes"
                  : transform.space === "world"
                    ? "Current: world coordinates (click for local)"
                    : "Current: local coordinates (click for world)"
              }
              side="top"
            >
              <ToolbarButton
                // 缩放模式下 TransformControls 内部强制走 local，按钮留着可点会是句谎话
                disabled={transform.mode === "scale"}
                icon={transform.space === "world" ? GlobeSimpleIcon : BoundingBoxIcon}
                aria-label="Toggle world/local coordinates"
                onClick={() => transform.onSpace(transform.space === "world" ? "local" : "world")}
              />
            </Tooltip>
          </Panel>
        )}

        {/* 视图控制：分屏布局 + 透视/正交 + 网格开关 + 第一人称切换 */}
        <Panel className="flex items-center gap-1 rounded-full! p-1 animate-chrome-enter">
          {layout && (
            <div className="flex items-center gap-1">
              {([1, 2, 4] as const).map((n) => (
                <Tooltip key={n} content={LAYOUT_LABEL[n]} side="top">
                  <ToolbarButton
                    selected={layout.value === n}
                    aria-pressed={layout.value === n}
                    icon={LAYOUT_ICON[n]}
                    aria-label={LAYOUT_LABEL[n]}
                    onClick={() => layout.onChange(n)}
                  />
                </Tooltip>
              ))}
            </div>
          )}
          {projection && (
            <Tooltip
              content={projection.value === "perspective" ? "Switch to orthographic view" : "Switch to perspective view"}
              side="top"
            >
              <ToolbarButton
                icon={projection.value === "perspective" ? PerspectiveIcon : CubeIcon}
                aria-label="Toggle perspective/orthographic view"
                onClick={projection.onToggle}
              />
            </Tooltip>
          )}
          {grid && (
            <Tooltip content={grid.visible ? "Hide grid" : "Show grid"} side="top">
              <ToolbarButton
                selected={grid.visible}
                aria-pressed={grid.visible}
                icon={GridFourIcon}
                aria-label={grid.visible ? "Hide grid" : "Show grid"}
                onClick={grid.onToggle}
              />
            </Tooltip>
          )}
          {/*
            线框着色模式：第一人称里也留着（看的是同一条场景，没有理由只在轨道模式下可用）。
            它只改模型的画法，泼溅世界/天空盒/网格/HUD 都不动——见 wireframeMaterial.ts。
          */}
          <Tooltip content={wireframe.on ? "Solid shading (Shift+Z)" : "Wireframe shading (Shift+Z)"} side="top">
            <ToolbarButton
              selected={wireframe.on}
              aria-pressed={wireframe.on}
              icon={CubeTransparentIcon}
              aria-label={wireframe.on ? "Solid shading (Shift+Z)" : "Wireframe shading (Shift+Z)"}
              onClick={wireframe.onToggle}
            />
          </Tooltip>
          {worldCollider && (
            <Tooltip
              content={
                worldCollider.visible
                  ? "Hide world terrain (collider mesh)"
                  : "Show world terrain (collider mesh)"
              }
              side="top"
            >
              <ToolbarButton
                selected={worldCollider.visible}
                aria-pressed={worldCollider.visible}
                icon={MountainsIcon}
                aria-label={
                  worldCollider.visible
                    ? "Hide world terrain (collider mesh)"
                    : "Show world terrain (collider mesh)"
                }
                onClick={worldCollider.onToggle}
              />
            </Tooltip>
          )}
          {firstPerson && (
            <Tooltip
              content={firstPersonActive ? "Return to orbit top view" : "First-person navigation (WASD to move)"}
              side="top"
            >
              <ToolbarButton
                selected={firstPersonActive}
                aria-pressed={firstPersonActive}
                icon={firstPersonActive ? VideoCameraIcon : PersonSimpleWalkIcon}
                aria-label={firstPersonActive ? "Return to orbit view" : "Enter first-person view"}
                onClick={firstPerson.onToggle}
              />
            </Tooltip>
          )}
        </Panel>
      </div>

      {props.hasContent && (
        <>
          {firstPersonActive && (
            <Panel className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs text-ink-subtle">
              Click the viewport to lock view · WASD to move · Shift to sprint · Esc to release mouse
            </Panel>
          )}

          <div className="pointer-events-none absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-2">
            <Badge>{props.objectCount} objects</Badge>
            {props.selectedCount > 0 && <Badge>Selected: {props.selectedCount}</Badge>}
            {wireframe.on && <Badge>Wireframe</Badge>}
            {props.splatBackground && <Badge>Gaussian splat background</Badge>}
          </div>
        </>
      )}
    </>
  );
}
