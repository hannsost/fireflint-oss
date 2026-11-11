import { useIsFetching, useIsMutating } from "@tanstack/react-query";

/** Thin indeterminate bar at the top while any query/mutation is in flight. */
export function TopProgress() {
  const active = useIsFetching() + useIsMutating();
  if (!active) return null;
  return <div className="top-progress" aria-hidden="true" />;
}
