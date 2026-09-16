import type { ButtonHTMLAttributes } from "react";
import type { Icon } from "@phosphor-icons/react";

type Variant = "primary" | "secondary" | "ghost" | "toolbar";
type Size = "xs" | "sm" | "md" | "lg";
type Shape = "square" | "circle";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** square：等宽高的纯图标按钮（小圆角，悬浮时变全圆角）；circle：等宽高全圆角 */
  shape?: Shape;
  icon?: Icon;
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-ink-inverse hover:bg-accent-hover",
  secondary: "bg-fill text-ink hover:bg-fill-active",
  ghost: "text-ink opacity-80 hover:bg-fill hover:opacity-100",
  toolbar: "toolbar-button",
};

const SIZE: Record<Size, string> = {
  xs: "h-6 text-xs",
  sm: "h-7 text-xs",
  md: "h-8 text-sm",
  lg: "h-10 text-base",
};

const SQUARE: Record<Size, string> = {
  xs: "w-6",
  sm: "w-7",
  md: "w-8",
  lg: "w-10",
};

const ICON_SIZE: Record<Size, number> = { xs: 14, sm: 15, md: 17, lg: 18 };

const SHAPE_RADIUS: Record<Shape, string> = {
  square: "rounded-control hover:rounded-full",
  circle: "rounded-full",
};

export function Button({
  variant = "secondary",
  size = "md",
  shape,
  icon: IconComponent,
  className = "",
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 transition-[background-color,border-color,box-shadow,opacity,scale,border-radius] duration-150 ease-spring disabled:pointer-events-none disabled:opacity-40 motion-safe:active:scale-[0.96] ${VARIANT[variant]} ${SIZE[size]} ${shape ? `${SQUARE[size]} ${SHAPE_RADIUS[shape]}` : "rounded-full px-3"} ${className}`}
      {...props}
    >
      {IconComponent && <IconComponent size={ICON_SIZE[size]} weight="regular" />}
      {children}
    </button>
  );
}
