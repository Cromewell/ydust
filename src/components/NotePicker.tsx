import { Check, FileText, Folder, Loader2, NotebookPen, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type NoteInfo, type NoteOwner } from "../lib/api";
import { noteEditor, sameOwner } from "../lib/notes";
import { NameInput } from "./NotesPanel";

/** Where a picker opens: a point on screen (it stays inside the window). */
export type Anchor = { left: number; top: number };

/** Choose the note something goes into, or start a new one. */
export function NotePicker({
  owners,
  anchor,
  title,
  onPick,
  onClose,
}: {
  owners: NoteOwner[];
  anchor: Anchor;
  title: string;
  onPick: (owner: NoteOwner, name: string, isNew: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [lists, setLists] = useState<Record<string, NoteInfo[]>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(anchor);
  const open = noteEditor.get();
  const keyOf = (o: NoteOwner) => `${o.kind}:${o.id}`;

  useEffect(() => {
    for (const o of owners) api.listNotes(o).then((l) => setLists((x) => ({ ...x, [keyOf(o)]: l })), () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Keep it on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(anchor.top, window.innerHeight - r.height - 8)),
    });
  }, [anchor, lists, creating]);

  const pick = async (owner: NoteOwner, name: string, isNew: boolean) => {
    setBusy(`${keyOf(owner)}/${name}`);
    setError(null);
    try {
      await onPick(owner, name, isNew);
      onClose();
    } catch (err) {
      if (!isNew) setError((err as Error).message); // a new name's field shows its own error
      throw err;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}
      className="animate-pop fixed z-[70] max-h-[60vh] w-72 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-2xl shadow-zinc-900/15 dark:border-zinc-700 dark:bg-zinc-900"
      style={pos}
    >
      <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold text-zinc-500">{title}</p>
      {owners.map((o) => {
        const list = lists[keyOf(o)];
        const Icon = o.kind === "folder" ? Folder : FileText;
        return (
          <div key={keyOf(o)} className="mb-1">
            {owners.length > 1 && (
              <p className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
                <Icon className="size-3" />
                <span className="truncate">{o.kind === "folder" ? `Folder “${o.name}”` : "This PDF"}</span>
              </p>
            )}
            {!list ? (
              <Loader2 className="mx-auto my-2 size-4 animate-spin text-zinc-400" />
            ) : (
              list.map((n) => {
                const isOpen = !!open && sameOwner(open.owner, o) && open.name === n.name;
                return (
                  <button
                    key={n.name}
                    disabled={!!busy}
                    onClick={() => void pick(o, n.name, false).catch(() => {})}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-800"
                  >
                    {busy === `${keyOf(o)}/${n.name}` ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <NotebookPen className="size-3.5 shrink-0 text-zinc-400" />}
                    <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    {isOpen && (
                      <span className="flex items-center gap-0.5 text-[10px] text-violet-600 dark:text-violet-400">
                        <Check className="size-3" /> open
                      </span>
                    )}
                  </button>
                );
              })
            )}
            {creating === keyOf(o) ? (
              <NameInput
                initial=""
                placeholder="New note name"
                onCancel={() => setCreating(null)}
                onSubmit={(name) => pick(o, name, true)}
              />
            ) : (
              <button
                disabled={!!busy}
                onClick={() => setCreating(keyOf(o))}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-violet-600 hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
              >
                <Plus className="size-3.5 shrink-0" /> New note…
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="px-2 pb-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
