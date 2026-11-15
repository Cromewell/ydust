import clsx from "clsx";
import { Download, Highlighter, ListTree, NotebookPen, StickyNote, X } from "lucide-react";
import { useMemo, useState } from "react";
import { HL_COLORS, type Highlight, type HlColor } from "../lib/api";
import { HL_STYLE } from "../lib/highlightColors";
import type { Anchor } from "./NotePicker";

export type SideTab = "contents" | "highlights";

/** Header of the left panel: Contents | Highlights, and close. */
export function SideTabs({ tab, onTab, count, onClose }: { tab: SideTab; onTab: (t: SideTab) => void; count: number; onClose: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
      {(["contents", "highlights"] as const).map((t) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          className={clsx(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition",
            tab === t ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {t === "contents" ? <ListTree className="size-3.5" /> : <Highlighter className="size-3.5" />}
          {t === "contents" ? "Contents" : "Highlights"}
          {t === "highlights" && count > 0 && <span className="text-[10px] text-zinc-400 tabular-nums">{count}</span>}
        </button>
      ))}
      <button onClick={onClose} className="icon-btn ml-auto size-7" title="Close">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** The document's highlights by page, filterable by colour, with export. */
export function HighlightsPanel({
  highlights,
  header,
  onOpen,
  onExport,
  onCopyToNote,
}: {
  highlights: Highlight[];
  header: React.ReactNode;
  /** Jump to it (and flash it). */
  onOpen: (h: Highlight) => void;
  onExport: (list: Highlight[]) => void;
  onCopyToNote: (list: Highlight[], at: Anchor) => void;
}) {
  const [filter, setFilter] = useState<Set<HlColor>>(new Set());
  const shown = useMemo(() => highlights.filter((h) => !filter.size || filter.has(h.color)), [highlights, filter]);
  const pages = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of shown) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [shown]);
  const counts = useMemo(() => Object.fromEntries(HL_COLORS.map((c) => [c, highlights.filter((h) => h.color === c).length])), [highlights]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      {header}
      {highlights.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800" role="group" aria-label="Filter by colour">
          {HL_COLORS.filter((c) => counts[c]).map((c) => (
            <button
              key={c}
              aria-pressed={filter.has(c)}
              onClick={() =>
                setFilter((f) => {
                  const next = new Set(f);
                  if (next.has(c)) next.delete(c);
                  else next.add(c);
                  return next;
                })
              }
              className={clsx(
                "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums transition",
                filter.has(c) ? "border-zinc-400 bg-white text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100" : "border-transparent text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800",
              )}
              title={`Only ${HL_STYLE[c].label.toLowerCase()}`}
            >
              <span className="size-2.5 rounded-full" style={{ backgroundColor: HL_STYLE[c].dot }} />
              {counts[c]}
            </button>
          ))}
          {filter.size > 0 && (
            <button onClick={() => setFilter(new Set())} className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              All
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!highlights.length ? (
          <p className="p-3 text-xs leading-relaxed text-zinc-500">
            No highlights yet. Select text in the PDF and click one of the coloured dots to mark it. Click a highlight to change its colour, add a comment or ask about it.
          </p>
        ) : (
          pages.map(([page, list]) => (
            <section key={page} className="mb-2">
              <h3 className="px-1.5 pt-1 pb-0.5 text-[11px] font-semibold text-zinc-400">Page {page}</h3>
              <ul>
                {list.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => onOpen(h)} className="flex w-full gap-2 rounded-md px-1.5 py-1 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800">
                      <span className="mt-1 w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: HL_STYLE[h.color].dot }} />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-3 text-[13px] leading-snug text-zinc-700 dark:text-zinc-300">{h.text}</span>
                        {h.comment && (
                          <span className="mt-0.5 flex items-start gap-1 text-[11px] text-zinc-500">
                            <StickyNote className="mt-0.5 size-3 shrink-0" />
                            <span className="line-clamp-2">{h.comment}</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {shown.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-t border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onCopyToNote(shown, { left: r.left, top: r.top - 260 });
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title={`Put ${filter.size ? "these" : "all"} highlights into a note, as quotes with page links`}
          >
            <NotebookPen className="size-3.5" /> Copy {filter.size ? "these" : "all"} into a note
          </button>
          <button onClick={() => onExport(shown)} className="icon-btn ml-auto size-7" title="Export as Markdown, by page">
            <Download className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
