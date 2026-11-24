/** Reasoning effort levels, from least to most thinking. */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const LABELS: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
export const effortLabel = (effort: string) => LABELS[effort] ?? effort;

/** The level of `available` (in order) closest to the wanted one, not above it if possible; null if there are none. */
export function nearestEffort(available: string[], wanted: string): string | null {
  if (available.includes(wanted)) return wanted;
  const rank = EFFORTS.indexOf(wanted);
  return available.filter((e) => EFFORTS.indexOf(e) <= rank).at(-1) ?? available[0] ?? null;
}

/** "gemini-4-hydrogen-high" → ["gemini-4-hydrogen", "high"]; an id without a level → [id, null]. */
export function splitEffort(id: string): [family: string, effort: string | null] {
  const m = id.match(/^(.+)-([a-z]+)$/);
  return m && EFFORTS.includes(m[2]) ? [m[1], m[2]] : [id, null];
}
