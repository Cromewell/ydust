/** A spot in a document: the page at the top of the view, and how far into it (0–1, as a share of its height). */
export type Spot = { doc: string; page: number; offset: number };

/** Where you were before jumping (`back`) and before going back (`forward`); the latest is last. */
export type NavHistory = { back: Spot[]; forward: Spot[] };

export const NO_HISTORY: NavHistory = { back: [], forward: [] };
const MAX = 50;

const near = (a: Spot | undefined, b: Spot) => !!a && a.doc === b.doc && a.page === b.page && Math.abs(a.offset - b.offset) < 0.05;

/** You are about to jump away from `here`. */
export function leave(h: NavHistory, here: Spot): NavHistory {
  return { back: near(h.back.at(-1), here) ? h.back : [...h.back, here].slice(-MAX), forward: [] };
}

/** Step back or forward from `here`: the new history and where to go (null: nowhere). Skips deleted documents and the spot you are at. */
export function step(h: NavHistory, dir: "back" | "forward", here: Spot, exists: (doc: string) => boolean): { history: NavHistory; to: Spot } | null {
  const from = [...h[dir]];
  let to = from.pop();
  while (to && (!exists(to.doc) || near(to, here))) to = from.pop();
  if (!to) return null;
  const other = dir === "back" ? "forward" : "back";
  const kept = [...h[other], here].slice(-MAX);
  return { history: dir === "back" ? { back: from, forward: kept } : { back: kept, forward: from }, to };
}
