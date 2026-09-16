import type { HTMLAttributes } from "react";

export function Badge({
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-fill px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-subtle ring-1 ring-hairline ${className}`}
      {...props}
    />
  );
}
