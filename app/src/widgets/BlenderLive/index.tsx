import { ArrowsInIcon, ArrowsOutIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Panel, Button, Badge } from "../../shared/ui";

/**
 * Blender 实时画面窗 —— 把容器里 Blender 的界面嵌进工作台。
 *
 * ## 画面从哪来（**不要**直接写 KasmVNC 的地址）
 *
 * `<iframe src="/blender-live/">`，由 Vite 的反向代理转到容器里的 KasmVNC。
 * 走代理的理由见 `app/vite.config.ts`：KasmVNC 是**自签证书 + HTTP Basic + 跨源**，
 * 三者任一都会让直接嵌失败；代理一次解决，而且让 iframe 与页面**同源**。
 *
 * ## 外壳为什么和 `ModelPreviewWindow` 几乎一样
 *
 * 这是刻意的：两个窗都是"浮在工作台上的临时窗口"，样式/拖动/关闭的行为必须一致，
 * 否则用户要学两套。所以这里照抄它的形状：
 *
 *   · `Panel` + `w-[22rem]` + 圆角由全局 surface 提供
 *   · 头部 `h-11`、`cursor-grab`、`active:cursor-grabbing`
 *   · 按钮 `top-3 right-3.5`（**不是垂直居中**）：全局 surface 圆角 35px，
 *     贴边居中的方形按钮会被 `overflow-hidden` 按弧线削掉
 *
 * ## 拖动只改 DOM transform，不写 React state
 *
 * 同 `ModelPreviewWindow` 的理由，而且在**这里更严重**：把 pointermove 写进 state
 * 会让 React 每次移动都协调一遍 iframe 子树，而 iframe 里跑着一个实时视频流——
 * 拖动会明显掉帧。所以偏移留在 ref，直接改 `host.style.transform`。
 */

export interface BlenderLiveWindowProps {
  onClose: () => void;
  /** 头部显示的标题；默认「Blender」 */
  title?: string;
  /** 状态徽标（例如「agent 正在建模」）；传 null 表示不显示 */
  status?: string | null;
}

export function BlenderLiveWindow({ onClose, title = "Blender", status }: BlenderLiveWindowProps) {
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    host: HTMLElement;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 点在按钮上时不开始拖动——否则「点关闭」会先把手势抢走。
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const host = event.currentTarget.parentElement;
    if (!host) return;
    dragRef.current = {
      host,
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = drag.originX + (event.clientX - drag.startX);
    const y = drag.originY + (event.clientY - drag.startY);
    offsetRef.current = { x, y };
    drag.host.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const handleDragPointerUp = () => {
    dragRef.current = null;
  };

  /*
    窗口消失时 iframe 随组件卸载 —— 这一条不是洁癖：KasmVNC 的画面是**一条常开的
    WebSocket**，iframe 留在树上就是让那条流一直拉着（还占着容器里的一个客户端）。
    「结束就消失」的语义要落到"卸载 iframe"才算真的关掉，而不是把它藏起来。

    重开时 React 会建一个全新的 iframe，天然拿到新连接，不需要额外的 key 逻辑。
  */

  return (
    <Panel className={`flex max-w-[95vw] flex-col overflow-hidden ${expanded ? "w-[54rem]" : "w-[22rem]"}`}>
      <div
        className="relative flex h-11 shrink-0 cursor-grab items-center justify-center px-3 select-none active:cursor-grabbing"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
      >
        {status && (
          <div className="pointer-events-none absolute top-3 left-3.5">
            <Badge>{status}</Badge>
          </div>
        )}
        <span className="pointer-events-none max-w-[65%] truncate text-sm font-medium text-ink-strong">
          {title}
        </span>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={XIcon}
          aria-label="Close Blender live view"
          onClick={onClose}
          className="absolute top-3 right-3.5"
        />
      </div>

      <div className="relative aspect-video w-full bg-black">
        {/*
          不要给 iframe 加 `sandbox`：KasmVNC 需要脚本 + WebSocket + 同源存储，
          收紧 sandbox 的结果是一张永远连不上的空壳（而且不报错）。
        */}
        <iframe
          src="/blender-live/"
          title="Blender live view"
          className="h-full w-full border-0"
          onLoad={() => setLoaded(true)}
        />
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-white/70">
            正在连接 Blender…
          </div>
        )}
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={expanded ? ArrowsInIcon : ArrowsOutIcon}
          aria-label={expanded ? "Shrink Blender live view" : "Expand Blender live view"}
          onClick={() => setExpanded((v) => !v)}
          className="absolute bottom-3 right-3.5"
        />
      </div>
    </Panel>
  );
}
