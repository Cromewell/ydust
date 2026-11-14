/** Highlight bar inside a page, in CSS px relative to the page's top-left corner. */
export type HighlightRect = { left: number; top: number; width: number; height: number };

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * pdf.js puts every word/run in its own absolutely positioned span, so the browser's
 * native highlight is a patchwork of overlapping boxes with gaps between words.
 * Instead, merge the selection's client rects into one clean bar per line and page.
 */
export function selectionHighlights(ranges: Range[], container: HTMLElement): Map<number, HighlightRect[]> {
  const out = new Map<number, HighlightRect[]>();
  const pages = ranges.flatMap((r) => [pageOf(r.startContainer), pageOf(r.endContainer)]).filter((p): p is number => p !== null);
  if (!pages.length) return out;

  // Only walk the pages the selection spans.
  for (let n = Math.min(...pages); n <= Math.max(...pages); n++) {
    const pageEl = container.querySelector<HTMLElement>(`[data-page="${n}"]`);
    const layer = pageEl?.querySelector<HTMLElement>(".textLayer");
    if (!pageEl || !layer) continue;
    const p = pageEl.getBoundingClientRect();
    const inPage = ranges
      .flatMap((range) => textRects(range, layer))
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ left: r.left - p.left, right: r.right - p.left, top: r.top - p.top, bottom: r.bottom - p.top }));
    const merged = mergeLines(inPage);
    if (merged.length) {
      out.set(
        n,
        merged.map((b) => ({ left: b.left - 1, top: b.top - 1, width: b.right - b.left + 2, height: b.bottom - b.top + 2 })),
      );
    }
  }
  return out;
}

/** Clean per-line bars (relative to the page) for one range inside a page's text layer. */
export function rangeHighlights(range: Range, pageEl: HTMLElement, layer: HTMLElement): HighlightRect[] {
  const p = pageEl.getBoundingClientRect();
  const boxes = textRects(range, layer)
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => ({ left: r.left - p.left, right: r.right - p.left, top: r.top - p.top, bottom: r.bottom - p.top }));
  return mergeLines(boxes).map((b) => ({ left: b.left - 1, top: b.top - 1, width: b.right - b.left + 2, height: b.bottom - b.top + 2 }));
}

/**
 * Client rects of just the selected *text* inside one text layer. Range.getClientRects()
 * would also return the boxes of every element fully inside the range — e.g. a whole
 * page's canvas when a selection crosses into it.
 */
function textRects(range: Range, layer: HTMLElement): DOMRect[] {
  if (!range.intersectsNode(layer)) return [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const out: DOMRect[] = [];
  const sub = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    out.push(...Array.from(sub.getClientRects()));
  }
  return out;
}

function mergeLines(boxes: Box[]): Box[] {
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Box[] = [];
  for (const r of boxes) {
    const h = r.bottom - r.top;
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      const lh = l.bottom - l.top;
      const sameLine = overlap > 0.5 * Math.min(h, lh);
      // Don't bridge big horizontal gaps (e.g. two-column layouts).
      const gap = Math.max(r.left - l.right, l.left - r.right);
      return sameLine && gap < 1.5 * Math.max(h, lh);
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

function pageOf(node: Node): number | null {
  const el = node instanceof Element ? node : node.parentElement;
  const page = el?.closest<HTMLElement>("[data-page]");
  return page ? Number(page.dataset.page) : null;
}

/**
 * Where the user finished selecting: the caret position at the selection's focus end,
 * and whether they selected backwards (then the end is at the top).
 */
export function selectionEnd(sel: Selection, range: Range): { rect: DOMRect; backward: boolean } {
  let backward = false;
  if (sel.anchorNode && sel.focusNode) {
    const r = document.createRange();
    r.setStart(sel.anchorNode, sel.anchorOffset);
    r.setEnd(sel.focusNode, sel.focusOffset);
    backward = r.collapsed && !(sel.anchorNode === sel.focusNode && sel.anchorOffset === sel.focusOffset);
  }

  // Caret rect at the focus, if the focus is inside text (not in a gap or on a <br>).
  if (sel.focusNode && sel.focusNode.nodeType === Node.TEXT_NODE) {
    const caret = document.createRange();
    caret.setStart(sel.focusNode, sel.focusOffset);
    caret.collapse(true);
    const c = caret.getClientRects()[0];
    if (c && c.height > 0) return { rect: c, backward };
  }

  // Fallback: the first/last line of the selection.
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const edge = backward ? rects[0] : rects.at(-1);
  const r = edge ?? range.getBoundingClientRect();
  return { rect: new DOMRect(backward ? r.left : r.right, r.top, 0, r.height), backward };
}
