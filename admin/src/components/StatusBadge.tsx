import type { Status } from "../types";

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge ${status}`}>
      {status === "published" ? "Veröffentlicht" : "Entwurf"}
    </span>
  );
}
