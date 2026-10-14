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
import { HandGrabbingIcon } from "@phosphor-icons/react/HandGrabbing";
import { HandPointingIcon } from "@phosphor-icons/react/HandPointing";
import { MountainsIcon } from "@phosphor-icons/react/Mountains";
import { PerspectiveIcon } from "@phosphor-icons/react/Perspective";
import { PersonSimpleWalkIcon } from "@phosphor-icons/react/PersonSimpleWalk";
import { SquareIcon } from "@phosphor-icons/react/Square";
import { SquareSplitHorizontalIcon } from "@phosphor-icons/react/SquareSplitHorizontal";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { VideoCameraIcon } from "@phosphor-icons/react/VideoCamera";
import { createPortal } from "react-dom";
import { Badge, Panel, ToolbarButton, Tooltip, useDockSlot } from "../../shared/ui";
import type { ViewportHistory } from "./historyTypes";
import type { LayoutMode, Projection } from "./paneLayouts";
import { TRANSFORM_MODES, type TransformMode, type TransformSpace } from "./transformMode";

/**
 * 视口 chrome（**three 与 PlayCanvas 两版共用**）：控制簇 + 撤销/重做 + 底部徽章 + 第一人称提示。
 *
 * ### 两块控件画在哪
 * - 应用外壳（`pages/AppDashboard`）登记了**底部停靠区**的槽位时（`shared/ui/dockRow.ts`），
 *   控制簇 portal 进停靠行右端那一格（左端是 Sidebar），**撤销/重做单独去屏幕右下角那一格**，
 *   与停靠行同底对齐——所以它和菜单一样高，但落在屏幕的角上。
 * - 没有外壳时（探针页 `app/pc-panes.html` / `pc-viewport` 那类宿主）走**旧位置**：
 *   控制簇（含撤销/重做，顺序不变）整块贴在右下角 `absolute bottom-4 right-4`。
 *   可信驱动的判据只看 `aria-label` 与按钮盒子，两种落点下都在 DOM 里，不受影响。
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
 *   `Undo` / `Redo` / `Enter first-person view` / `Enable hand tracking` /
 *   `Toggle perspective/orthographic view` /
 *   `Toggle world/local coordinates` / `…shading (Shift+Z)` / `Hide world terrain (collider mesh)`）。
 * - **能没有的控件就传 `null`**：调用方给不出这段话的前置条件时（没有选中、不是单窗格、
 *   没有世界地形层…）该按钮整只不出现，不许留一个点了没反应的按钮。
 * - **撤销/重做搬去角落时不能改变按钮顺序**：`history` 缺省那份仍是簇里的第一组，
 *   只给了 `corner` 槽位时才拆出去（`ViewportChrome.test.ts` 两态都钉）。
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
  /**
   * 手势模式切换（摄像头 + MediaPipe 追踪双手）。场景里没有内容、或这条渲染路径还没接入
   * （`?pcViewport=1` 的 PlayCanvas 分支）时传 `null`——按本组件的纪律，能没有的控件就整只不出现。
   */
  handTracking?: { active: boolean; onToggle(): void } | null;
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
  const handActive = props.handTracking?.active ?? false;
  /** 外壳的两个槽位；探针页这类没有外壳的宿主拿到 `null`，控制簇就留在右下角 */
  const rightSlot = useDockSlot("right");
  const cornerSlot = useDockSlot("corner");

  /*
    撤销/重做：栈在上层（两张表都归它管），这里只出按钮。
    空栈时保持禁用而不是隐藏——按钮忽隐忽现会让这一排控件整体位移。

    **它单独成块**：外壳给了屏幕右下角那一格（`corner` 槽位）时它去那儿、与停靠行同底对齐；
    没有那一格（探针页）时留在控制簇的最前面——顺序与 `aria-label` 一个字都不能变，
    可信驱动与 PC 侧的诊断都按这个顺序读（`ViewportChrome.test.ts` 的 FULL_ORDER 钉住）。
  */
  const historyPanel = history ? (
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
  ) : null;

  const cluster = (
    /*
      控制簇（变换工具与视图控制各自一个面板并排；变换那组只在有选中时出现）。

      **两种落点，类名跟着走**：
      - 进停靠行（`rightSlot` 非空）：它已经是那一行的 flex item，不再自己定位；`flex-wrap
        justify-end` 让窄窗口下面板自己折行、始终贴右（换行时行高变大，输入框那一列是
        底对齐的，于是自动往上让位）。
      - 右下角旧位置（探针页）：`absolute bottom-4 right-4 z-20`。

      **`z-20` 不是随手写的大数**（2026-10-02 实测）：应用外壳那排输入框的容器也是 `z-10`
        （`AgentDock` 的 `pointer-events-none absolute inset-x-0 bottom-5 z-10`），而它在 DOM 里
        排在视口**之后**——平级 z-index 下后来者赢，于是窄窗口（实测 1500×950）里输入框盖住控制簇
        左半截：`document.elementFromPoint()` 在 `Undo/Redo/Move/Rotate/Scale` 的按钮中心返回的是
        外壳的 DIV，**这几个按钮点不动**（右半截在外面，正常）。抬到 20 之后它们全部可点。
        进停靠行之后这种重叠在结构上不可能再发生（工具栏在输入框**下面**），但旧位置保留这层
        保险：探针页的宿主有自己的浮层。上限不能被下面这层压住、也不能压住浮层：
        下拉/气泡是 `z-40/z-50`，预览小窗在右上角的 `z-20`。
    */
    <div
      className={
        rightSlot
          ? "flex flex-wrap items-center justify-end gap-2"
          : "absolute bottom-4 right-4 z-20 flex items-center gap-2"
      }
      {...(props["data-pc-toolbar"] ? { "data-pc-toolbar": props["data-pc-toolbar"] } : {})}
    >
      {/* 没有角落槽位时撤销/重做留在簇里（探针页、以及任何只给了一半槽位的宿主） */}
      {!cornerSlot && historyPanel}

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
        {/*
          手势模式：摄像头 + MediaPipe 追踪双手，场景里出现一双手、捏合即抓取。
          它**与第一人称不互斥**（两种模式都能开），所以这里不做任何联动禁用。
        */}
        {props.handTracking && (
          <Tooltip
            content={handActive ? "Turn hand tracking off" : "Hand tracking (webcam + MediaPipe)"}
            side="top"
          >
            <ToolbarButton
              selected={handActive}
              aria-pressed={handActive}
              icon={handActive ? HandGrabbingIcon : HandPointingIcon}
              aria-label={handActive ? "Disable hand tracking" : "Enable hand tracking"}
              onClick={props.handTracking.onToggle}
            />
          </Tooltip>
        )}
      </Panel>
    </div>
  );

  return (
    <>
      {/* 停靠行右端那一格（贴输入框右边缘）；没有外壳的宿主留在右下角 */}
      {rightSlot ? createPortal(cluster, rightSlot) : cluster}
      {/* 屏幕右下角那一格：撤销/重做，与停靠行同底对齐（没有这一格时它就在上面的簇里） */}
      {cornerSlot && historyPanel ? createPortal(historyPanel, cornerSlot) : null}

      {props.hasContent && (
        <>
          {/*
            两种模式各有提示，同时开着时**只出一块**：否则两块提示会叠在同一个位置
            （第一人称那块本来就在 top-16）。文案按"当前能不能用鼠标看方向"分两种写法。
          */}
          {handActive ? (
            <Panel className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs text-ink-subtle">
              {firstPersonActive
                ? "Click the viewport to lock view · WASD to move · Pinch to grab · Esc to release mouse"
                : "Move your hands to aim · Pinch to grab and move objects · Pinch again to drop"}
            </Panel>
          ) : firstPersonActive ? (
            <Panel className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs text-ink-subtle">
              Click the viewport to lock view · WASD to move · Shift to sprint · Esc to release mouse
            </Panel>
          ) : null}

          <div className="pointer-events-none absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-2">
            <Badge>{props.objectCount} objects</Badge>
            {props.selectedCount > 0 && <Badge>Selected: {props.selectedCount}</Badge>}
            {wireframe.on && <Badge>Wireframe</Badge>}
            {handActive && <Badge>Hand tracking</Badge>}
            {props.splatBackground && <Badge>Gaussian splat background</Badge>}
          </div>
        </>
      )}
    </>
  );
}
