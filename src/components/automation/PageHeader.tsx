import type { ReactNode } from "react";

/** Title on the left, actions on the right, a divider underneath. */
export function PageHeader({ title, back, actions }: { title: string; back?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="border-b border-line pb-4">
      {back && <div className="mb-1 text-xs">{back}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export const headerButtonClass =
  "rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2";
