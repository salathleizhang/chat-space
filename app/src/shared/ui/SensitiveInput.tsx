import { EyeIcon } from "@phosphor-icons/react/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/EyeSlash";
import { useState } from "react";
import { Input } from "./Input";

interface SensitiveInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  "aria-label"?: string;
}

/** 密钥输入框：默认掩码，可切换明文 */
export function SensitiveInput({
  value,
  onValueChange,
  placeholder,
  ...aria
}: SensitiveInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="relative flex items-center">
      <Input
        className="w-full pr-8!"
        type={revealed ? "text" : "password"}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...aria}
      />
      <button
        type="button"
        className="absolute right-1 rounded-control p-1 text-ink-subtle hover:bg-fill hover:text-ink"
        aria-label={revealed ? "隐藏密钥" : "显示密钥"}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
      </button>
    </div>
  );
}
