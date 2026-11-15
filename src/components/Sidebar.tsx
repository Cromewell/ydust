import clsx from "clsx";
import { Check, ChevronRight, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ChatTarget, type DocSummary, type FolderSummary } from "../lib/api";

/** A delete confirmation that names the notes going with it (counted when you click the bin). */
function useNoteCount(target: ChatTarget, asking: boolean) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!asking) return setCount(null);
    let cancelled = false;
    api.listNotes(target).then((l) => !cancelled && setCount(l.length), () => {});
    return () => {
      cancelled = true;
    };
  }, [asking, target.kind, target.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return count;
}
const withNotes = (n: number | null) => (n ? ` + ${n} note${n === 1 ? "" : "s"}` : "");

/** Drag type for moving a document between folders. */
const DOC_MIME = "application/x-ydust-doc";

type Props = {
  docs: DocSummary[];
  folders: FolderSummary[];
  activeId: string | null;
  uploading: number;
  /** Documents whose text is being read right now. */
  indexing: Set<string>;
  onSelect: (id: string) => void;
  onUpload: (files: File[], folderId?: string | null) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Resolves to the new folder's id. */
  onCreateFolder: () => Promise<string | null>;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMove: (docId: string, folderId: string | null) => void;
};

const readOpen = () => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem("ydust:openFolders") ?? "[]"));
  } catch {
    return new Set<string>();
  }
};

/** Mark a native drop as handled here, so the window-wide drop handler doesn't upload it again. */
export const markDropHandled = (e: React.DragEvent) => ((e.nativeEvent as DragEvent & { ydustHandled?: boolean }).ydustHandled = true);

