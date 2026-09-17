import { forwardRef } from "react";
import type { Projection } from "./paneLayouts";

interface ViewportPaneProps {
  label: string;
  /** 单视图时不画分隔线/角标，避免整屏多一圈无意义的边框 */
  bordered: boolean;
  projection: Projection;
  onToggleProjection: () => void;
}

/**
 * 分屏窗格容器：被 drei View 的 track 引用的 DOM 区域，仅负责占位与角标文字。
 * 多窗格时鼠标悬停哪个窗格边框就亮起（Blender 式"当前操作窗格"提示，纯 CSS
 * hover，不需要额外状态）——每个窗格的 OrbitControls 已经各自绑定在自己的
 * DOM 元素上，鼠标在哪个窗格拖拽本来就只影响那个窗格，这里只是补一个视觉反馈。
 * 单窗格时 bordered=false，天然不需要这个高亮；单窗格下的透视/正交切换挪到
 * 右下角全局控件簇（index.tsx），避免角标和左上/右上悬浮面板（ModelList/
 * ModelPreviewWindow）打架，只有多窗格才在每个窗格自己的右上角放这个切换。
 */
export const ViewportPane = forwardRef<HTMLDivElement, ViewportPaneProps>(function ViewportPane(
  { label, bordered, projection, onToggleProjection },
  ref,
) {
  return (
    <div
      ref={ref}
      /*
        「点空白 = 清空选中」的判定依据（见 index.tsx 的 handlePointerMissed）：Canvas 的
        eventSource 是整个视口容器，叠在画布上的 chrome（右下角控制簇、下面这个角标按钮）
        被点到时也会冒泡进 R3F 并被算作"没打中任何对象"。只有带这个标记的窗格占位层
        （以及画布本身）才是真正的 3D 空白区。
      */
      data-viewport-pane=""
      className={`relative ${bordered ? "border border-hairline transition-colors hover:border-accent" : ""}`}
    >
      {bordered && (
        <>
          <span className="pointer-events-none absolute top-2 left-2 text-[11px] text-ink-subtle">
            {label}
          </span>
          <button
            type="button"
            onClick={onToggleProjection}
            className="pointer-events-auto absolute top-2 right-2 text-[11px] text-ink-subtle transition-colors hover:text-accent"
          >
            {projection === "perspective" ? "Perspective" : "Orthographic"}
          </button>
        </>
      )}
    </div>
  );
});
