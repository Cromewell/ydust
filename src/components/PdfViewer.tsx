import clsx from "clsx";
import { MessageSquareText, StickyNote } from "lucide-react";
import type { Highlight } from "../lib/api";
import { HL_STYLE, barColor } from "../lib/highlightColors";
import { usePageLabels } from "../hooks/usePageLabels";
import { pageLabel } from "../lib/pageLabels";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanSelection, pageLinks, pdfjs, type PageRect, type PDFDocumentProxy, type PdfLink } from "../lib/pdf";
import { rangeHighlights, selectionEnd, selectionHighlights, type HighlightRect } from "../lib/selection";
import { findInLayer, occurrenceAt } from "../lib/textMatch";
import { isTextSpan, lineOf, positionAt, posTop, wordAt, type TextPos } from "../lib/textSelect";

/**
 * `end` is the caret rect where the user finished selecting; `backward` if they dragged upwards;
 * `occurrence`: which match of `text` on the page it is (for highlights).
 */
export type PdfSelection = { text: string; page: number; occurrence: number; end: DOMRect; backward: boolean };

type Size = { width: number; height: number };

export type Zoom = number | "fit";

/** A passage that was asked about in the chat (quote of a user message). */
export type Mark = { id: string; page: number; text: string };
/** Current search: query, and which hit (nth on a page) is the active one. */
export type SearchState = { query: string; current: { page: number; n: number } | null; nonce: number };
/** Briefly flash a passage (e.g. clicking a quote in the chat). */
export type Flash = { page: number; text: string; nonce: number };

const EMPTY_MARKS: Mark[] = [];
const EMPTY_HIGHLIGHTS: Highlight[] = [];

/** Where a highlight was clicked (to open its menu there). */
export type HighlightClick = { id: string; left: number; top: number };

type Props = {
  pdf: PDFDocumentProxy;
  zoom: Zoom;
  initialPage: number;
  /** `offset`: how far into the page (0–1; then exactly there, without scrolling smoothly). */
  jump: { page: number; offset?: number; nonce: number } | null;
  /** Filled with a function that tells where the view is (the page at its top, and how far into it). */
  position?: React.RefObject<(() => { page: number; offset: number } | null) | null>;
  onPageChange: (page: number) => void;
  onSelection: (sel: PdfSelection | null) => void;
  onScale: (scale: number) => void;
  /** Ctrl/Cmd + wheel or pinch-to-zoom step. */
  onZoomStep?: (dir: 1 | -1) => void;
  /** Internal PDF link clicked (cross-reference, TOC, footnote). */
  onInternalLink?: (page: number) => void;
  /** Box-select mode: drag a rectangle on a page to take a snapshot of it. */
  snipping: boolean;
  onSnip: (page: number, rect: PageRect) => void;
  search: SearchState | null;
  marks: Mark[];
  flash: Flash | null;
  onMarkClick: (messageId: string) => void;
  /** CSS filter for the pages (dark mode, dimming), see lib/appearance. */
  pageFilter?: string;
  /** Colour multiplied over the pages (warm tint), or null. */
  tint?: string | null;
  /** Dark pages: darken the area around them too. */
  darkPages?: boolean;
  /** The user's coloured highlights, and what happens when one is clicked. */
  userHighlights?: Highlight[];
  onHighlightClick?: (click: HighlightClick) => void;
};

const GAP = 16;
const SIDE_PADDING = 48;

