import { useEffect, useState } from "react";
import { Input } from "../../shared/ui";

/**
 * 右侧栏的数值输入格。受控数字输入有个绕不开的矛盾：**输入中途的值不是合法数字**
 * （"-"、"1."、空串都是必经状态），直接用 `String(props.value)` 当 value 会在用户敲下
 * "-" 的瞬间被格式化回上一个数字，负号永远输不进去。
 *
 * 所以编辑期间以本地草稿为准，只有草稿解析成有限数时才向上提交（视口实时跟着动）；
 * 失焦/回车收口——草稿不合法就丢弃草稿、退回属性值。Escape 显式放弃这一次编辑。
 */

/** 去掉浮点噪声：`toFixed` 后再转回数字，`0.30000000000000004` 显示成 `0.3` */
function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(precision)));
}

export function NumberField({
  value,
  onChange,
  precision = 3,
  label,
  axis,
}: {
  value: number;
  onChange: (value: number) => void;
  /** 显示精度：位置/缩放 3 位，角度 1 位（度） */
  precision?: number;
  /** 无障碍名，如 "Position X" */
  label: string;
  /** 格内左侧的轴标，如 X/Y/Z */
  axis: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // 外部改动（视口里拖了 gizmo、切了选中对象）要立刻反映进来；正在编辑时不抢用户的手
  useEffect(() => {
    if (!editing) setDraft(null);
  }, [value, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
    setEditing(false);
    setDraft(null);
  };

  return (
    <label className="flex min-w-0 flex-1 items-center gap-1 rounded-control border border-hairline bg-field px-1.5 focus-within:border-line">
      <span className="shrink-0 text-[10px] text-ink-faint select-none">{axis}</span>
      <Input
        variant="plain"
        size="sm"
        inputMode="decimal"
        aria-label={label}
        className="min-w-0 flex-1 px-0 text-center"
        value={draft ?? format(value, precision)}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = Number(raw);
          // 只有已经是一个完整数字时才往上提交；"-" / "1." 这种中途态留在草稿里
          if (raw.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // 走 blur 收口，避免 Enter 与失焦两条路径各提交一次
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setEditing(false);
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
