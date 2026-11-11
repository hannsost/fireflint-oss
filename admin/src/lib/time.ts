/** Compact relative time, e.g. "vor 3 Min." / "vor 2 Std." / "vor 4 Tg.". */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "gerade eben";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} Tg.`;
  return new Date(iso).toLocaleDateString("de-DE");
}
