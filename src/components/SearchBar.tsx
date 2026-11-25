import clsx from "clsx";
import { ChevronDown, ChevronUp, List, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FolderHits } from "../lib/api";
import { usePageLabels } from "../hooks/usePageLabels";
import { pageLabel } from "../lib/pageLabels";

export type SearchHit = { page: number; n: number; before: string; match: string; after: string };

type Hit = { page: number; n: number };
export type FolderSearch = {
  name: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  data: FolderHits | null;
  loading: boolean;
  failed: boolean;
  /** The open PDF. */
  activeDoc: string;
  docName: (id: string) => string;
  onOpen: (doc: string, hit: Hit) => void;
};

/** Hits in all PDFs of the folder, in its order. */
function FolderResults({ folder, query, current }: { folder: FolderSearch; query: string; current?: Hit }) {
  const lookup = usePageLabels();
  const box = useRef<HTMLDivElement>(null);
  const at = current && `${folder.activeDoc}:${current.page}:${current.n}`;
  useEffect(() => {
    box.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, folder.data]);
  if (query.trim().length < 2) return null;
  const { data } = folder;
  const note = "border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800";
  if (folder.failed) return <p className={note}>The folder could not be searched.</p>;
  if (!data) return <p className={note}>Searching…</p>;
  const docs = data.docs;
  const unread = data.unread > 0 && `${data.unread} PDF${data.unread === 1 ? " has" : "s have"} no searchable text.`;
  if (!docs.length) return <p className={note}>No results in this folder. {unread}</p>;
  return (
    <div ref={box} className="max-h-96 overflow-y-auto border-t border-zinc-200 p-1 dark:border-zinc-800">
      {docs.map((d) => (
        <section key={d.id} aria-label={folder.docName(d.id)}>
          <h3 className="sticky -top-1 flex gap-2 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-900">
            <span className="min-w-0 flex-1 truncate">{folder.docName(d.id)}</span>
            <span className="shrink-0 font-normal tabular-nums">{d.total}</span>
          </h3>
          <ul>
            {d.hits.map((h) => (
              <li key={`${h.page}-${h.n}`}>
                <button
                  type="button"
                  onClick={() => folder.onOpen(d.id, h)}
                  aria-current={`${d.id}:${h.page}:${h.n}` === at}
                  className={clsx(
                    "flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition",
                    `${d.id}:${h.page}:${h.n}` === at ? "bg-orange-50 dark:bg-orange-500/10" : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  )}
                >
                  <HitText label={pageLabel(lookup.doc(d.id), h.page)} h={h} />
                </button>
              </li>
            ))}
          </ul>
          {d.total > d.hits.length && <p className="px-2 pb-1 text-[11px] text-zinc-400">… and {d.total - d.hits.length} more</p>}
        </section>
      ))}
      {unread && <p className="px-2 py-1 text-[11px] text-zinc-400">{unread}</p>}
    </div>
  );
}

function HitText({ label, h }: { label: string; h: { before: string; match: string; after: string } }) {
  return (
    <>
      <span className="w-9 shrink-0 pt-px text-right font-medium text-zinc-400 tabular-nums">p. {label}</span>
      <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
        {h.before}
        <mark className="rounded-sm bg-yellow-200 px-0.5 text-zinc-900">{h.match}</mark>
        {h.after}
      </span>
    </>
  );
}

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
  folder,
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
  /** Searching all of the PDF's folder (null: it is in none, or alone in it). */
  folder: FolderSearch | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const lookup = usePageLabels();
  const labels = lookup.cite();
  const inFolder = !!folder?.on;
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, showList]);

  const all = inFolder ? (folder!.data?.docs ?? []).flatMap((d) => d.hits.map((h) => ({ ...h, doc: d.id }))) : [];
  const found = inFolder ? all.length : hits.length;
  const go = (dir: 1 | -1) => {
    if (!found) return;
    if (!inFolder) return onGo((current + dir + found) % found);
    // From the open PDF's hit (which may be beyond the listed ones) to the next listed one, around the end.
    const order = folder!.data!.docs.map((d) => d.id);
    const h = hits[current] ?? { page: 0, n: 0 };
    const from = [order.indexOf(folder!.activeDoc), h.page, h.n];
    const rank = (x: (typeof all)[number]) => {
      const to = [order.indexOf(x.doc), x.page, x.n];
      const i = to.findIndex((v, k) => v !== from[k]);
      return i === -1 ? 0 : to[i] - from[i];
    };
    const next = dir === 1 ? (all.find((x) => rank(x) > 0) ?? all[0]) : (all.findLast((x) => rank(x) < 0) ?? all[found - 1]);
    folder!.onOpen(next.doc, next);
  };
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
          placeholder={inFolder ? `Search in “${folder!.name}”…` : unavailable ? "This PDF has no searchable text" : "Search in document…"}
          disabled={unavailable && !folder}
          className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-zinc-400"
          aria-label={inFolder ? "Search in folder" : "Search in document"}
        />
        <span className="shrink-0 px-1 text-xs text-zinc-500 tabular-nums">
          {(inFolder ? folder!.loading : loading) ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : query.trim().length >= 2 ? (
            inFolder ? (
              (folder!.data?.docs.reduce((n, d) => n + d.total, 0) ?? 0)
            ) : hits.length ? `${current + 1}/${hits.length}${hits.length >= 1000 ? "+" : ""}` : "No results"
          ) : tooShort ? (
            "2+ letters"
          ) : null}
        </span>
        <button onClick={() => go(-1)} disabled={!found} className="icon-btn size-7" title="Previous (Shift+Enter)">
          <ChevronUp className="size-4" />
        </button>
        <button onClick={() => go(1)} disabled={!found} className="icon-btn size-7" title="Next (Enter)">
          <ChevronDown className="size-4" />
        </button>
        <button
          onClick={() => setShowList((v) => !v)}
          hidden={inFolder}
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
      {folder && (
        <div role="radiogroup" aria-label="Where to search" className="flex gap-0.5 px-1.5 pb-1.5">
          {[false, true].map((on) => (
            <button
              key={String(on)}
              type="button"
              role="radio"
              aria-checked={folder.on === on}
              onClick={() => {
                folder.onToggle(on);
                input.current?.focus();
              }}
              className={clsx(
                "max-w-48 truncate rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                folder.on === on ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
              )}
              title={on ? "Search in all PDFs of the folder (Ctrl+Shift+F)" : "Search in this PDF only"}
            >
              {on ? `Folder “${folder.name}”` : "This PDF"}
            </button>
          ))}
        </div>
      )}
      {inFolder && <FolderResults folder={folder!} query={query} current={hits[current]} />}
      {!inFolder && showList && hits.length > 0 && (
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
                <HitText label={pageLabel(labels, h.page)} h={h} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
