/**
 * Tolerant text matching for search and "discussed passage" marks.
 *
 * Both sides are "folded": lowercase, accents removed (also LaTeX's spacing accents
 * like "¨a"), and whitespace, soft hyphens and dashes dropped. So "beschäftigt" finds
 * "besch¨aftigt", "ihnen" finds "ih-\nnen", and quotes match across line breaks.
 * Every folded character remembers where it came from, to map hits back.
 */

const DROP = /[\s­¨´`ˆ˜ˇ˚¸\-‐‑‒–—]/u;

function foldChar(c: string): string {
  if (DROP.test(c)) return "";
  if (c === "ß" || c === "ẞ") return "ss";
  return c.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function fold(s: string): string {
  let out = "";
  for (const c of s) out += foldChar(c);
  return out;
}

/**
 * Folded text plus, for each folded char, the [start, end) of its source char
 * (math letters like 𝐴 are two UTF-16 units long).
 */
function foldWithMap(s: string): { text: string; map: [number, number][] } {
  let text = "";
  const map: [number, number][] = [];
  let i = 0;
  for (const c of s) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) map.push([i, i + c.length]);
    text += f;
    i += c.length;
  }
  return { text, map };
}

/** All occurrences of `query` in `s`, as [start, end) offsets into `s`. */
export function findInString(s: string, query: string, limit = 1000): [number, number][] {
  const q = fold(query);
  if (!q) return [];
  const { text, map } = foldWithMap(s);
  const out: [number, number][] = [];
  for (let at = text.indexOf(q); at !== -1 && out.length < limit; at = text.indexOf(q, at + q.length)) {
    out.push([map[at][0], map[at + q.length - 1][1]]);
  }
  return out;
}

/** A short excerpt around [start, end) for result lists. */
export function snippet(s: string, start: number, end: number, around = 40) {
  const a = Math.max(0, start - around);
  const b = Math.min(s.length, end + around);
  const clean = (t: string) => t.replace(/\s+/g, " ");
  return {
    before: (a > 0 ? "…" : "") + clean(s.slice(a, start)),
    match: clean(s.slice(start, end)),
    after: clean(s.slice(end, b)) + (b < s.length ? "…" : ""),
  };
}

type LayerIndex = { text: string; at: { node: Text; offset: number; end: number }[] };
const layerCache = new WeakMap<Element, LayerIndex>();

/** Folded text of a pdf.js text layer, with each char mapped to its text node/offset. */
function indexLayer(layer: Element): LayerIndex {
  const cached = layerCache.get(layer);
  if (cached && cached.at.every((p, i) => i > 0 || p.node.isConnected)) return cached;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let text = "";
  const at: LayerIndex["at"] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const data = n.data;
    let i = 0;
    for (const c of data) {
      const f = foldChar(c);
      for (let k = 0; k < f.length; k++) at.push({ node: n, offset: i, end: i + c.length });
      text += f;
      i += c.length;
    }
  }
  const index = { text, at };
  layerCache.set(layer, index);
  return index;
}

/**
 * Which match of `query` in a text layer a selection is (0 = the first): the first match
 * that starts at or after where the selection starts. For highlights of a text that occurs
 * more than once on a page.
 */
export function occurrenceAt(layer: Element, query: string, selection: Range): number {
  const q = fold(query);
  if (!q) return 0;
  const before = document.createRange();
  before.setStart(layer, 0);
  try {
    before.setEnd(selection.startContainer, selection.startOffset);
  } catch {
    return 0;
  }
  const start = fold(before.toString()).length;
  const { text } = indexLayer(layer);
  let n = 0;
  for (let i = text.indexOf(q); i !== -1 && i < start; i = text.indexOf(q, i + q.length)) n++;
  return n;
}

/** All occurrences of `query` inside a text layer, as DOM Ranges. */
export function findInLayer(layer: Element, query: string, limit = 500): Range[] {
  const q = fold(query);
  if (!q) return [];
  const { text, at } = indexLayer(layer);
  const out: Range[] = [];
  for (let i = text.indexOf(q); i !== -1 && out.length < limit; i = text.indexOf(q, i + q.length)) {
    const start = at[i];
    const end = at[i + q.length - 1];
    const r = document.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, Math.min(end.end, end.node.length));
    out.push(r);
  }
  return out;
}