export function PdfViewer({
  pdf,
  zoom,
  initialPage,
  jump,
  position,
  onPageChange,
  onSelection,
  onScale,
  onZoomStep,
  onInternalLink,
  snipping,
  onSnip,
  search,
  marks,
  flash,
  onMarkClick,
  pageFilter,
  tint = null,
  darkPages = false,
  userHighlights = EMPTY_HIGHLIGHTS,
  onHighlightClick,
}: Props) {
  const labels = usePageLabels().cite();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const currentPage = useRef(initialPage);
  const pendingRange = useRef<Range | null>(null);
  const [highlights, setHighlights] = useState<Map<number, HighlightRect[]>>(() => new Map());

  /** The last known scrollTop (a new layout may already have changed the box's own). */
  const lastTop = useRef(0);

  /** The page in view and how far into it, kept while the page sizes are corrected. */
  const sizeAnchor = useRef<{ page: number; offset: number } | null>(null);

  // Page sizes: the first page's for every page right away (most PDFs have one size), so even a
  // long document opens at once; the real sizes follow in parallel batches and replace the guess.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sizeOf = async (i: number): Promise<Size> => {
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      };
      const first = await sizeOf(1);
      if (cancelled) return;
      setSizes(Array.from({ length: pdf.numPages }, () => first));
      const all: Size[] = [first];
      for (let i = 2; i <= pdf.numPages; i += 50) {
        const batch = await Promise.all(Array.from({ length: Math.min(50, pdf.numPages - i + 1) }, (_, k) => sizeOf(i + k)));
        if (cancelled) return;
        all.push(...batch);
      }
      if (all.every((s) => s.width === first.width && s.height === first.height)) return;
      const box = scrollRef.current;
      const el = box?.querySelector<HTMLElement>(`[data-page="${currentPage.current}"]`);
      if (box && el) sizeAnchor.current = { page: currentPage.current, offset: (box.scrollTop - el.offsetTop) / el.offsetHeight };
      setSizes(all);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  // After the real sizes came in: the same spot stays in view.
  useLayoutEffect(() => {
    const a = sizeAnchor.current;
    const box = scrollRef.current;
    if (!a || !box) return;
    sizeAnchor.current = null;
    const el = box.querySelector<HTMLElement>(`[data-page="${a.page}"]`);
    if (el) box.scrollTop = el.offsetTop + a.offset * el.offsetHeight;
    lastTop.current = box.scrollTop;
    prevScale.current = scale; // already placed for the new layout (fit-width may have changed the zoom)
  }, [sizes]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToPage = useCallback((page: number, smooth = false) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - GAP, behavior: smooth ? "smooth" : "auto" });
      lastTop.current = scrollRef.current.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const maxWidth = sizes ? Math.max(...sizes.map((s) => s.width)) : 0;
  const fitScale = maxWidth && boxWidth ? Math.min(3, Math.max(0.25, (boxWidth - SIDE_PADDING) / maxWidth)) : 1;
  // Round so tiny resizes don't trigger re-rendering every page.
  const scale = zoom === "fit" ? Math.round(fitScale * 50) / 50 : zoom;
  // Lay pages out only once we know the container width, so "fit" doesn't jump on first paint.
  const ready = sizes !== null && boxWidth > 0;

  useEffect(() => onScale(scale), [scale, onScale]);

  // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report as ctrlKey wheel events) zooms.
  const zoomStepRef = useRef(onZoomStep);
  zoomStepRef.current = onZoomStep;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let acc = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !zoomStepRef.current) return;
      e.preventDefault();
      if (Math.sign(e.deltaY) !== Math.sign(acc)) acc = 0;
      acc += e.deltaY;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (acc = 0), 200);
      if (Math.abs(acc) >= 40) {
        zoomStepRef.current(acc < 0 ? 1 : -1);
        acc = 0;
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (timer) clearTimeout(timer);
      box.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Initial position.
  const didInit = useRef(false);
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    if (!ready || didInit.current) return;
    didInit.current = true;
    prevScale.current = scale;
    scrollToPage(initialPage);
  }, [ready, scale, initialPage, scrollToPage]);

  // Jumps requested from outside (e.g. a [p. 3] citation in the chat).
  useEffect(() => {
    if (!jump) return;
    if (jump.offset === undefined) return scrollToPage(jump.page, true);
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-page="${jump.page}"]`);
    if (!box || !el) return;
    box.scrollTo({ top: el.offsetTop + jump.offset * el.offsetHeight });
    lastTop.current = box.scrollTop;
  }, [jump, ready, scrollToPage]);

  useEffect(() => {
    if (!position) return;
    position.current = () => {
      const box = scrollRef.current;
      const pages = box ? [...box.querySelectorAll<HTMLElement>("[data-page]")] : [];
      // The gap above a page belongs to it (a jump to a page leaves it visible).
      const el = pages.findLast((p) => p.offsetTop - GAP <= box!.scrollTop + 1);
      return el ? { page: Number(el.dataset.page), offset: (box!.scrollTop - el.offsetTop) / el.offsetHeight } : null;
    };
    return () => {
      position.current = null;
    };
  }, [position]);

  // Keep the same spot in view when zooming.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || !didInit.current || prevScale.current === scale) return;
    const ratio = scale / prevScale.current;
    prevScale.current = scale;
    // Only the pages scale, not the gaps between them: find the page in the middle of the view and
    // the spot on it in the old layout (the browser may have clamped or moved scrollTop: use the last known one).
    const middle = lastTop.current + box.clientHeight / 2;
    const pages = [...box.querySelectorAll<HTMLElement>("[data-page]")];
    const oldTop = (i: number) => GAP * (i + 1) + (pages[i].offsetTop - GAP * (i + 1)) / ratio;
    const i = Math.max(0, pages.findLastIndex((_, k) => oldTop(k) <= middle));
    if (pages[i]) box.scrollTop = pages[i].offsetTop + (middle - oldTop(i)) * ratio - box.clientHeight / 2;
    lastTop.current = box.scrollTop;
    box.scrollLeft = (box.scrollLeft + box.clientWidth / 2) * ratio - box.clientWidth / 2;
  }, [scale]);

  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    lastTop.current = box.scrollTop;
    const probe = box.scrollTop + box.clientHeight * 0.35;
    const pages = box.querySelectorAll<HTMLElement>("[data-page]");
    let page = 1;
    for (const el of pages) {
      if (el.offsetTop <= probe) page = Number(el.dataset.page);
      else break;
    }
    // The last pages can't scroll to the top of the viewport; count "scrolled to the end" as the last page.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) page = pages.length;
    if (page !== currentPage.current) {
      currentPage.current = page;
      onPageChange(page);
    }
    if (pendingRange.current) reportRange(pendingRange.current);
  };

  const reportRange = useCallback(
    (range: Range) => {
      const sel = window.getSelection();
      const pageEl = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>("[data-page]");
      // Selection.toString() keeps pdf.js' <br> line ends as newlines (Range.toString() glues lines together).
      const text = cleanSelection(sel && !sel.isCollapsed ? sel.toString() : range.toString());
      if (!sel || !pageEl || !text) return onSelection(null);
      const { rect, backward } = selectionEnd(sel, range);
      const layer = pageEl.querySelector(".textLayer");
      const occurrence = layer ? occurrenceAt(layer, text, range) : 0;
      onSelection({ text, page: Number(pageEl.dataset.page), occurrence, end: rect, backward });
    },
    [onSelection],
  );

  // Watch text selection inside the viewer.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const check = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        pendingRange.current = null;
        return onSelection(null);
      }
      const range = sel.getRangeAt(0);
      if (!box.contains(range.commonAncestorContainer)) return;
      pendingRange.current = range;
      reportRange(range);
    };
    /*
     * Single-click drag selection is handled here instead of by the browser, because
     * browsers resolve empty space between pdf.js' absolutely positioned spans badly
     * (dragging into the next page would select all of it). See lib/textSelect.ts.
     * Double/triple click (word/line) and keyboard selection stay native.
     */
    let drag: { anchor: TextPos; x: number; y: number; frame: number } | null = null;

    const extend = () => {
      if (!drag) return;
      const down = drag.y >= posTop(drag.anchor);
      const focus = positionAt(box, drag.x, drag.y, down);
      const sel = window.getSelection();
      if (focus && sel) sel.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, focus.node, focus.offset);
    };

    // Auto-scroll while the pointer is near (or beyond) the top/bottom edge.
    const EDGE = 40;
    const autoScroll = () => {
      if (!drag) return;
      const r = box.getBoundingClientRect();
      const dy = drag.y < r.top + EDGE ? drag.y - (r.top + EDGE) : drag.y > r.bottom - EDGE ? drag.y - (r.bottom - EDGE) : 0;
      if (dy) {
        box.scrollTop += Math.max(-40, Math.min(40, dy / 2));
        extend();
      }
      drag.frame = requestAnimationFrame(autoScroll);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (!target.closest(".textLayer")) return;
      const span = isTextSpan(target) ? target : null;
      const sel = window.getSelection();

      if (e.detail === 2) {
        // Word selection (native double-click selects huge ranges in pdf.js text layers).
        e.preventDefault();
        const word = span && wordAt(e.clientX, e.clientY, span);
        if (word && sel) sel.setBaseAndExtent(word.start.node, word.start.offset, word.end.node, word.end.offset);
        return;
      }
      if (e.detail >= 3) {
        // Line selection (native would select the entire page's text).
        e.preventDefault();
        const line = span && lineOf(span);
        if (line && sel) sel.setBaseAndExtent(line.start.node, line.start.offset, line.end.node, line.end.offset);
        return;
      }
      if (e.shiftKey && sel?.anchorNode && box.contains(sel.anchorNode)) {
        // Shift-click extends the current selection, resolving empty space like a drag.
        e.preventDefault();
        const anchor = { node: sel.anchorNode, offset: sel.anchorOffset };
        const focus = positionAt(box, e.clientX, e.clientY, e.clientY >= posTop(anchor));
        if (focus) sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
        return;
      }

      const anchor = positionAt(box, e.clientX, e.clientY, false);
      if (!anchor) return;
      e.preventDefault(); // we drive the selection ourselves
      window.getSelection()?.collapse(anchor.node, anchor.offset);
      drag = { anchor, x: e.clientX, y: e.clientY, frame: 0 };
      drag.frame = requestAnimationFrame(autoScroll);
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      if (e.buttons === 0) return onUp(); // released outside the window
      drag.x = e.clientX;
      drag.y = e.clientY;
      extend();
    };
    const onBoxScroll = () => drag && extend(); // mouse wheel while selecting
    const onUp = () => {
      if (drag) {
        cancelAnimationFrame(drag.frame);
        drag = null;
      }
      setTimeout(check, 0);
    };
    const onBlur = () => {
      if (drag) cancelAnimationFrame(drag.frame);
      drag = null;
    };
    // Redraw our own highlight (see selectionHighlights) at most once per frame.
    let frame = 0;
    const drawHighlights = () => {
      frame = 0;
      const sel = window.getSelection();
      // Firefox splits cross-page selections into several ranges.
      const ranges =
        sel && !sel.isCollapsed
          ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)).filter((r) =>
              box.contains(r.commonAncestorContainer),
            )
          : [];
      if (!ranges.length) {
        setHighlights((h) => (h.size ? new Map() : h));
        return;
      }
      setHighlights(selectionHighlights(ranges, box));
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        pendingRange.current = null;
        onSelection(null);
      }
      if (!frame) frame = requestAnimationFrame(drawHighlights);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "a") check();
    };
    box.addEventListener("mousedown", onDown);
    box.addEventListener("scroll", onBoxScroll, { passive: true });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(frame);
      if (drag) cancelAnimationFrame(drag.frame);
      box.removeEventListener("mousedown", onDown);
      box.removeEventListener("scroll", onBoxScroll);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [onSelection, reportRange]);

  // --- Search hits, discussed passages, flashes ---
  const marksByPage = useMemo(() => {
    const m = new Map<number, Mark[]>();
    for (const mark of marks) m.set(mark.page, [...(m.get(mark.page) ?? []), mark]);
    return m;
  }, [marks]);
  const highlightsByPage = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of userHighlights) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return m;
  }, [userHighlights]);

  /** Bring a page into view if it's off-screen (it then renders and reveals the exact spot). */
  const ensurePageVisible = useCallback(
    (page: number) => {
      const box = scrollRef.current;
      const el = box?.querySelector<HTMLElement>(`[data-page="${page}"]`);
      if (!box || !el) return;
      const top = el.offsetTop - box.scrollTop;
      if (top + el.offsetHeight < 0 || top > box.clientHeight) scrollToPage(page);
    },
    [scrollToPage],
  );
  useEffect(() => {
    if (search?.current) ensurePageVisible(search.current.page);
  }, [search?.current?.page, search?.current?.n, search?.nonce, ensurePageVisible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (flash) ensurePageVisible(flash.page);
  }, [flash, ensurePageVisible]);

  /** Center a spot of a page (top/height relative to the page) in the viewport. */
  const reveal = useCallback((page: number, top: number, height: number) => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!box || !el) return;
    box.scrollTo({ top: el.offsetTop + top + height / 2 - box.clientHeight / 2, behavior: "smooth" });
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={clsx("relative h-full overflow-auto", darkPages ? "bg-zinc-800 dark:bg-zinc-950" : "bg-zinc-100 dark:bg-zinc-900/60")}
    >
      {!ready ? (
        <div className="flex h-full items-center justify-center text-sm text-zinc-500">Preparing pages…</div>
      ) : (
        <div className="mx-auto flex w-max min-w-full flex-col items-center px-6" style={{ gap: GAP, paddingBlock: GAP }}>
          {sizes.map((s, i) => (
            <Page
              key={i}
              pdf={pdf}
              num={i + 1}
              label={pageLabel(labels, i + 1)}
              size={s}
              scale={scale}
              root={scrollRef}
              snipping={snipping}
              onSnip={onSnip}
              highlights={highlights.get(i + 1)}
              searchQuery={search?.query ?? ""}
              searchCurrent={search?.current?.page === i + 1 ? search.current.n : -1}
              searchNonce={search?.current?.page === i + 1 ? search.nonce : 0}
              marks={marksByPage.get(i + 1) ?? EMPTY_MARKS}
              userHighlights={highlightsByPage.get(i + 1) ?? EMPTY_HIGHLIGHTS}
              onHighlightClick={onHighlightClick}
              flash={flash?.page === i + 1 ? flash : null}
              onReveal={reveal}
              onMarkClick={onMarkClick}
              onInternalLink={onInternalLink}
              labels={labels}
              pageFilter={pageFilter}
              tint={tint}
              darkPages={darkPages}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const Page = memo(function Page({
  pdf,
  num,
  label,
  size,
  scale,
  root,
  snipping,
  onSnip,
  highlights,
  searchQuery,
  searchCurrent,
  searchNonce,
  marks,
  userHighlights,
  onHighlightClick,
  flash,
  onReveal,
  onMarkClick,
  onInternalLink,
  labels,
  pageFilter,
  tint,
  darkPages,
}: {
  pdf: PDFDocumentProxy;
  num: number;
  label: string;
  size: Size;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
  snipping: boolean;
  onSnip: (page: number, rect: PageRect) => void;
  highlights?: HighlightRect[];
  searchQuery: string;
  /** Index of the active search hit on this page, or -1. */
  searchCurrent: number;
  searchNonce: number;
  marks: Mark[];
  userHighlights: Highlight[];
  onHighlightClick?: (click: HighlightClick) => void;
  flash: Flash | null;
  onReveal: (page: number, top: number, height: number) => void;
  onMarkClick: (messageId: string) => void;
  onInternalLink?: (page: number) => void;
  labels?: string[];
  pageFilter?: string;
  tint: string | null;
  darkPages: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // Bumped whenever the text layer is (re)built, so overlays get recomputed.
  const [textVersion, setTextVersion] = useState(0);
  const [hitBars, setHitBars] = useState<HighlightRect[][]>([]);
  const [markBars, setMarkBars] = useState<{ id: string; bars: HighlightRect[] }[]>([]);
  const [flashBars, setFlashBars] = useState<HighlightRect[] | null>(null);
  const [userBars, setUserBars] = useState<{ h: Highlight; bars: HighlightRect[] }[]>([]);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const [hoverLink, setHoverLink] = useState<PdfLink | null>(null);
  const revealed = useRef("");

  const layerEl = () => textHost.current?.querySelector<HTMLElement>(".textLayer") ?? null;

  // Search hits on this page (and reveal the active one once).
  useLayoutEffect(() => {
    const layer = layerEl();
    const pageEl = ref.current;
    if (!layer || !pageEl || searchQuery.trim().length < 2) return setHitBars([]);
    const bars = findInLayer(layer, searchQuery).map((r) => rangeHighlights(r, pageEl, layer));
    setHitBars(bars);
    const key = `${searchNonce}:${searchCurrent}:${textVersion}`;
    const cur = bars[searchCurrent]?.[0];
    if (searchCurrent >= 0 && cur && revealed.current !== key) {
      revealed.current = key;
      onReveal(num, cur.top, cur.height);
    }
  }, [searchQuery, searchCurrent, searchNonce, textVersion, scale, num, onReveal]);

  // Passages asked about in the chat.
  useLayoutEffect(() => {
    const layer = layerEl();
    const pageEl = ref.current;
    if (!layer || !pageEl || !marks.length) return setMarkBars([]);
    setMarkBars(
      marks
        .map((m) => {
          // A quote may run onto the next page: fall back to its beginning.
          const range = findInLayer(layer, m.text, 1)[0] ?? findInLayer(layer, m.text.slice(0, 80), 1)[0];
          return { id: m.id, bars: range ? rangeHighlights(range, pageEl, layer) : [] };
        })
        .filter((m) => m.bars.length),
    );
  }, [marks, textVersion, scale]);

  // The user's highlights: the n-th match of their text on this page (or the first, if the text changed).
  useLayoutEffect(() => {
    const layer = layerEl();
    const pageEl = ref.current;
    if (!layer || !pageEl || !userHighlights.length) return setUserBars([]);
    setUserBars(
      userHighlights
        .map((h) => {
          const ranges = findInLayer(layer, h.text, h.occurrence + 1);
          const range = ranges[h.occurrence] ?? ranges[0] ?? findInLayer(layer, h.text.slice(0, 80), 1)[0];
          return { h, bars: range ? rangeHighlights(range, pageEl, layer) : [] };
        })
        .filter((x) => x.bars.length),
    );
  }, [userHighlights, textVersion, scale]);

  const linkAt = (clientX: number, clientY: number) => {
    if (!links.length || !ref.current) return null;
    const r = ref.current.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    return links.find((l) => x >= l.left && x <= l.left + l.width && y >= l.top && y <= l.top + l.height) ?? null;
  };

  /** A click (not a drag) on a highlight opens its menu; else an internal PDF link jumps to its target page. */
  const onPageClick = (e: React.MouseEvent) => {
    if (e.detail !== 1) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (onHighlightClick && userBars.length) {
      const r = ref.current!.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      // The most recent highlight on top.
      const hit = [...userBars].reverse().find(({ bars }) => bars.some((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height));
      if (hit) {
        onHighlightClick({ id: hit.h.id, left: e.clientX, top: e.clientY + 14 });
        return;
      }
    }
    if (onInternalLink) {
      const hit = linkAt(e.clientX, e.clientY);
      if (hit) onInternalLink(hit.page);
    }
  };

  const onPageMouseMove = (e: React.MouseEvent) => {
    if (snipping || !links.length) return;
    const hit = linkAt(e.clientX, e.clientY);
    setHoverLink((cur) => (cur === hit ? cur : hit));
  };

  // Flash a passage (clicked quote in the chat).
  useLayoutEffect(() => {
    const layer = layerEl();
    const pageEl = ref.current;
    if (!flash || !layer || !pageEl) return;
    const range = findInLayer(layer, flash.text, 1)[0] ?? findInLayer(layer, flash.text.slice(0, 80), 1)[0];
    if (!range) return;
    const bars = rangeHighlights(range, pageEl, layer);
    const key = `flash:${flash.nonce}`;
    if (bars[0] && revealed.current !== key) {
      revealed.current = key;
      onReveal(num, bars[0].top, bars[bars.length - 1].top + bars[bars.length - 1].height - bars[0].top);
    }
    setFlashBars(bars);
    const t = setTimeout(() => setFlashBars(null), 1800);
    return () => clearTimeout(t);
  }, [flash, textVersion, num, onReveal]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: "120% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const host = canvasHost.current;
    const textDiv = textHost.current;
    if (!host || !textDiv) return;
    if (!near) {
      // Free memory for pages far away from the viewport — but keep the text of pages that
      // hold part of the current selection, or the selection would break.
      host.replaceChildren();
      setLinks([]);
      setHoverLink(null);
      const sel = window.getSelection();
      if (!(sel && !sel.isCollapsed && sel.containsNode(textDiv, true))) {
        textDiv.replaceChildren();
        setTextVersion((v) => v + 1);
      }
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>["render"]> | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;

    (async () => {
      const page = await pdf.getPage(num);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.className = "block";
      renderTask = page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled) return;
      host.replaceChildren(canvas); // swap only when ready, so zooming doesn't flash

      void pageLinks(pdf, page, viewport).then((found) => !cancelled && setLinks(found));

      // Text layer still there from before (same zoom)? Keep it, so a selection in it survives.
      if ((textDiv.firstElementChild as HTMLElement | null)?.dataset.scale === String(scale)) return;
      const fresh = document.createElement("div");
      fresh.className = "textLayer";
      fresh.dataset.scale = String(scale);
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: fresh, viewport });
      try {
        await textLayer.render();
      } catch {
        return;
      }
      if (cancelled) return;
      textDiv.replaceChildren(fresh);
      setTextVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [near, scale, pdf, num]);

  const w = size.width * scale;
  const h = size.height * scale;
  return (
    <div
      ref={ref}
      data-page={num}
      data-link-hover={hoverLink ? "true" : undefined}
      onClick={onPageClick}
      onMouseMove={onPageMouseMove}
      onMouseLeave={() => hoverLink && setHoverLink(null)}
      className="pdf-page relative isolate shrink-0 overflow-hidden rounded-sm shadow-[0_1px_3px_rgba(0,0,0,0.12),0_8px_24px_-12px_rgba(0,0,0,0.25)]"
      style={
        {
          width: w,
          height: h,
          "--total-scale-factor": scale,
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as React.CSSProperties
      }
    >
      {/* The "paper": page + highlights, filtered together (dark mode inverts both, so the
          multiply highlights keep working). The text layer stays outside, unfiltered. */}
      <div className="absolute inset-0 bg-white" style={pageFilter ? { filter: pageFilter } : undefined}>
      <div ref={canvasHost} className="absolute inset-0 select-none [&>canvas]:h-full! [&>canvas]:w-full!" />
      {userBars.length > 0 && (
        <div className="pointer-events-none absolute inset-0 select-none mix-blend-multiply">
          {userBars.flatMap(({ h, bars }) =>
            bars.map((b, i) => <div key={`${h.id}-${i}`} data-highlight={h.color} className="absolute rounded-[2px]" style={{ ...b, backgroundColor: barColor(h.color, { dark: darkPages, tinted: !!tint }) }} />),
          )}
        </div>
      )}
      {(hitBars.length > 0 || flashBars) && (
        // Same trick as the selection: opaque colours + multiply keep the text crisp.
        <div className="pointer-events-none absolute inset-0 select-none mix-blend-multiply">
          {hitBars.flatMap((bars, n) =>
            bars.map((b, i) => (
              <div
                key={`h${n}-${i}`}
                className={n === searchCurrent ? "absolute rounded-[2px] bg-orange-300" : "absolute rounded-[2px] bg-yellow-200"}
                style={b}
              />
            )),
          )}
          {flashBars?.map((b, i) => <div key={`f${i}`} className="flash-bar absolute rounded-[3px] bg-violet-300" style={b} />)}
        </div>
      )}
      {highlights && (
        // Opaque colour + multiply: overlaps don't get darker, and the text underneath stays crisp.
        <div className="pointer-events-none absolute inset-0 select-none mix-blend-multiply">
          {highlights.map((h, i) => (
            <div key={i} className="absolute rounded-[3px] bg-violet-200" style={h} />
          ))}
        </div>
      )}
      </div>
      {tint && <div className="pointer-events-none absolute inset-0 select-none mix-blend-multiply" style={{ backgroundColor: tint }} />}
      {markBars.length > 0 && (
        // Subtle dotted underline so discussed passages never visually clash with yellow/orange highlights.
        <div className="pointer-events-none absolute inset-0 select-none">
          {markBars.flatMap((m) =>
            m.bars.map((b, i) => (
              <div
                key={`${m.id}-${i}`}
                className="absolute border-b-2 border-dotted border-amber-500/80 dark:border-amber-400/80"
                style={b}
              />
            )),
          )}
        </div>
      )}
      {hoverLink && (
        <div
          className="pointer-events-none absolute rounded-[2px] bg-violet-500/15 ring-1 ring-violet-500/40"
          style={{ left: hoverLink.left, top: hoverLink.top, width: hoverLink.width, height: hoverLink.height }}
        >
          <span className="absolute -top-5 left-0 rounded bg-zinc-900/90 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900">
            p. {pageLabel(labels, hoverLink.page)}
          </span>
        </div>
      )}
      <div ref={textHost} className="absolute inset-0" />
      {markBars.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onMarkClick(m.id)}
          onMouseDown={(e) => e.stopPropagation()}
          title="Asked about in the chat — show the answer"
          className="absolute right-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-amber-400/90 text-white shadow-sm transition hover:scale-110 hover:bg-amber-500"
          style={{ top: m.bars[0].top + m.bars[0].height / 2 - 10 }}
        >
          <MessageSquareText className="size-3" />
        </button>
      ))}
      {userBars
        .filter(({ h }) => h.comment)
        .map(({ h, bars }) => (
          <button
            key={`c-${h.id}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHighlightClick?.({ id: h.id, left: e.clientX, top: e.clientY + 14 });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title={h.comment}
            className="absolute left-1 z-10 flex size-4 items-center justify-center rounded-full text-white shadow-sm transition hover:scale-110"
            style={{ top: bars[0].top + bars[0].height / 2 - 8, backgroundColor: HL_STYLE[h.color].dot }}
          >
            <StickyNote className="size-2.5" />
          </button>
        ))}
      {snipping && <SnipOverlay scale={scale} onSnip={(r) => onSnip(num, r)} />}
      <span className="pointer-events-none absolute right-2 bottom-1.5 text-[10px] font-medium text-zinc-400 select-none">
        {label}
      </span>
    </div>
  );
});

