import { useEffect, useRef, type ReactNode } from "react";

interface DialogProps {
  /** 触发器：收到 open 回调，自行渲染按钮 */
  trigger: (open: () => void) => ReactNode;
  /** 内容：收到 close 回调，自行渲染底部按钮 */
  children: (close: () => void) => ReactNode;
  className?: string;
  openOnMount?: boolean;
}

/** 基于原生 <dialog>：焦点陷阱、Esc 关闭、顶层渲染由浏览器提供，点击遮罩关闭 */
export function Dialog({ trigger, children, className = "", openOnMount = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = () => ref.current?.showModal();
  const close = () => ref.current?.close();

  useEffect(() => {
    if (openOnMount && ref.current && !ref.current.open) ref.current.showModal();
  }, [openOnMount]);

  return (
    <>
      {trigger(open)}
      <dialog
        ref={ref}
        className={`glass m-auto rounded-surface border border-line bg-surface-raised text-ink backdrop:bg-canvas/60 ${className}`}
        onClick={(event) => {
          if (event.target === ref.current) close();
        }}
      >
        {children(close)}
      </dialog>
    </>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-medium text-ink-strong">{children}</h2>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-ink-subtle">{children}</p>;
}
