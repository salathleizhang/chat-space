import type { Icon } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes } from "react";
import { Button } from "./Button";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: Icon;
  /** 当前工具或分区是否已选中；只控制视觉，不改变按钮行为。 */
  selected?: boolean;
}

/** 左下导航与右下视口控制共用的参考图式圆形按钮。 */
export function ToolbarButton({
  icon,
  selected,
  className = "",
  ...props
}: ToolbarButtonProps) {
  return (
    <Button
      variant="toolbar"
      shape="circle"
      icon={icon}
      data-selected={selected ? "true" : undefined}
      className={className}
      {...props}
    />
  );
}
