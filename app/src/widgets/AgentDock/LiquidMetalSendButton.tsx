import type { ButtonHTMLAttributes } from "react";

interface LiquidMetalSendButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  "aria-label": string;
  /** 同一枚液态金属控件的动作状态；只改变中心符号，不降级表面材质。 */
  intent?: "send" | "stop";
  type?: "button" | "submit";
}

/**
 * 项目自有的动态玻璃发送按钮。
 *
 * 结构对应参考效果：色散外壳、暗色玻璃、内部流体反射和渐变四角星。
 * 全部由 React + CSS 绘制，不依赖 WebGL 或第三方运行时代码。
 */
export function LiquidMetalSendButton({
  "aria-label": ariaLabel,
  disabled,
  intent = "send",
  type = "submit",
  ...buttonProps
}: LiquidMetalSendButtonProps) {
  return (
    <span
      className="liquid-metal-send-button relative isolate inline-flex h-10 w-10 items-center justify-center rounded-[20px] text-metal-ink"
      data-disabled={disabled ? "true" : undefined}
      data-intent={intent}
    >
      <span className="liquid-metal-send-button__shadow" aria-hidden="true" />
      <span className="liquid-metal-send-button__chroma" aria-hidden="true" />
      <span className="liquid-metal-send-button__shell" aria-hidden="true" />
      <span className="liquid-metal-send-button__core" aria-hidden="true">
        <span className="liquid-metal-send-button__shader" />
        <span className="liquid-metal-send-button__glass" />
        <span className="liquid-metal-send-button__sheen" />
      </span>
      <button
        type={type}
        aria-label={ariaLabel}
        disabled={disabled}
        className="liquid-metal-send-button__control relative z-10 flex h-10 w-10 cursor-pointer items-center justify-center rounded-[20px] border-0 bg-transparent p-0 text-inherit disabled:cursor-default"
        {...buttonProps}
      >
        {intent === "stop" ? (
          <svg
            className="liquid-metal-send-button__stop"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="liquid-glass-stop-gradient"
                x1="8"
                y1="6"
                x2="24"
                y2="26"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ff3045" />
                <stop offset="0.38" stopColor="#ff8a48" />
                <stop offset="0.56" stopColor="#ffffff" />
                <stop offset="1" stopColor="#6aa8ff" />
              </linearGradient>
            </defs>
            <rect
              x="7"
              y="7"
              width="18"
              height="18"
              rx="5"
              fill="url(#liquid-glass-stop-gradient)"
              stroke="white"
              strokeOpacity="0.34"
              strokeWidth="0.75"
            />
          </svg>
        ) : (
          <svg
            className="liquid-metal-send-button__star"
            viewBox="0 0 28 32"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="liquid-glass-star-gradient"
                x1="8"
                y1="1"
                x2="19"
                y2="31"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ff5a3d" />
                <stop offset="0.3" stopColor="#ff9a48" />
                <stop offset="0.5" stopColor="#ffffff" />
                <stop offset="0.68" stopColor="#9bcfff" />
                <stop offset="1" stopColor="#1e5dff" />
              </linearGradient>
            </defs>
            <path
              d="M14 0C16.2 8.1 19.8 12.3 28 16C19.8 18.6 16.5 22.4 14 32C11.5 22.4 8.2 18.6 0 16C8.2 12.3 11.8 8.1 14 0Z"
              fill="url(#liquid-glass-star-gradient)"
            />
          </svg>
        )}
      </button>
    </span>
  );
}
