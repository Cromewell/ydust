import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type PDFDocumentProxy = pdfjs.PDFDocumentProxy;
export type PDFPageProxy = pdfjs.PDFPageProxy;

export function loadPdf(url: string) {
  return pdfjs.getDocument({
    url,
    // CMaps and standard fonts for non-latin and older PDFs (see pdfjsAssets in vite.config.ts).
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
}

/**
 * LaTeX PDFs often store "ä" as a spacing accent plus a letter ("¨a", sometimes "¨ a"),
 * even in separate text runs. Recombine them, but only with letters that accent is
 * actually used with, so stray marks like "don´t" stay untouched.
 */
const ACCENTS: [mark: string, combining: string, letters: string][] = [
  ["\u00A8", "\u0308", "aeiouyAEIOUY"], // ¨ → ä ë ï ö ü ÿ
  ["\u00B4", "\u0301", "aeiouycnszlrAEIOUYCNSZLR"], // ´ → á é í ó ú ý ć ń ś ź ĺ ŕ
  ["\u02C6", "\u0302", "aeiouAEIOU"], // ˆ → â ê î ô û
  ["\u02DC", "\u0303", "aonAON"], // ˜ → ã õ ñ
  ["\u02C7", "\u030C", "csznrdteCSZNRDTE"], // ˇ → č š ž ň ř ď ť ě
  ["\u02DA", "\u030A", "auAU"], // ˚ → å ů
];
const ACCENT_RE = new RegExp(ACCENTS.map(([m, , l]) => `${m}[ \\t]?[${l}]`).join("|"), "g");
const COMBINING = Object.fromEntries(ACCENTS.map(([m, c]) => [m, c]));

export function fixAccents(text: string) {
  return text.replace(ACCENT_RE, (match) => match.at(-1)! + COMBINING[match[0]]).normalize("NFC");
}

type TextItem = { str: string; transform: number[]; height: number; hasEOL: boolean };

/** "Differen-\ntialrechnung" → "Differentialrechnung" (only before a lowercase letter, so "Ein- und" stays). */
const dehyphenate = (text: string) => text.replace(/(\p{L})-\n[ \t]*(\p{Ll})/gu, "$1$2");

function itemsText(items: TextItem[]) {
  let out = "";
  for (const item of items) {
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return fixAccents(out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
}

const textItems = async (page: PDFPageProxy) =>
  (await page.getTextContent()).items.filter((i): i is (typeof i & TextItem) => "str" in i) as TextItem[];

export async function pageText(page: PDFPageProxy) {
  return itemsText(await textItems(page));
}

/**
 * A page's heading: the topmost text set clearly larger than the body text (slide titles,
 * chapter headings), else its first line.
 */
function pageHeading(items: TextItem[], text: string) {
  const sized = items
    .filter((i) => i.str.trim())
    .map((i) => ({ s: i.str, h: Math.abs(i.transform[3]) || i.height, y: i.transform[5] }));
  const clipLine = (s: string) => {
    const t = fixAccents(s.replace(/\s+/g, " ").trim());
    return t.length > 120 ? t.slice(0, 117) + "…" : t;
  };
  if (sized.length) {
    const heights = sized.map((x) => x.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const max = heights.at(-1)!;
    if (max >= median * 1.15) {
      const big = sized.filter((x) => x.h >= max * 0.9);
      const top = Math.max(...big.map((x) => x.y));
      const title = clipLine(big.filter((x) => x.y >= top - max * 2.5).map((x) => x.s).join(" "));
      if (title.length >= 2) return title;
    }
  }
  return clipLine(text.split("\n").find((l) => l.trim().length >= 2) ?? "");
}

export type OutlineNode = { id: string; title: string; page: number | null; children: OutlineNode[] };
type RawOutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

/** Read the PDF's built-in outline (bookmarks) and resolve every entry to a page number. */
export async function loadOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await pdf.getOutline();
  if (!raw?.length) return [];
  let n = 0;
  const resolve = async (dest: RawOutlineItem["dest"]): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      const ref = explicit?.[0];
      if (ref == null) return null;
      if (typeof ref === "number") return ref + 1;
      return (await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
    } catch {
      return null;
    }
  };
  const walk = (items: RawOutlineItem[]): Promise<OutlineNode[]> =>
    Promise.all(
      items.map(async (it) => ({
        id: `o${n++}`,
        title: (it.title ?? "").trim() || "Untitled",
        page: await resolve(it.dest),
        children: it.items?.length ? await walk(it.items) : [],
      })),
    );
  return walk(raw);
}

/** Bump when extraction changes, so existing documents get re-extracted on open. */
export const TEXT_VERSION = 3;

/**
 * Text of every page (for document.txt), plus an outline for the agent (outline.txt):
 * the PDF's bookmarks if it has any, else one heading per page (repeats collapsed).
 * Lines look like "p. 12: 2.1 Fourier series", nested entries indented.
 */
export async function extractAllText(pdf: PDFDocumentProxy, onProgress?: (done: number, total: number) => void) {
  const pages: string[] = [];
  const headings: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const items = await textItems(page);
    const text = dehyphenate(itemsText(items));
    pages.push(text);
    headings.push(pageHeading(items, text));
    page.cleanup();
    onProgress?.(i, pdf.numPages);
  }

  let outline = "";
  const nodes = await loadOutline(pdf).catch(() => []);
  if (nodes.length) {
    const lines: string[] = [];
    const walk = (list: OutlineNode[], depth: number) => {
      for (const node of list) {
        lines.push(`${"  ".repeat(depth)}p. ${node.page ?? "?"}: ${node.title.replace(/\s+/g, " ")}`);
        walk(node.children, depth + 1);
      }
    };
    walk(nodes, 0);
    outline = lines.join("\n");
  } else {
    outline = headings
      .map((h, i) => (h && h !== headings[i - 1] ? `p. ${i + 1}: ${h}` : null))
      .filter(Boolean)
      .join("\n");
  }
  return { pages, outline };
}

/** Turn a raw text-layer selection into readable text (join hyphenated line breaks, collapse whitespace). */
export function cleanSelection(text: string) {
  return fixAccents(text)
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A rectangle in page coordinates at zoom 1 (CSS px of the page at 100%). */
export type PageRect = { x: number; y: number; width: number; height: number };

/**
 * Render just one region of a page into a PNG, at a higher resolution than the
 * screen so small print and formulas stay sharp for the agent.
 */
export async function renderRegion(pdf: PDFDocumentProxy, pageNum: number, r: PageRect): Promise<Blob> {
  if (!(r.width > 0 && r.height > 0)) throw new Error("the selected area is empty");
  const page = await pdf.getPage(pageNum);
  // Aim for ~1600px wide, at least 2x, at most 4x, and never more than ~12 MP.
  let s = Math.min(4, Math.max(2, 1600 / r.width));
  s = Math.min(s, Math.sqrt(12_000_000 / (r.width * r.height)));
  const viewport = page.getViewport({ scale: s });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(r.width * s));
  canvas.height = Math.max(1, Math.round(r.height * s));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -r.x * s, -r.y * s] }).promise;
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the snapshot"))), "image/png"),
  );
}
