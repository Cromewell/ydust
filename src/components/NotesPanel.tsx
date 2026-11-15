import clsx from "clsx";
import { Download, FileText, Folder, Loader2, NotebookPen, Pencil, Plus, Trash2, X } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { api, type NoteInfo, type NoteOwner } from "../lib/api";
import { downloadText, noteFilesMarkdown, safeFilename } from "../lib/export";
import { toNoteName } from "../lib/noteNames";
import { sameOwner } from "../lib/notes";
import type { TextSize } from "../lib/settings";

// CodeMirror is big: load it with the first note you open.
const NoteEditor = lazy(() => import("./NoteEditor"));

/** The note in the editor; `line` + `nonce`: jump to that line (a "[L12]" link in a review). */
export type OpenNote = { owner: NoteOwner; name: string; line?: number; nonce?: number };

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`);

/** The notes of the open PDF and of its folder, and the editor for one of them. */
export function NotesPanel({
  owners,
  open,
  onOpen,
  refresh,
  onJump,
  hasDoc,
  textSize,
  onReview,
}: {
  /** The open PDF first, then its folder (if any). */
  owners: NoteOwner[];
  open: OpenNote | null;
  onOpen: (note: OpenNote | null) => void;
  /** Changes when notes were changed from outside the panel (to reload the lists). */
  refresh: number;
  onJump: (page: number, doc?: string, label?: string) => void;
  hasDoc: (alias: string) => boolean;
  textSize: TextSize;
  onReview: (owner: NoteOwner, name: string, mode: "review-note" | "challenge-note", lines?: [number, number]) => void;
}) {
  const [lists, setLists] = useState<Record<string, NoteInfo[] | "error">>({});
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const keyOf = (o: NoteOwner) => `${o.kind}:${o.id}`;
  const ownersKey = owners.map(keyOf).join("|");

  useEffect(() => {
    let cancelled = false;
    for (const o of owners) {
      api.listNotes(o).then(
        (l) => !cancelled && setLists((x) => ({ ...x, [keyOf(o)]: l })),
        () => !cancelled && setLists((x) => ({ ...x, [keyOf(o)]: "error" })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [ownersKey, tick, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  if (open && owners.some((o) => sameOwner(o, open.owner))) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-zinc-400">
            <Loader2 className="size-5 animate-spin" />
          </div>
        }
      >
        {/* One editor per note: switching notes must never save one note's text under another's name. */}
        <NoteEditor
          key={`${keyOf(open.owner)}/${open.name}`}
          owner={open.owner}
          name={open.name}
          onBack={() => {
            onOpen(null);
            reload();
          }}
          onSaved={reload}
          onJump={onJump}
          hasDoc={hasDoc}
          textSize={textSize}
          onReview={(mode, lines) => onReview(open.owner, open.name, mode, lines)}
          focusLine={open.line ? { line: open.line, nonce: open.nonce ?? 0 } : null}
        />
      </Suspense>
    );
  }

  const exportAll = async () => {
    const groups = await Promise.all(
      owners.map(async (owner) => {
        const list = lists[keyOf(owner)];
        const notes = Array.isArray(list) ? await Promise.all(list.map((n) => api.getNote(owner, n.name))) : [];
        return { owner, notes };
      }),
    );
    downloadText(`${safeFilename(owners[0]?.name ?? "ydust")} - notes.md`, noteFilesMarkdown(groups));
  };
  const total = owners.reduce((n, o) => n + (Array.isArray(lists[keyOf(o)]) ? (lists[keyOf(o)] as NoteInfo[]).length : 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {owners.map((o) => (
          <NoteGroup
            key={keyOf(o)}
            owner={o}
            grouped={owners.length > 1}
            list={lists[keyOf(o)]}
            onOpen={(name) => onOpen({ owner: o, name })}
            onChanged={reload}
          />
        ))}
        {total === 0 && Object.keys(lists).length > 0 && (
          <p className="mx-auto mt-6 max-w-64 text-center text-xs text-zinc-500">
            Notes are Markdown files next to your PDF: write summaries with formulas ($x^2$) and page links ([p. 12](#page=12)). Select text in the PDF →{" "}
            <b>Add to note</b> to quote it.
          </p>
        )}
      </div>
      {total > 0 && (
        <div className="flex shrink-0 justify-end border-t border-zinc-100 px-3 py-1.5 dark:border-zinc-900">
          <button onClick={() => void exportAll()} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200">
            <Download className="size-3.5" /> Export all notes
          </button>
        </div>
      )}
    </div>
  );
}

function NoteGroup({
  owner,
  grouped,
  list,
  onOpen,
  onChanged,
}: {
  owner: NoteOwner;
  grouped: boolean;
  list: NoteInfo[] | "error" | undefined;
  onOpen: (name: string) => void;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const Icon = owner.kind === "folder" ? Folder : FileText;
  return (
    <section className="mb-4">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        {grouped && (
          <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{owner.kind === "folder" ? `Folder “${owner.name}”` : "This PDF"}</span>
          </h3>
        )}
        {!grouped && <span className="flex-1" />}
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
          title={owner.kind === "folder" ? "New note for the whole folder" : "New note for this PDF"}
        >
          <Plus className="size-3.5" /> New note
        </button>
      </div>
      {creating && (
        <NameInput
          initial=""
          placeholder="Name, e.g. Summary chapter 3"
          onCancel={() => setCreating(false)}
          onSubmit={async (name) => {
            const title = name.replace(/\.md$/, "");
            await api.saveNote(owner, name, `# ${title}\n\n`, null);
            setCreating(false);
            onChanged();
            onOpen(name);
          }}
        />
      )}
      {list === undefined ? (
        <Loader2 className="mx-auto my-3 size-4 animate-spin text-zinc-400" />
      ) : list === "error" ? (
        <p className="px-1 text-xs text-red-600">Could not load the notes.</p>
      ) : list.length === 0 ? (
        grouped && !creating && <p className="px-1 text-xs text-zinc-400">No notes yet.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((n) => (
            <NoteRow key={n.name} owner={owner} note={n} onOpen={() => onOpen(n.name)} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteRow({ owner, note, onOpen, onChanged }: { owner: NoteOwner; note: NoteInfo; onOpen: () => void; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (renaming) {
    return (
      <li>
        <NameInput
          initial={note.name.replace(/\.md$/, "")}
          onCancel={() => setRenaming(false)}
          onSubmit={async (to) => {
            if (to !== note.name) await api.renameNote(owner, note.name, to);
            setRenaming(false);
            onChanged();
          }}
        />
      </li>
    );
  }
  return (
    <li className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left">
        <NotebookPen className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{note.name}</span>
          <span className="block truncate text-[11px] text-zinc-400">
            {note.title && note.title !== note.name.replace(/\.md$/, "") ? `${note.title} · ` : ""}
            {kb(note.size)} · {ago(note.updatedAt)}
          </span>
        </span>
      </button>
      <div className={clsx("flex items-center", !confirm && "opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100")}>
        <button onClick={() => setRenaming(true)} className="icon-btn size-6" title="Rename">
          <Pencil className="size-3" />
        </button>
        <button
          onClick={() => void api.getNote(owner, note.name).then((n) => downloadText(n.name, n.content))}
          className="icon-btn size-6"
          title="Download"
        >
          <Download className="size-3" />
        </button>
        {confirm ? (
          <button
            autoFocus
            onBlur={() => setConfirm(false)}
            onClick={() => void api.removeNote(owner, note.name).then(onChanged)}
            className="rounded-md bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white"
          >
            Delete
          </button>
        ) : (
          <button onClick={() => setConfirm(true)} className="icon-btn size-6 hover:text-red-600" title="Delete">
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
    </li>
  );
}

/** A name field: what you type becomes a valid file name (".md" is added). */
export function NameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = toNoteName(value);
  return (
    <form
      className="mb-1 px-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name || busy) return;
        setBusy(true);
        onSubmit(name)
          .catch((err) => setError((err as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex items-center gap-1 rounded-lg border border-violet-300 bg-white px-2 py-1 focus-within:ring-2 focus-within:ring-violet-500/20 dark:border-violet-500/40 dark:bg-zinc-900">
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          aria-label="Note name"
        />
        <span className="text-xs text-zinc-400">.md</span>
        <button type="button" onClick={onCancel} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Cancel">
          <X className="size-3.5" />
        </button>
      </div>
      {(error || (value.trim() && name && name.replace(/\.md$/, "") !== value.trim().replace(/\.md$/i, ""))) && (
        <p className={clsx("mt-0.5 px-1 text-[11px]", error ? "text-red-600" : "text-zinc-400")}>{error ?? `Saved as “${name}”`}</p>
      )}
    </form>
  );
}
