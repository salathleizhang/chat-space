import { MicrophoneIcon } from "@phosphor-icons/react/Microphone";
import { MicrophoneSlashIcon } from "@phosphor-icons/react/MicrophoneSlash";
import { useEffect } from "react";
import { useVoiceInput } from "../lib/useVoiceInput";
import { voiceShortcutApplies } from "../lib/voiceInput";
import { Button } from "./Button";
import { Select } from "./Select";
import { Tooltip } from "./Tooltip";

interface VoiceInputButtonProps {
  /** 输入框当前的文字（受控）。开始听写时它成为基线，转写接在它后面。 */
  value: string;
  /** 把合成后的文字写回输入框。 */
  onChange: (next: string) => void;
  className?: string;
}

/**
 * 语音输入控件：语言胶囊 + 麦克风按钮，由 `V` 键切换。
 *
 * 它的位置由调用方决定（当前是**发送按钮左边**）。组件本身不认识输入框之外的东西——
 * 只有 `value` / `onChange` 两个口子，所以换个输入框接上就是同一份行为。
 *
 * 识别的中间态（interim）是**实时写进输入框**的：用户看得见字在滚，才敢继续说；
 * 代价是每次 interim 修订都会触发一次受控输入框的重渲染，这个量级可以接受。
 */
export function VoiceInputButton({ value, onChange, className = "" }: VoiceInputButtonProps) {
  const { supported, listening, error, lang, languageOptions, setLang, toggle } = useVoiceInput({
    value,
    onChange,
  });

  /**
   * 快捷键 `V`。闸门在纯函数 `voiceShortcutApplies` 里（输入框里打字不抢键、带 meta/ctrl/alt
   * 不管、长按重复不管），这里只负责接线——契约有单测，接线这一层靠组件测。
   */
  useEffect(() => {
    if (!supported) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!voiceShortcutApplies(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [supported, toggle]);

  return (
    <div className={`relative flex items-center gap-1.5 ${className}`}>
      {supported && (
        <Tooltip content="Speech recognition language">
          <Select
            className="px-2 text-[11px]"
            value={lang}
            options={languageOptions}
            onChange={setLang}
            aria-label="Speech recognition language"
          />
        </Tooltip>
      )}
      <Tooltip
        content={
          supported
            ? listening
              ? "Stop voice input (V)"
              : "Dictate with your voice (V)"
            : "Voice input needs Chrome or Edge"
        }
      >
        <Button
          variant="secondary"
          shape="circle"
          size="lg"
          icon={listening ? MicrophoneSlashIcon : MicrophoneIcon}
          aria-label={listening ? "Stop voice input" : "Start voice input"}
          aria-pressed={listening}
          disabled={!supported}
          onClick={toggle}
          /*
            ⚠️ 听写态**不能**再挂 `control-edge-lit`：那是 `@utility`，写的是 `box-shadow`，
            而 `ring-2` 也写 `box-shadow`——两者相撞时赢的是样式表里更靠后的那条（实测
            `control-edge-lit` 赢），红圈会静默消失。真机核对过：摘掉它之后
            `box-shadow` 才是 `rgba(255,48,69,0.5) 0 0 0 2px`。
          */
          className={`border ${
            listening
              ? "border-signal ring-2 ring-signal/50 motion-safe:animate-pulse"
              : "control-edge-lit border-line hover:border-ink-faint"
          }`}
        />
      </Tooltip>
      {/*
        错误气泡**绝对定位在按钮上方**：不占布局、不把这一行里三个模型选择器挤位。
        面板本身是 overflow-hidden，但气泡落在面板内部（上方是消息区），不会被裁掉。
      */}
      {error && (
        <p
          role="alert"
          className="absolute right-0 bottom-full z-20 mb-2 w-64 rounded-control border border-line bg-surface-raised px-3 py-2 text-[11px] leading-relaxed text-signal shadow-lg"
        >
          {error}
        </p>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {listening ? "Listening" : ""}
      </span>
    </div>
  );
}
