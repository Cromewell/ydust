import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import clsx from "clsx";
import { ArrowLeft, Columns2, Download, Eye, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, NoteConflict, type NoteOwner } from "../lib/api";
import { downloadText } from "../lib/export";
import { blockInsertion, noteEditor, type OpenEditor } from "../lib/notes";
import type { TextSize } from "../lib/settings";
import { Markdown } from "./Markdown";

const SAVE_DELAY = 800;
/** From this panel width on, editor and preview fit side by side. */
const SPLIT_MIN = 680;

type View = "edit" | "preview" | "split";
type Status = "loading" | "saved" | "unsaved" | "saving" | "error";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.6" },
  ".cm-content": { padding: "12px 0 40vh" },
  ".cm-line": { padding: "0 16px" },
});

export default function NoteEditor({
  owner,
  name,
  onBack,
  onSaved,
  onJump,
  hasDoc,
  textSize,
}: {
  owner: NoteOwner;
  name: string;
  onBack: () => void;
  /** After each save (to refresh the list's sizes and titles). */
  onSaved: () => void;
  onJump: (page: number, doc?: string, label?: string) => void;
  hasDoc: (alias: string) => boolean;
  textSize: TextSize;
}) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Version on the server that the editor's content is based on (null: not created yet). */
  const version = useRef<string | null>(null);
  const savedText = useRef("");
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ content: string; version: string } | null | undefined>(undefined);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const [preview, setPreview] = useState("");
  const [wide, setWide] = useState(false);
  const [mode, setMode] = useState<View>("edit");
  const shown: View = mode === "split" && !wide ? "edit" : mode;

  const text = () => view.current?.state.doc.toString() ?? savedText.current;
  const dirty = () => text() !== savedText.current;

  const save = useCallback(
    /** `force`: save even if nothing changed here (to re-create a note deleted elsewhere). */
    async (opts: { keepalive?: boolean; force?: boolean } = {}) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (conflictRef.current !== undefined) return; // waiting for the user to decide
      if (saving.current) {
        await saving.current;
        if (dirty()) return save(opts);
        return;
      }
      if (!opts.force && !dirty()) return setStatus("saved");
      const content = text();
      setStatus("saving");
      saving.current = (async () => {
        try {
          const res = await api.saveNote(owner, name, content, version.current, opts);
          version.current = res.version;
          savedText.current = content;
          setError(null);
          setStatus(dirty() ? "unsaved" : "saved");
          onSaved();
        } catch (err) {
          if (err instanceof NoteConflict) {
            setConflict(err.current);
            setStatus("unsaved");
          } else {
            setError((err as Error).message);
            setStatus("error");
          }
        } finally {
          saving.current = null;
        }
      })();
      await saving.current;
      if (dirty() && conflictRef.current === undefined && !timer.current) timer.current = setTimeout(() => void save(), SAVE_DELAY);
    },
    [owner, name, onSaved], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  /** Replace the editor's content (loading, or taking the other version of a conflict). */
  const load = (content: string, v: string | null) => {
    version.current = v;
    savedText.current = content;
    const ed = view.current;
    if (ed && ed.state.doc.toString() !== content) {
      const head = Math.min(ed.state.selection.main.head, content.length);
      ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: content }, selection: { anchor: head } });
    }
    setPreview(content);
    setStatus("saved");
  };

  // The editor itself, once per note.
  useEffect(() => {
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    const ed = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": `Note ${name}`, spellcheck: "true" }),
          placeholder("Write in Markdown. Math: $x^2$ or $$\\int f$$. Page links: [p. 12](#page=12)"),
          keymap.of([
            { key: "Mod-s", run: () => (void saveRef.current(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          theme,
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setStatus("unsaved");
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(() => setPreview(u.state.doc.toString()), 150);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void saveRef.current(), SAVE_DELAY);
          }),
        ],
      }),
    });
    view.current = ed;
    setStatus("loading");
    let cancelled = false;
    api.getNote(owner, name).then(
      (n) => {
        if (cancelled) return;
        // Typed before it loaded? Rare, but don't lose it: the load wins only if nothing was typed.
        if (ed.state.doc.length === 0) load(n.content, n.version);
        else version.current = n.version;
        ed.focus();
      },
      (err) => !cancelled && (setError((err as Error).message), setStatus("error")),
    );

    const editor: OpenEditor = {
      owner,
      name,
      insert(block) {
        const { at, text, cursor } = blockInsertion(ed.state.doc.toString(), ed.state.selection.main.head, block);
        ed.dispatch({ changes: { from: at, insert: text }, selection: { anchor: cursor }, scrollIntoView: true });
        ed.focus();
      },
    };
    noteEditor.set(editor);

    return () => {
      cancelled = true;
      noteEditor.clear(editor);
      if (previewTimer) clearTimeout(previewTimer);
      // Leaving the note (or the panel): save what's left, after a save that may still be running
      // (it updates the version this one builds on). Taken now: the editor is gone afterwards.
      if (timer.current) clearTimeout(timer.current);
      const left = ed.state.doc.toString();
      if (left !== savedText.current && conflictRef.current === undefined) {
        void (saving.current ?? Promise.resolve())
          .then(() => (left === savedText.current ? null : api.saveNote(owner, name, left, version.current, { keepalive: true })))
          .then((res) => res && onSaved())
          .catch(() => {});
      }
      view.current = null;
      ed.destroy();
    };
  }, [owner.kind, owner.id, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the tab with unsaved text: save it, and let the browser ask.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirty() || conflictRef.current !== undefined) return;
      void saveRef.current({ keepalive: true });
      e.preventDefault();
      e.returnValue = ""; // older browsers only ask when this is set
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Edited in another editor meanwhile? When you come back and nothing is unsaved here, load it.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible" || dirty() || saving.current || conflictRef.current !== undefined) return;
      api
        .getNote(owner, name)
        .then((n) => n.version !== version.current && !dirty() && !saving.current && load(n.content, n.version))
        .catch(() => {});
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [owner.kind, owner.id, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Side by side only where it fits. Measured before the first paint, so it doesn't jump.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fits = (w: number) => {
      setWide(w >= SPLIT_MIN);
      if (w >= SPLIT_MIN) setMode((m) => (m === "edit" ? "split" : m));
    };
    fits(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fits(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (shown !== "preview") requestAnimationFrame(() => view.current?.requestMeasure());
  }, [shown]);

  const resolve = (keep: "mine" | "theirs") => {
    const c = conflict;
    if (c === undefined) return;
    setConflict(undefined);
    conflictRef.current = undefined;
    if (keep === "theirs") {
      if (c) load(c.content, c.version);
      else onBack(); // it was deleted: nothing to load
      return;
    }
    // Keep mine: save over the other version (or create the note again).
    version.current = c?.version ?? null;
    savedText.current = c?.content ?? "";
    void save({ force: !c });
  };

  const modes: { id: View; icon: typeof Eye; label: string }[] = [
    { id: "edit", icon: Pencil, label: "Edit" },
    ...(wide ? [{ id: "split" as const, icon: Columns2, label: "Side by side" }] : []),
    { id: "preview", icon: Eye, label: "Preview" },
  ];

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-100 px-2 dark:border-zinc-900">
        <button
          onClick={() => {
            void save();
            onBack();
          }}
          className="icon-btn size-7"
          title="All notes"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={`${owner.kind === "folder" ? `Folder “${owner.name}”` : owner.name} · notes/${name}`}>
          {name}
        </span>
        <span className="mr-1 flex items-center gap-1 text-[11px] text-zinc-400" aria-live="polite">
          {status === "saving" || status === "loading" ? <Loader2 className="size-3 animate-spin" /> : null}
          {status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "unsaved" ? "Edited" : status === "error" ? <span className="text-red-500">Not saved</span> : ""}
        </span>
        <div className="flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-900" role="radiogroup" aria-label="View">
          {modes.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={shown === m.id}
              onClick={() => setMode(m.id)}
              className={clsx(
                "flex size-6 items-center justify-center rounded transition",
                shown === m.id ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
              )}
              title={m.label}
            >
              <m.icon className="size-3.5" />
            </button>
          ))}
        </div>
        <button onClick={() => downloadText(name, text())} className="icon-btn size-7" title="Download this note">
          <Download className="size-3.5" />
        </button>
      </div>

      {conflict !== undefined && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="flex gap-2">
            <TriangleAlert className="size-4 shrink-0" />
            <span>
              {conflict ? "This note was changed somewhere else since you opened it." : "This note was deleted or renamed somewhere else."} Your edits
              aren't saved yet.
            </span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
            <button onClick={() => resolve("mine")} className="rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-500">
              {conflict ? "Keep mine" : "Save it again"}
            </button>
            <button onClick={() => resolve("theirs")} className="rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-500/20">
              {conflict ? "Load the other version" : "Discard mine"}
            </button>
          </div>
        </div>
      )}
      {error && status === "error" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => void save()} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={host} className={clsx("note-editor min-h-0 min-w-0 flex-1", shown === "preview" && "hidden")} />
        {shown !== "edit" && (
          <div className={clsx("min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3", shown === "split" && "border-l border-zinc-100 dark:border-zinc-900")}>
            {preview.trim() ? (
              <Markdown onJump={onJump} hasDoc={hasDoc} size={textSize}>
                {preview}
              </Markdown>
            ) : (
              <p className="text-xs text-zinc-400 italic">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