export function Sidebar(props: Props) {
  const { docs, folders, activeId, uploading, onUpload, onCreateFolder, onMove } = props;
  const input = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [renaming, setRenaming] = useState<string | null>(null); // folder id
  const [dropOn, setDropOn] = useState<string | null>(null); // folder id or "none"

  const setOpenPersist = (next: Set<string>) => {
    setOpen(next);
    try {
      localStorage.setItem("ydust:openFolders", JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenPersist(next);
  };

  // Show the open document: expand its folder.
  const activeFolder = docs.find((d) => d.id === activeId)?.folderId ?? null;
  useEffect(() => {
    if (activeFolder && !open.has(activeFolder)) setOpenPersist(new Set(open).add(activeFolder));
  }, [activeFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map(docs.map((d) => [d.id, d]));
  const unfiled = docs.filter((d) => !d.folderId || !folders.some((f) => f.id === d.folderId));

  const pickFiles = (folderId: string | null) => {
    setUploadTarget(folderId);
    input.current?.click();
  };

  const newFolder = async (thenMove?: string) => {
    const id = await onCreateFolder();
    if (!id) return;
    if (thenMove) onMove(thenMove, id);
    setOpenPersist(new Set(open).add(id));
    setRenaming(id);
  };

  /** Drop zone props: a folder (id) or "not in a folder" (null). */
  const dropZone = (folderId: string | null) => {
    const key = folderId ?? "none";
    return {
      onDragOver: (e: React.DragEvent) => {
        const t = e.dataTransfer.types;
        if (!t.includes(DOC_MIME) && !t.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = t.includes(DOC_MIME) ? "move" : "copy";
        if (dropOn !== key) setDropOn(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((k) => (k === key ? null : k));
      },
      onDrop: (e: React.DragEvent) => {
        setDropOn(null);
        const doc = e.dataTransfer.getData(DOC_MIME);
        if (doc) {
          e.preventDefault();
          onMove(doc, folderId);
        } else if (e.dataTransfer.files.length) {
          e.preventDefault();
          markDropHandled(e);
          onUpload(Array.from(e.dataTransfer.files), folderId);
        }
      },
    };
  };

  return (
    <nav className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="text-[15px] font-semibold tracking-tight">ydust</span>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={() => pickFiles(null)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {uploading ? "Uploading…" : "Add PDF"}
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onUpload(files, uploadTarget);
          }}
        />
      </div>

      <div className="flex items-center px-4 pb-1.5">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Library</span>
        <button onClick={() => void newFolder()} className="icon-btn size-6" title="New folder">
          <FolderPlus className="size-3.5" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {docs.length === 0 && folders.length === 0 && <li className="px-2 py-3 text-xs text-zinc-400">No documents yet.</li>}

        {folders.map((f) => {
          const members = f.docIds.map((id) => byId.get(id)).filter((d): d is DocSummary => !!d);
          const isOpen = open.has(f.id);
          return (
            <li key={f.id} {...dropZone(f.id)} className={clsx("rounded-lg", dropOn === f.id && "bg-violet-100/70 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40")}>
              <FolderRow
                folder={f}
                count={members.length}
                open={isOpen}
                renaming={renaming === f.id}
                onToggle={() => toggle(f.id)}
                onStartRename={() => setRenaming(f.id)}
                onRename={(name) => {
                  setRenaming(null);
                  if (name && name !== f.name) props.onRenameFolder(f.id, name);
                }}
                onCancelRename={() => setRenaming(null)}
                onAdd={() => pickFiles(f.id)}
                onDelete={() => props.onDeleteFolder(f.id)}
              />
              {isOpen && (
                <ul className="ml-3 border-l border-zinc-200 pl-1 dark:border-zinc-800">
                  {members.length === 0 && <li className="px-2 py-1.5 text-[11px] text-zinc-400">Drag PDFs here, or use + to add some.</li>}
                  {members.map((d) => (
                    <DocRow key={d.id} {...props} doc={d} onNewFolder={(docId) => void newFolder(docId)} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}

        {(unfiled.length > 0 || folders.length > 0) && (
          <li {...dropZone(null)} className={clsx("mt-1 min-h-8 rounded-lg", dropOn === "none" && "bg-violet-100/70 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40")}>
            {folders.length > 0 && (unfiled.length > 0 || dropOn === "none") && (
              <div className="px-2 pt-2 pb-1 text-[11px] text-zinc-400">Not in a folder</div>
            )}
            <ul>
              {unfiled.map((d) => (
                <DocRow key={d.id} {...props} doc={d} onNewFolder={(docId) => void newFolder(docId)} />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </nav>
  );
}

function FolderRow({
  folder,
  count,
  open,
  renaming,
  onToggle,
  onStartRename,
  onRename,
  onCancelRename,
  onAdd,
  onDelete,
}: {
  folder: FolderSummary;
  count: number;
  open: boolean;
  renaming: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onAdd: () => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const notes = useNoteCount({ kind: "folder", id: folder.id }, confirm);
  const Icon = open ? FolderOpen : Folder;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onToggle()}
      onDoubleClick={onStartRename}
      className="group flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-200/50 dark:text-zinc-300 dark:hover:bg-zinc-900"
    >
      <ChevronRight className={clsx("size-3.5 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
      <Icon className="size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRename(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onCancelRename();
            }}
            className="w-full rounded border border-violet-400 bg-white px-1 text-sm outline-none dark:bg-zinc-900"
          />
        ) : (
          <div className="truncate font-medium" title={`${folder.name} — double-click to rename`}>
            {folder.name}
          </div>
        )}
      </div>
      {folder.messageCount > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] text-zinc-400" title="Messages in the folder chat">
          <MessageSquare className="size-3" />
          {Math.ceil(folder.messageCount / 2)}
        </span>
      )}
      <span className="text-[11px] text-zinc-400 tabular-nums group-hover:hidden">{count}</span>
      <div className="hidden items-center group-hover:flex group-focus-within:flex">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title="Add PDFs to this folder"
        >
          <Plus className="size-3.5" />
        </button>
        {confirm ? (
          <button
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              setConfirm(false);
              onDelete();
            }}
            onBlur={() => setConfirm(false)}
            className="rounded-md bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white"
            title={`Deletes the folder, its chat${notes ? ` and its ${notes} note${notes === 1 ? "" : "s"}` : ""}. The PDFs stay in your library.`}
          >
            Delete{withNotes(notes)}
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirm(true);
            }}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-800"
            title="Delete folder (keeps the PDFs)"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function DocRow(props: Props & { doc: DocSummary; onNewFolder: (docId: string) => void }) {
  const { doc: d, folders, activeId, indexing, onSelect, onDelete, onRename, onMove, onNewFolder } = props;
  const [confirm, setConfirm] = useState(false);
  const notes = useNoteCount({ kind: "doc", id: d.id }, confirm);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const active = d.id === activeId;

  return (
    <li className="relative">
      <div
        role="button"
        tabIndex={0}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData(DOC_MIME, d.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => onSelect(d.id)}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onSelect(d.id)}
        onDoubleClick={() => setEditing(true)}
        className={clsx(
          "group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition",
          active
            ? "bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800"
            : "text-zinc-600 hover:bg-zinc-200/50 dark:text-zinc-400 dark:hover:bg-zinc-900",
        )}
      >
        <FileText className={clsx("size-4 shrink-0", active ? "text-violet-500" : "text-zinc-400")} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              defaultValue={d.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setEditing(false);
                if (e.target.value.trim() && e.target.value !== d.name) onRename(d.id, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full rounded border border-violet-400 bg-white px-1 text-sm outline-none dark:bg-zinc-900"
            />
          ) : (
            <div className="truncate font-medium" title={`${d.name} — double-click to rename, drag onto a folder to move`}>
              {d.name}
            </div>
          )}
          <div className="flex items-center gap-1 text-[11px] text-zinc-400">
            {indexing.has(d.id) && <Loader2 className="size-3 animate-spin" />}
            {indexing.has(d.id) ? "Reading pages…" : d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : "New"}
            {d.messageCount > 0 && ` · ${Math.ceil(d.messageCount / 2)} question${Math.ceil(d.messageCount / 2) === 1 ? "" : "s"}`}
          </div>
        </div>
        <div className={clsx("flex items-center", !confirm && !menu && "opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100")}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenu((m) => !m);
            }}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="Move to folder"
            aria-haspopup="menu"
            aria-expanded={menu}
          >
            <FolderInput className="size-3.5" />
          </button>
          {confirm ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(d.id);
                setConfirm(false);
              }}
              onBlur={() => setConfirm(false)}
              autoFocus
              className="rounded-md bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white"
              title={`Deletes the PDF, its chat${notes ? ` and its ${notes} note${notes === 1 ? "" : "s"}` : ""}`}
            >
              Delete{withNotes(notes)}
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirm(true);
              }}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-800"
              title="Delete"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div
            role="menu"
            className="animate-pop absolute top-full right-1 z-50 mt-1 w-52 rounded-xl border border-zinc-200 bg-white p-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="px-2 py-1 text-[11px] font-medium text-zinc-400">Move to</div>
            {folders.map((f) => (
              <MenuItem
                key={f.id}
                icon={<Folder className="size-3.5 text-amber-500" />}
                label={f.name}
                checked={d.folderId === f.id}
                onClick={() => {
                  setMenu(false);
                  if (d.folderId !== f.id) onMove(d.id, f.id);
                }}
              />
            ))}
            <MenuItem
              icon={<FileText className="size-3.5 text-zinc-400" />}
              label="No folder"
              checked={!d.folderId}
              onClick={() => {
                setMenu(false);
                if (d.folderId) onMove(d.id, null);
              }}
            />
            <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
            <MenuItem
              icon={<FolderPlus className="size-3.5 text-zinc-400" />}
              label="New folder…"
              onClick={() => {
                setMenu(false);
                onNewFolder(d.id);
              }}
            />
          </div>
        </>
      )}
    </li>
  );
}

function MenuItem({ icon, label, checked, onClick }: { icon: React.ReactNode; label: string; checked?: boolean; onClick: () => void }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={!!checked}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check className="size-3.5 text-violet-500" />}
    </button>
  );
}