type Point = { x: number; y: number };

/** Drag a box on the page; reports it in page coordinates at zoom 1. */
function SnipOverlay({ scale, onSnip }: { scale: number; onSnip: (r: PageRect) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);

  const pos = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
    };
  };

  const box =
    start && end
      ? {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : null;

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-20 cursor-crosshair touch-none bg-violet-500/[0.04]"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pos(e);
        setStart(p);
        setEnd(p);
      }}
      onPointerMove={(e) => start && setEnd(pos(e))}
      onPointerUp={() => {
        if (box && box.width >= 8 && box.height >= 8) {
          onSnip({ x: box.left / scale, y: box.top / scale, width: box.width / scale, height: box.height / scale });
        }
        setStart(null);
        setEnd(null);
      }}
      onPointerCancel={() => {
        setStart(null);
        setEnd(null);
      }}
    >
      {box && (
        <div
          className="pointer-events-none absolute rounded-[3px] border-2 border-violet-500 bg-violet-500/5 shadow-[0_0_0_9999px_rgba(24,24,27,0.28)]"
          style={box}
        >
          <span className="absolute top-1 left-1 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white tabular-nums">
            {Math.round(box.width / scale)} × {Math.round(box.height / scale)}
          </span>
        </div>
      )}
    </div>
  );
}
