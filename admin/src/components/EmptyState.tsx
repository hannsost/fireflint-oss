import type { ReactNode } from "react";

/** Friendly placeholder for empty lists, with an optional call to action. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
