import clsx from "clsx";
import { Download, Highlighter, Library, ListTree, NotebookPen, StickyNote, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import { usePageLabels } from "../hooks/usePageLabels";
import { HL_COLORS, type Highlight, type HlColor } from "../lib/api";
import { HL_STYLE, hlLabel, type HighlightLabels } from "../lib/highlightColors";
import { pageLabel } from "../lib/pageLabels";
import type { Anchor } from "./NotePicker";

export type SideTab = "library" | "contents" | "highlights";

/** Unified header of the left sidebar: Library | Contents | Highlights. */
export function SideTabs({
  tab,
  onTab,
  hasDoc,
  count,
  onClose,
}: {
  tab: SideTab;
  onTab: (t: SideTab) => void;
  hasDoc: boolean;
  count: number;
  onClose?: () => void;
}) {
  const tabs: { id: SideTab; icon: typeof Library; label: string; title: string }[] = [
    { id: "library", icon: Library, label: "Library", title: "Documents and folders" },
    ...(hasDoc
      ? [
          { id: "contents" as const, icon: ListTree, label: "Contents", title: "Table of contents" },
          { id: "highlights" as const, icon: Highlighter, label: "Marks", title: "Coloured highlights" },
        ]
      : []),
  ];
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-zinc-200 px-1.5 dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTab(t.id)}
          title={t.title}
          className={clsx(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition",
            tab === t.id ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          <t.icon className="size-3.5 shrink-0" />
          <span>{t.label}</span>
          {t.id === "highlights" && count > 0 && <span className="text-[10px] text-zinc-400 tabular-nums">{count}</span>}
        </button>
      ))}
      {onClose && (
        <button onClick={onClose} className="icon-btn ml-auto size-7" title="Close">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** The document's highlights by page, filterable by colour, with editable colour labels and export. */
export function HighlightsPanel({
  highlights,
  header,
  colorLabels = {},
  onColorLabels,
  onOpen,
  onExport,
  onCopyToNote,
}: {
  highlights: Highlight[];
  header: React.ReactNode;
  colorLabels?: HighlightLabels;
  onColorLabels?: (labels: HighlightLabels) => void;
  /** Jump to it (and flash it). */
  onOpen: (h: Highlight) => void;
  onExport: (list: Highlight[]) => void;
  onCopyToNote: (list: Highlight[], at: Anchor) => void;
}) {
  const labels = usePageLabels().cite();
  const [filter, setFilter] = useState<Set<HlColor>>(new Set());
  const [editLabels, setEditLabels] = useState(false);
  const [draftLabels, setDraftLabels] = useState<HighlightLabels>(colorLabels);
  const shown = useMemo(() => highlights.filter((h) => !filter.size || filter.has(h.color)), [highlights, filter]);
  const pages = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of shown) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [shown]);
  const counts = useMemo(() => Object.fromEntries(HL_COLORS.map((c) => [c, highlights.filter((h) => h.color === c).length])), [highlights]);

  const toggleEditLabels = () => {
    if (!editLabels) setDraftLabels(colorLabels);
    setEditLabels((v) => !v);
  };

  const commitLabels = () => {
    setEditLabels(false);
    onColorLabels?.(draftLabels);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      {header}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800" role="group" aria-label="Filter by colour">
        {HL_COLORS.filter((c) => counts[c]).map((c) => (
          <button
            key={c}
            type="button"
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
            title={`Only ${hlLabel(c, colorLabels)}`}
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: HL_STYLE[c].dot }} />
            {colorLabels[c] && <span className="max-w-16 truncate">{colorLabels[c]}</span>}
            {counts[c]}
          </button>
        ))}
        {filter.size > 0 && (
          <button type="button" onClick={() => setFilter(new Set())} className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            All
          </button>
        )}
        {onColorLabels && (
          <button
            type="button"
            onClick={toggleEditLabels}
            aria-expanded={editLabels}
            className={clsx(
              "ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition",
              editLabels ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" : "text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
            )}
            title="Name your highlight colours (e.g. Definition, Exam)"
          >
            <Tag className="size-3" />
            Labels
          </button>
        )}
      </div>
      {editLabels && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commitLabels();
          }}
          className="shrink-0 space-y-1.5 border-b border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="text-[11px] text-zinc-500">Give colours meanings (the tutor sees them too):</p>
          {HL_COLORS.map((c) => (
            <label key={c} className="flex items-center gap-2 text-xs">
              <span className="size-3 shrink-0 rounded-full border border-black/10 dark:border-white/20" style={{ backgroundColor: HL_STYLE[c].dot }} />
              <input
                value={draftLabels[c] ?? ""}
                onChange={(e) => setDraftLabels((d) => ({ ...d, [c]: e.target.value }))}
                maxLength={32}
                placeholder={HL_STYLE[c].label}
                className="min-w-0 flex-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-xs outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
          ))}
          <div className="flex justify-end gap-1.5 pt-1">
            <button type="button" onClick={() => setEditLabels(false)} className="rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Cancel
            </button>
            <button type="submit" className="rounded bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-500">
              Save
            </button>
          </div>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!highlights.length ? (
          <p className="p-3 text-xs leading-relaxed text-zinc-500">
            No highlights yet. Select text in the PDF and click the coloured dot to mark it. Click a highlight to change its colour, add a comment or ask about it.
          </p>
        ) : (
          pages.map(([page, list]) => (
            <section key={page} className="mb-2">
              <h3 className="px-1.5 pt-1 pb-0.5 text-[11px] font-semibold text-zinc-400">Page {pageLabel(labels, page)}</h3>
              <ul>
                {list.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => onOpen(h)} className="flex w-full gap-2 rounded-md px-1.5 py-1 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800">
                      <span className="mt-1 w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: HL_STYLE[h.color].dot }} title={hlLabel(h.color, colorLabels)} />
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
