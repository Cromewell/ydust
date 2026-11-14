/**
 * Where a drag-selection should end for a pointer position, given the pdf.js text layers
 * inside `container`.
 *
 * Browsers resolve empty space (margins, gaps between lines, the space between pages)
 * badly for pdf.js' absolutely positioned spans: the selection jumps to the end of the
 * page or even the start of the document. We resolve it ourselves:
 *  - over text: the exact caret position under the pointer;
 *  - beside a line: the start/end of that line;
 *  - between lines: after the line above (dragging down) / before the line below (up);
 *  - between pages: the end of the page above (down) / start of the page below (up).
 */
export type TextPos = { node: Node; offset: number };

const SPAN_SELECTOR = 'span[role="presentation"]';

function textSpans(layer: Element): HTMLElement[] {
  return Array.from(layer.querySelectorAll<HTMLElement>(SPAN_SELECTOR)).filter(
    (s) => s.firstChild?.nodeType === Node.TEXT_NODE && (s.textContent ?? "").length > 0,
  );
}

const startOf = (span: HTMLElement): TextPos => ({ node: span.firstChild!, offset: 0 });
const endOf = (span: HTMLElement): TextPos => ({ node: span.firstChild!, offset: span.firstChild!.textContent!.length });

function caretAt(x: number, y: number): TextPos | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/**
 * Span boxes per text layer, relative to the layer (so they survive scrolling). A layer is
 * rebuilt on zoom, which gives it a fresh cache entry.
 */
const rectCache = new WeakMap<Element, { spans: HTMLElement[]; rel: { left: number; right: number; top: number; bottom: number }[] }>();
function spanBoxes(layer: Element) {
  let entry = rectCache.get(layer);
  const base = layer.getBoundingClientRect();
  if (!entry || entry.spans.some((s) => !s.isConnected)) {
    const spans = textSpans(layer);
    const rel = spans.map((s) => {
      const r = s.getBoundingClientRect();
      return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top };
    });
    entry = { spans, rel };
    rectCache.set(layer, entry);
  }
  const rects = entry.rel.map((r) => ({ left: r.left + base.left, right: r.right + base.left, top: r.top + base.top, bottom: r.bottom + base.top }));
  return { spans: entry.spans, rects };
}

function layerEdge(page: Element, end: boolean): TextPos | null {
  const layer = page.querySelector(".textLayer");
  const spans = layer ? textSpans(layer) : [];
  if (!spans.length) return null;
  return end ? endOf(spans[spans.length - 1]) : startOf(spans[0]);
}

export function positionAt(container: HTMLElement, x: number, y: number, down: boolean): TextPos | null {
  const pages = Array.from(container.querySelectorAll<HTMLElement>("[data-page]"));
  const page = pages.find((p) => {
    const r = p.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  });

  // Between pages (or above/below all of them): nearest page whose text is rendered.
  if (!page) {
    const above = () => {
      for (const p of [...pages].reverse()) if (p.getBoundingClientRect().bottom < y) { const e = layerEdge(p, true); if (e) return e; }
      return null;
    };
    const below = () => {
      for (const p of pages) if (p.getBoundingClientRect().top > y) { const e = layerEdge(p, false); if (e) return e; }
      return null;
    };
    return down ? (above() ?? below()) : (below() ?? above());
  }

  const layer = page.querySelector(".textLayer");
  if (!layer) return null; // page not rendered yet
  const { spans, rects } = spanBoxes(layer);
  if (!spans.length) return null;

  // Directly over a text span: exact caret position.
  const hit = document.elementFromPoint(x, y);
  const hitSpan = hit?.closest<HTMLElement>(SPAN_SELECTOR);
  if (hitSpan && layer.contains(hitSpan)) {
    const c = caretAt(x, y);
    if (c && hitSpan.contains(c.node)) return c;
    const r = hitSpan.getBoundingClientRect();
    return x > r.left + r.width / 2 ? endOf(hitSpan) : startOf(hitSpan);
  }

  // Beside a line (left/right margin or a gap inside the line): nearest span on that line.
  let best = -1;
  let bestDist = Infinity;
  rects.forEach((r, i) => {
    if (y < r.top || y > r.bottom) return;
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  if (best !== -1) return x < rects[best].left ? startOf(spans[best]) : endOf(spans[best]);

  // Between lines, or above/below the text block.
  if (down) {
    let pick = -1;
    rects.forEach((r, i) => {
      if (r.bottom <= y && (pick === -1 || r.bottom > rects[pick].bottom || (r.bottom === rects[pick].bottom && r.right > rects[pick].right))) pick = i;
    });
    // Above all text of this page while dragging down: select nothing of it yet.
    return pick === -1 ? startOf(spans[0]) : endOf(spans[pick]);
  }
  let pick = -1;
  rects.forEach((r, i) => {
    if (r.top >= y && (pick === -1 || r.top < rects[pick].top || (r.top === rects[pick].top && r.left < rects[pick].left))) pick = i;
  });
  return pick === -1 ? endOf(spans[spans.length - 1]) : startOf(spans[pick]);
}

/** Vertical position of a text position on screen (to tell "dragging down" from "up"). */
export function posTop(p: TextPos): number {
  const el = p.node instanceof Element ? p.node : p.node.parentElement;
  return el ? el.getBoundingClientRect().top : 0;
}

/** The visual line a span sits on: from the first to the last span (DOM order) on that line. */
export function lineOf(span: HTMLElement): { start: TextPos; end: TextPos } | null {
  const layer = span.closest(".textLayer");
  if (!layer || span.firstChild?.nodeType !== Node.TEXT_NODE) return null;
  const r = span.getBoundingClientRect();
  const mid = r.top + r.height / 2;
  const onLine = textSpans(layer).filter((s) => {
    const q = s.getBoundingClientRect();
    return q.top <= mid && q.bottom >= mid;
  });
  if (!onLine.length) return null;
  return { start: startOf(onLine[0]), end: endOf(onLine[onLine.length - 1]) };
}

export const isTextSpan = (el: Element | null): el is HTMLElement => !!el?.matches(SPAN_SELECTOR);

/** The word under the pointer inside a text span (Intl.Segmenter knows word boundaries per language). */
export function wordAt(x: number, y: number, span: HTMLElement): { start: TextPos; end: TextPos } | null {
  const c = caretAt(x, y);
  const node = c && span.contains(c.node) && c.node.nodeType === Node.TEXT_NODE ? c.node : span.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  const at = c && c.node === node ? c.offset : 0;
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(text));
  // The caret may sit on a boundary: prefer the word it touches.
  const hit =
    segments.find((s) => s.isWordLike && at >= s.index && at < s.index + s.segment.length) ??
    segments.find((s) => s.isWordLike && at === s.index + s.segment.length) ??
    segments.find((s) => at >= s.index && at < s.index + s.segment.length);
  if (!hit) return null;
  return { start: { node, offset: hit.index }, end: { node, offset: hit.index + hit.segment.length } };
}
