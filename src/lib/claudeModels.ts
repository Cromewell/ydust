/** A Claude model's family and version: "claude-fable-5-1[1m]" → fable, [5, 1]; "opus" → opus, []. Null: not a Claude id. */
export function claudeFamily(id: string): { family: string; version: number[] } | null {
  const plain = id.replace(/\[\w+\]$/, "");
  if (!plain.startsWith("claude-") && !/^[a-z]+$/.test(plain)) return null;
  // Dates (-20250101) and a context size ([1m]) are no part of the version.
  const parts = plain.split("-").filter((p) => p !== "claude" && !/^\d{8}$/.test(p));
  const words = parts.filter((p) => !/^\d+$/.test(p));
  return words.length === 1 && /^[a-z]+$/.test(words[0]) ? { family: words[0], version: parts.filter((p) => /^\d+$/.test(p)).map(Number) } : null;
}

const compare = (a: number[], b: number[]) => {
  // A bare alias ("opus") always stands for the latest.
  if (!a.length || !b.length) return Number(!a.length) - Number(!b.length);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * Only the newest model of each family, in the given order (of the same version listed twice,
 * the plain one rather than e.g. "[1m]"). Models that aren't Claude's (a gateway's) all stay.
 */
export function newestPerFamily<M extends { id: string; detail?: string }>(models: M[]): M[] {
  const best = new Map<string, { m: M; version: number[] }>();
  for (const m of models) {
    const f = claudeFamily(m.detail ?? m.id);
    if (!f) continue;
    const old = best.get(f.family);
    const d = old ? compare(f.version, old.version) : 1;
    if (d > 0 || (d === 0 && old!.m.id.includes("[") && !m.id.includes("["))) best.set(f.family, { m, version: f.version });
  }
  return models.filter((m) => {
    const f = claudeFamily(m.detail ?? m.id);
    return !f || best.get(f.family)!.m === m;
  });
}
