import type { ReactNode } from "react";

interface EmptyProps {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function Empty({ icon, title, description }: EmptyProps) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {icon && <span className="text-ink-faint">{icon}</span>}
      <span className="text-sm text-ink-subtle">{title}</span>
      {description && <span className="text-xs text-ink-faint">{description}</span>}
    </div>
  );
}
