import type { InputHTMLAttributes } from "react";

type Size = "sm" | "md" | "lg";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: Size;
  /** field：默认带边框/底色的输入框；plain：无边框无底色，直接落在父级面板表面上 */
  variant?: "field" | "plain";
}

const SIZE: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-2 py-1.5 text-sm",
  lg: "px-3 py-2 text-base",
};

export function Input({
  size = "md",
  variant = "field",
  className = "",
  ...props
}: InputProps) {
  return (
    <input
      className={`text-ink outline-none placeholder:text-ink-faint ${
        variant === "field"
          ? "rounded-control border border-hairline bg-field focus:border-line"
          : "bg-transparent"
      } ${SIZE[size]} ${className}`}
      {...props}
    />
  );
}
