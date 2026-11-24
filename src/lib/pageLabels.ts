/**
 * Page labels: the page numbers as the document prints them ("XII", "233"), which a PDF can carry
 * next to its own count of pages. Everything in ydust (links, highlights, the text files, the
 * tools) counts PDF pages, 1-based; labels are only what people get to see.
 */

/** Label of every page (index 0 = page 1); undefined: the document has none, or they are just 1, 2, 3, … */
export type PageLabels = string[] | undefined;

const MAX_LABEL = 16;

/** A PDF's labels as they may be used, or undefined if they say nothing (or don't fit the document). */
export function cleanLabels(raw: unknown, pages: number): PageLabels {
  if (!Array.isArray(raw) || raw.length !== pages) return undefined;
  const labels = raw.map((l, i) => {
    // They end up in prompts and Markdown links: short plain text only.
    const s = typeof l === "string" ? l.replace(/[^\p{L}\p{N} .\-–/]/gu, "").trim().slice(0, MAX_LABEL).trim() : "";
    return s || String(i + 1);
  });
  return labels.some((l, i) => l !== String(i + 1)) ? labels : undefined;
}

/** How to call a page (1-based PDF page). */
export const pageLabel = (labels: PageLabels, page: number) => labels?.[page - 1] ?? String(page);

/** The PDF page with this label (the nearest to `near`, if numbering restarts in the document), or null. */
export function pageOfLabel(labels: PageLabels, label: string, near = 1): number | null {
  const want = label.trim();
  if (!labels || !want) return null;
  const find = (same: (l: string) => boolean) => {
    let best: number | null = null;
    labels.forEach((l, i) => {
      if (same(l) && (best === null || Math.abs(i + 1 - near) < Math.abs(best - near))) best = i + 1;
    });
    return best;
  };
  return find((l) => l === want) ?? find((l) => l.toLowerCase() === want.toLowerCase());
}

/** Where to go for a typed page: its label, else the last page printed with a smaller number (a blank page left out, or past the end). */
export function nearestPage(labels: string[], typed: string, near = 1): number | null {
  const exact = pageOfLabel(labels, typed, near);
  if (exact !== null || !/^\s*\d+\s*$/.test(typed)) return exact;
  let best: number | null = null;
  let number = -1;
  labels.forEach((l, i) => {
    if (/^\d+$/.test(l) && Number(l) <= Number(typed) && Number(l) > number) [best, number] = [i + 1, Number(l)];
  });
  return best;
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const roman = (s: string) => [...s.toLowerCase()].reduce((n, ch, i, all) => n + (ROMAN[ch] < (ROMAN[all[i + 1]] ?? 0) ? -ROMAN[ch] : ROMAN[ch]), 0);

/** Whether `b` is the label right after `a`: "9" → "10", "A-1" → "A-2", "iv" → "v". */
function follows(a: string, b: string) {
  const [x, y] = [a, b].map((s) => s.match(/^(.*?)(\d+)$/));
  if (x && y) return x[1] === y[1] && Number(y[2]) === Number(x[2]) + 1;
  const isRoman = /^(?:[ivxlcdm]+|[IVXLCDM]+)$/;
  return isRoman.test(a) && isRoman.test(b) && roman(b) === roman(a) + 1;
}

const MAX_RANGES = 40;

/** The labels in short: "PDF p. 1 = C1, 2 = I, 3–4 = III–IV, 5–105 = 1–101". */
export function labelRanges(labels: string[]): string {
  const ranges: [number, number][] = [];
  labels.forEach((l, i) => {
    const last = ranges.at(-1);
    if (last && follows(labels[i - 1], l)) last[1] = i;
    else ranges.push([i, i]);
  });
  const shown = ranges
    .slice(0, MAX_RANGES)
    .map(([a, b]) => (a === b ? `${a + 1} = ${labels[a]}` : `${a + 1}–${b + 1} = ${labels[a]}–${labels[b]}`));
  return `PDF p. ${shown.join(", ")}${ranges.length > MAX_RANGES ? ", …" : ""}`;
}

// "p. 12", "pp. 12–14", "S. 12, 14" in a link's text; or nothing but the numbers.
const CHAIN = String.raw`\d+(?:(?:\s*[-–—,&]\s*|\s+(?:to|and|bis|und)\s+)\d+(?![.\d]))*`;
const AFTER_WORD = new RegExp(String.raw`((?:^|[^\p{L}])(?:pp?|pages?|ss?|seiten?)\.?\s*)(${CHAIN})`, "iu");
const ONLY = new RegExp(String.raw`^(\s*)(${CHAIN})\s*$`, "u");

/**
 * The text of a link to `page`, with the printed page numbers: "Script, pp. 234–236" → "Script,
 * pp. 233–235". Only if it names that PDF page, so a text that already has the printed number stays.
 */
export function relabelText(text: string, page: number, labels: PageLabels): string {
  if (!labels) return text;
  return text.replace(AFTER_WORD.test(text) ? AFTER_WORD : ONLY, (all, before: string, chain: string) => {
    if (Number(chain.match(/^\d+/)![0]) !== page) return all;
    return before + chain.replace(/\d+/g, (n) => pageLabel(labels, Number(n)));
  });
}

/** The same for every page link in Markdown; `labelsOf` gets the document's alias (undefined: "[p. 3](#page=3)"). */
export function relabelCitations(md: string, labelsOf: (alias: string | undefined, text: string) => PageLabels): string {
  return md.replace(
    /\[([^\]\n]+)\]\(#(?:doc=([\w-]+)&)?page=(\d+)\)/g,
    (all, text: string, alias: string | undefined, page: string) => `[${relabelText(text, Number(page), labelsOf(alias, text))}${all.slice(text.length + 1)}`,
  );
}
