import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";
type Width = "default" | "wide";

interface TooltipProps {
  content: ReactNode;
  side?: Side;
  /** 气泡宽度上限：wide 供需要横排缩略图等宽内容的悬浮卡使用 */
  width?: Width;
  children: ReactNode;
  /** 锚点容器附加类（如列表行需要 w-full） */
  className?: string;
  /**
   * 鼠标悬停多久（ms）才弹出，默认 0 = 立刻。给"弹出本身有代价"的气泡用：
   * ModelList 的资产悬浮卡会在气泡里加载整个模型来抽贴图，不设阈值的话
   * 鼠标扫过列表就会逐行拉起模型下载。键盘 focus 不吃这个延迟。
   */
  delay?: number;
  /**
   * 气泡内容可交互（可滚动、可点）：气泡改为 `pointer-events-auto`，指针移进气泡不收起。
   * 默认 false——普通提示气泡不该挡住底下的东西（视口点击、按钮 hover）。
   * 开这档的代价：气泡显示期间会吃掉它盖住那块区域的指针事件，只给"内容本身需要操作"
   * 的悬浮卡用（ModelList 的贴图条要横向滚）。
   */
  interactive?: boolean;
}

const GAP = 6;

/** interactive 档收起前的宽限期：指针要跨过锚点与气泡之间的 GAP，立刻收起就永远够不着 */
const HIDE_GRACE = 120;

const BUBBLE_WIDTH: Record<Width, string> = {
  default: "max-w-72",
  wide: "max-w-2xl",
};

const BUBBLE_TRANSFORM: Record<Side, string> = {
  top: "-translate-x-1/2 -translate-y-full",
  bottom: "-translate-x-1/2",
  left: "-translate-x-full -translate-y-1/2",
  right: "-translate-y-1/2",
};

/** 悬浮提示：portal 到 body + fixed 定位，不被面板的 overflow 裁切。
    坐标是运行时测量值，只能走 style（视觉仍全部来自 token 类）。 */
export function Tooltip({
  content,
  side = "top",
  width = "default",
  children,
  className = "",
  delay = 0,
  interactive = false,
}: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** 定位必须在真正要显示的那一刻测量：延迟期间锚点可能已经滚走了 */
  const measure = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centers: Record<Side, { x: number; y: number }> = {
      top: { x: rect.left + rect.width / 2, y: rect.top - GAP },
      bottom: { x: rect.left + rect.width / 2, y: rect.bottom + GAP },
      left: { x: rect.left - GAP, y: rect.top + rect.height / 2 },
      right: { x: rect.right + GAP, y: rect.top + rect.height / 2 },
    };
    setPos(centers[side]);
  };

  const show = () => {
    clearTimeout(timerRef.current);
    if (delay <= 0) {
      measure();
      return;
    }
    timerRef.current = setTimeout(measure, delay);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    if (!interactive) {
      setPos(null);
      return;
    }
    timerRef.current = setTimeout(() => setPos(null), HIDE_GRACE);
  };

  /** 指针进了气泡本身：撤掉宽限期里那次收起，但不重新测量（锚点位置没变） */
  const keepOpen = () => clearTimeout(timerRef.current);

  // 鼠标还停在锚点上时组件就被卸载（如列表刷新掉这一行），定时器要一并撤掉
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <>
      <span
        ref={anchorRef}
        className={`inline-flex ${className}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={measure}
        onBlur={hide}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: pos.x, top: pos.y }}
            onMouseEnter={interactive ? keepOpen : undefined}
            onMouseLeave={interactive ? hide : undefined}
            className={`${interactive ? "pointer-events-auto" : "pointer-events-none"} fixed z-50 w-max ${BUBBLE_WIDTH[width]} rounded-surface border border-line bg-surface-raised px-4 py-3 text-xs text-ink shadow-lg backdrop-blur-md ${BUBBLE_TRANSFORM[side]}`}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
