import clsx from "clsx";
import { FileText, Folder, NotebookPen, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DocSummary, type FolderSummary, type NoteInfo, type NoteOwner } from "../lib/api";
import { fold } from "../lib/textMatch";

type Item =
  | { kind: "doc"; key: string; doc: DocSummary; folderName?: string; haystack: string }
  | { kind: "note"; key: string; owner: NoteOwner; note: NoteInfo; haystack: string };

/** Ctrl/Cmd+P: quickly jump to any PDF in your library or any note of the current PDF/folder. */
export function QuickSwitcher({
  docs,
  folders,
  activeDocId,
  noteOwners,
  onSelectDoc,
  onSelectNote,
  onClose,
}: {
  docs: DocSummary[];
  folders: FolderSummary[];
  activeDocId: string | null;
  noteOwners: NoteOwner[];
  onSelectDoc: (id: string) => void;
  onSelectNote: (owner: NoteOwner, name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [notes, setNotes] = useState<{ owner: NoteOwner; list: NoteInfo[] }[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      noteOwners.map(async (owner) => ({
        owner,
        list: await api.listNotes(owner).catch(() => [] as NoteInfo[]),
      })),
    ).then((res) => !cancelled && setNotes(res));
    return () => {
      cancelled = true;
    };
  }, [noteOwners]);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const d of docs) {
      const folderName = d.folderId ? folderById.get(d.folderId) : undefined;
      out.push({
        kind: "doc",
        key: `doc:${d.id}`,
        doc: d,
        folderName,
        haystack: fold(`${d.name} ${folderName ?? ""}`),
      });
    }
    for (const { owner, list } of notes) {
      for (const n of list) {
        out.push({
          kind: "note",
          key: `note:${owner.kind}:${owner.id}:${n.name}`,
          owner,
          note: n,
          haystack: fold(`${n.name} ${n.title ?? ""} ${owner.name}`),
        });
      }
    }
    return out;
  }, [docs, folderById, notes]);

  const filtered = useMemo(() => {
    const words = query.trim().split(/\s+/).map(fold).filter(Boolean);
    if (!words.length) return items;
    return items.filter((it) => words.every((w) => it.haystack.includes(w)));
  }, [items, query]);

  const active = Math.min(index, Math.max(0, filtered.length - 1));

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (it: Item) => {
    onClose();
    if (it.kind === "doc") onSelectDoc(it.doc.id);
    else onSelectNote(it.owner, it.note.name);
  };

  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center bg-zinc-950/35 p-4 pt-[14vh] backdrop-blur-[1px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Quick switcher"
        className="animate-pop w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
          <Search className="size-4 shrink-0 text-zinc-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown" && filtered.length) {
                e.preventDefault();
                setIndex((i) => (i + 1) % filtered.length);
              } else if (e.key === "ArrowUp" && filtered.length) {
                e.preventDefault();
                setIndex((i) => (i - 1 + filtered.length) % filtered.length);
              } else if (e.key === "Enter" && filtered[active]) {
                e.preventDefault();
                choose(filtered[active]);
              }
            }}
            placeholder="Jump to a PDF or note…"
            aria-label="Jump to a PDF or note"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          <kbd className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-400 dark:border-zinc-700">Esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-zinc-400">No matching PDFs or notes.</li>
          ) : (
            filtered.map((it, i) => (
              <li key={it.key}>
                <button
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(it)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition",
                    i === active ? "bg-violet-50 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
                  )}
                >
                  {it.kind === "doc" ? (
                    <FileText className={clsx("size-4 shrink-0", it.doc.id === activeDocId ? "text-violet-500" : "text-zinc-400")} />
                  ) : (
                    <NotebookPen className="size-4 shrink-0 text-emerald-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{it.kind === "doc" ? it.doc.name : it.note.name}</span>
                  {it.kind === "doc" && it.folderName && (
                    <span className="flex max-w-36 shrink-0 items-center gap-1 truncate rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      <Folder className="size-3 shrink-0 text-amber-500" />
                      <span className="truncate">{it.folderName}</span>
                    </span>
                  )}
                  {it.kind === "note" && (
                    <span className="max-w-36 shrink-0 truncate rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {it.owner.kind === "folder" ? `Folder · ${it.owner.name}` : "Note"}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
