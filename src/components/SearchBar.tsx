import clsx from "clsx";
import { ChevronDown, ChevronUp, List, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePageLabels } from "../hooks/usePageLabels";
import { pageLabel } from "../lib/pageLabels";

export type SearchHit = { page: number; n: number; before: string; match: string; after: string };

export function SearchBar({
  query,
  onQuery,
  hits,
  current,
  loading,
  unavailable,
  onGo,
  onClose,
  focusNonce,
}: {
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  current: number;
  loading: boolean;
  unavailable: boolean;
  onGo: (index: number) => void;
  onClose: () => void;
  /** Changes whenever the bar should grab focus again (e.g. Ctrl+F while open). */
  focusNonce: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const labels = usePageLabels().cite();
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, showList]);

  const go = (dir: 1 | -1) => hits.length && onGo((current + dir + hits.length) % hits.length);
  const tooShort = query.trim().length > 0 && query.trim().length < 2;

  return (
    <div className="animate-pop absolute top-3 right-4 z-30 w-[min(26rem,calc(100%-2rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center gap-1 p-1.5">
        <Search className="ml-1.5 size-4 shrink-0 text-zinc-400" />
        <input
          ref={input}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={unavailable ? "This PDF has no searchable text" : "Search in document…"}
          disabled={unavailable}
          className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-zinc-400"
          aria-label="Search in document"
        />
        <span className="shrink-0 px-1 text-xs text-zinc-500 tabular-nums">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : query.trim().length >= 2 ? (
            hits.length ? `${current + 1}/${hits.length}${hits.length >= 1000 ? "+" : ""}` : "No results"
          ) : tooShort ? (
            "2+ letters"
          ) : null}
        </span>
        <button onClick={() => go(-1)} disabled={!hits.length} className="icon-btn size-7" title="Previous (Shift+Enter)">
          <ChevronUp className="size-4" />
        </button>
        <button onClick={() => go(1)} disabled={!hits.length} className="icon-btn size-7" title="Next (Enter)">
          <ChevronDown className="size-4" />
        </button>
        <button
          onClick={() => setShowList((v) => !v)}
          disabled={!hits.length}
          className={clsx("icon-btn size-7", showList && hits.length > 0 && "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100")}
          title="Show all results"
        >
          <List className="size-4" />
        </button>
        <button onClick={onClose} className="icon-btn size-7" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </div>
      {showList && hits.length > 0 && (
        <ul ref={list} className="max-h-72 overflow-y-auto border-t border-zinc-200 p-1 dark:border-zinc-800">
          {hits.map((h, i) => (
            <li key={`${h.page}-${h.n}`}>
              <button
                data-i={i}
                type="button"
                onClick={() => onGo(i)}
                className={clsx(
                  "flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition",
                  i === current ? "bg-orange-50 dark:bg-orange-500/10" : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                )}
              >
                <span className="w-9 shrink-0 pt-px text-right font-medium text-zinc-400 tabular-nums">p. {pageLabel(labels, h.page)}</span>
                <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
                  {h.before}
                  <mark className="rounded-sm bg-yellow-200 px-0.5 text-zinc-900">{h.match}</mark>
                  {h.after}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
