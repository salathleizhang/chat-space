interface SwitchProps {
  label?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({ label, checked, onCheckedChange }: SwitchProps) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-subtle select-none">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onCheckedChange(!checked)}
        className={`relative h-4 w-7 rounded-full ring-1 ring-line transition-colors ${
          checked ? "bg-accent" : "bg-fill"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full transition-[left,background-color] ${
            checked ? "left-3.5 bg-ink-inverse" : "left-0.5 bg-ink-subtle"
          }`}
        />
      </button>
    </label>
  );
}
