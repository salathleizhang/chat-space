import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placePopover, type PopoverPlacement } from "./popoverPosition";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}

/** 选项行高（与下方 `h-[54px]` 必须一致）：用来算内容理想高度，判断哪一侧装得下 */
const OPTION_HEIGHT = 54;
/** 弹层上下内边距之和（`p-2`） */
const LIST_PADDING = 16;

/** 胶囊触发下拉：浮层 portal 到 body + fixed 定位，逃逸父级面板的 overflow 裁切
    （同 Tooltip 的定位手法），坐标是运行时测量值，只能走 style。
    展开方向由 `placePopover` 按两侧余量决定——写死向上会让贴着屏幕顶部的选择器
    把前几个选项排到视口外（见 popoverPosition.ts）。
    已知限制：只做鼠标 + Escape 关闭，未实现方向键/Home/End/首字母导航与
    aria-activedescendant 焦点管理——键盘用户经 Tab 触达触发按钮后，选项行仍不可达。 */
export function Select({ value, options, onChange, className = "", ...rest }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPlacement | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const contentHeight = options.length * OPTION_HEIGHT + (options.length - 1) + LIST_PADDING;
    setPos(placePopover(rect, { preferredHeight: contentHeight, minWidth: 176 }));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={`control-edge-lit inline-flex h-10 items-center gap-1.5 rounded-full border border-line bg-fill px-3 text-xs text-ink transition-[background-color,border-color,scale] duration-150 ease-spring hover:border-ink-faint hover:bg-fill-active motion-safe:active:scale-[0.96] ${className}`}
        {...rest}
      >
        <span className="max-w-40 truncate">{current?.label ?? ""}</span>
        <CaretUpIcon size={12} weight="bold" className="shrink-0 opacity-70" />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <ul
              role="listbox"
              style={{
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                minWidth: pos.minWidth,
                maxHeight: pos.maxHeight,
              }}
              className={`fixed z-50 flex flex-col gap-1 overflow-y-auto rounded-surface border border-line bg-surface-raised p-2 shadow-lg backdrop-blur-md transition-[opacity,scale] duration-150 ease-spring starting:opacity-0 starting:scale-95 motion-reduce:starting:scale-100 ${
                pos.openUp ? "origin-bottom-left" : "origin-top-left"
              }`}
            >
              {options.map((option) => (
                <li key={option.value} className="shrink-0">
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    /* 高度定死 54px、圆角使用全局 inset(27px)——27 正好是行高一半，
                       四角同时落成整行胶囊状，且跟 ul 的 p-2(8px)内边距同心对齐容器
                       surface(35px)的外圆角(35-8=27)，
                       首尾选项贴边那两角不会露出比外层更"方"的曲率。 */
                    className={`flex h-[54px] w-full items-center truncate rounded-inset px-4 text-left text-sm transition-transform duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.97] ${
                      option.value === value ? "text-ink" : "text-ink-subtle"
                    }`}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          </>,
          document.body,
        )}
    </>
  );
}
