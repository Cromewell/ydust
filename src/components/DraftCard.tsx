import clsx from "clsx";
import { Check, ChevronsUpDown, Eye, FileDiff, FilePlus2, History, Loader2, NotebookPen, Pencil, Send, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, NoteConflict, type ChatTarget, type Draft, type MessageDraft } from "../lib/api";
import { diffRows, diffStats, type Line, type Row } from "../lib/diffRows";
import { toNoteName } from "../lib/noteNames";
import { appendBlock } from "../lib/noteText";
import type { TextSize } from "../lib/settings";
import { Markdown } from "./Markdown";

const BADGE = {
  create: { label: "New", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  append: { label: "Append", cls: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  replace: { label: "Replace", cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
};

type Props = {
  chat: ChatTarget;
  d: MessageDraft;
  /** An answer is running: no decisions now. */
  busy: boolean;
  onJump: (page: number, doc?: string, label?: string) => void;
  hasDoc: (alias: string) => boolean;
  textSize: TextSize;
  onDecided: (d: MessageDraft, outcome: { accepted?: string; removed: string[] }) => void;
  onRequestChanges: (d: MessageDraft, feedback: string) => void;
  onOpenNote: (name: string) => void;
};

/** A note draft under an answer: the diff, and Accept / Request changes / Discard. */
export function DraftCard(props: Props) {
  const { d } = props;
  if (d.status === "accepted") {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-1.5 text-xs text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/5 dark:text-emerald-300">
        <Check className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Saved to <b>{d.acceptedAs ?? d.target}</b>
        </span>
        <button onClick={() => props.onOpenNote(d.acceptedAs ?? d.target)} className="font-medium underline-offset-2 hover:underline">
          Open note
        </button>
      </div>
    );
  }
  if (d.status === "discarded" || d.status === "superseded") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
        <NotebookPen className="size-3" />
        {d.status === "discarded" ? `Draft for ${d.target} discarded` : `Draft for ${d.target} (version ${d.revision}) was replaced by a newer version`}
      </p>
    );
  }
  return <OpenDraft {...props} />;
}

function OpenDraft({ chat, d, busy, onJump, hasDoc, textSize, onDecided, onRequestChanges }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gone, setGone] = useState(false);
  const [target, setTarget] = useState(d.target);
  const [current, setCurrent] = useState<{ content: string; version: string } | null>(null);
  const [view, setView] = useState<"diff" | "preview">("diff");
  const [changed, setChanged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [older, setOlder] = useState<Draft | "gone" | null>(null);
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getDraft(chat, d.id).then(
      (x) => {
        if (cancelled) return;
        setDraft(x);
        setCurrent(x.current);
      },
      () => !cancelled && setGone(true),
    );
    return () => {
      cancelled = true;
    };
  }, [chat.kind, chat.id, d.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sent elsewhere: the diff is against that note.
  const retarget = async (name: string) => {
    setTarget(name);
    setChanged(null);
    setError(null);
    setCurrent(await api.getNote(chat, name).then((n) => ({ content: n.content, version: n.version }), () => null));
  };

  const mode = d.mode;
  const content = draft?.content ?? "";
  const after = mode === "append" ? appendBlock(current?.content ?? "", content) : content;
  const rows = useMemo(() => (draft ? diffRows(mode === "create" ? "" : (current?.content ?? ""), after) : []), [draft, current, after, mode]);
  const stats = diffStats(rows);
  const exists = mode === "create" && current !== null;
  const missing = mode !== "create" && current === null && !!draft;

  const accept = async () => {
    setWorking(true);
    setError(null);
    try {
      const r = await api.acceptDraft(chat, d.id, { target: target !== d.target ? target : undefined, base: current?.version ?? null });
      onDecided(d, { accepted: r.target, removed: r.removed });
    } catch (err) {
      if (err instanceof NoteConflict) {
        setCurrent(err.current);
        setChanged(mode === "create" ? null : "The note changed since this diff was made. This is the diff against its current text: accept again if it still fits.");
        if (mode === "create") setError(`A note named “${target}” exists now. Choose another name.`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setWorking(false);
    }
  };

  const discard = async () => {
    setWorking(true);
    try {
      const r = await api.discardDraft(chat, d.id);
      onDecided(d, { removed: r.removed });
    } catch (err) {
      setError((err as Error).message);
      setWorking(false);
    }
  };

  const toggleOlder = async () => {
    setShowOlder((v) => !v);
    if (older || !d.replaces) return;
    setOlder(await api.getDraft(chat, d.replaces).catch(() => "gone" as const));
  };

  const badge = BADGE[mode];
  const Icon = mode === "create" ? FilePlus2 : FileDiff;

  if (gone) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
        <NotebookPen className="size-3" /> The draft for {d.target} no longer exists.
      </p>
    );
  }

  return (
    <section className="mt-2 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800" aria-label={`Draft for ${target}`}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <Icon className="size-4 shrink-0 text-violet-500" />
        {renaming && mode === "create" ? (
          <RenameField
            initial={target.replace(/\.md$/, "")}
            onCancel={() => setRenaming(false)}
            onDone={(name) => {
              setRenaming(false);
              void retarget(name);
            }}
          />
        ) : renaming && mode === "append" ? (
          <select
            autoFocus
            value={target}
            onChange={(e) => {
              setRenaming(false);
              void retarget(e.target.value);
            }}
            onBlur={() => setRenaming(false)}
            className="min-w-0 rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            aria-label="Add to which note"
          >
            {(notes ?? [target]).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{target}</span>
        )}
        <span className={clsx("rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase", badge.cls)}>{badge.label}</span>
        {d.revision > 1 && <span className="text-[11px] text-zinc-400">version {d.revision}</span>}
        {mode !== "replace" && !renaming && (
          <button
            onClick={() => {
              setRenaming(true);
              if (mode === "append" && !notes) void api.listNotes(chat).then((l) => setNotes(l.map((n) => n.name)), () => setNotes([target]));
            }}
            disabled={busy || working}
            className="text-zinc-400 hover:text-zinc-700 disabled:opacity-40 dark:hover:text-zinc-200"
            title={mode === "create" ? "Choose another name" : "Add it to another note"}
          >
            {mode === "create" ? <Pencil className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px]">
          {draft && (
            <span className="tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{stats.add}</span> <span className="text-red-600 dark:text-red-400">−{stats.del}</span>
            </span>
          )}
          <span className="flex rounded-md bg-zinc-200/60 p-0.5 dark:bg-zinc-800" role="radiogroup" aria-label="Show">
            {(["diff", "preview"] as const).map((v) => (
              <button
                key={v}
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                className={clsx(
                  "flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition",
                  view === v ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
                )}
              >
                {v === "diff" ? <FileDiff className="size-3" /> : <Eye className="size-3" />}
                {v === "diff" ? "Diff" : "Preview"}
              </button>
            ))}
          </span>
        </span>
        {d.summary && <p className="w-full text-xs text-zinc-500">{d.summary}</p>}
      </header>

      {changed && (
        <p className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <TriangleAlert className="size-3.5 shrink-0" /> {changed}
        </p>
      )}

      <div className="max-h-96 overflow-auto">
        {!draft ? (
          <Loader2 className="mx-auto my-4 size-4 animate-spin text-zinc-400" />
        ) : view === "diff" ? (
          <DiffView rows={rows} />
        ) : (
          <div className="px-4 py-3">
            <Markdown onJump={onJump} hasDoc={hasDoc} size={textSize}>
              {mode === "append" ? content : after}
            </Markdown>
          </div>
        )}
      </div>

      {d.replaces && (
        <div className="border-t border-zinc-100 px-3 py-1 dark:border-zinc-900">
          <button onClick={() => void toggleOlder()} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <History className="size-3" /> {showOlder ? "Hide" : "Show"} version {d.revision - 1}
          </button>
          {showOlder && (
            <div className="mt-1 max-h-60 overflow-auto rounded-md bg-zinc-50 p-2 dark:bg-zinc-900">
              {older === null ? (
                <Loader2 className="size-3.5 animate-spin text-zinc-400" />
              ) : older === "gone" ? (
                <p className="text-[11px] text-zinc-400">No longer available.</p>
              ) : (
                <pre className="font-mono text-[11px] whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{older.content}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {(error || missing || exists) && (
        <p className="border-t border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          {error ?? (missing ? `There is no note named “${target}” any more.` : `A note named “${target}” already exists. Choose another name.`)}
        </p>
      )}

      {asking ? (
        <form
          className="flex items-end gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            if (!feedback.trim()) return;
            onRequestChanges(d, feedback.trim());
            setAsking(false);
            setFeedback("");
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
              if (e.key === "Escape") setAsking(false);
            }}
            placeholder="What should change? e.g. “Make exercise 3 harder and add solutions.”"
            className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900"
            aria-label="Requested changes"
          />
          <button type="submit" disabled={!feedback.trim() || busy} className="send-btn bg-violet-600 hover:bg-violet-500" title="Send (Enter)">
            <Send className="size-4" />
          </button>
          <button type="button" onClick={() => setAsking(false)} className="icon-btn" title="Cancel">
            <X className="size-4" />
          </button>
        </form>
      ) : (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <button
            onClick={() => void accept()}
            disabled={!draft || busy || working || exists || missing}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {working ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Accept
          </button>
          <button
            onClick={() => setAsking(true)}
            disabled={!draft || busy || working}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Pencil className="size-3.5" /> Request changes
          </button>
          <button
            onClick={() => void discard()}
            disabled={busy || working}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-500/10"
          >
            <Trash2 className="size-3.5" /> Discard
          </button>
        </footer>
      )}
    </section>
  );
}

/** Unified diff, git style: line numbers, red and green lines, unchanged runs folded. */
function DiffView({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const line = (l: Line, key: string) => (
    <tr
      key={key}
      className={clsx(
        l.kind === "add" && "bg-emerald-50 dark:bg-emerald-500/10",
        l.kind === "del" && "bg-red-50 dark:bg-red-500/10",
      )}
    >
      <td className="w-8 pr-1 text-right text-zinc-400 select-none">{l.old ?? ""}</td>
      <td className="w-8 pr-1 text-right text-zinc-400 select-none">{l.new ?? ""}</td>
      <td
        className={clsx(
          "w-4 text-center select-none",
          l.kind === "add" ? "text-emerald-600 dark:text-emerald-400" : l.kind === "del" ? "text-red-600 dark:text-red-400" : "text-zinc-300",
        )}
      >
        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
      </td>
      <td className={clsx("pr-3 break-words whitespace-pre-wrap", l.kind === "del" && "text-red-900 dark:text-red-200", l.kind === "add" && "text-emerald-900 dark:text-emerald-100")}>
        {l.text || " "}
      </td>
    </tr>
  );
  if (!rows.length) return <p className="px-3 py-2 text-xs text-zinc-400 italic">No changes.</p>;
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[11.5px] leading-5">
      <colgroup>
        <col className="w-9" />
        <col className="w-9" />
        <col className="w-4" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((r, i) =>
          r.kind === "fold" ? (
            open.has(i) ? (
              r.lines.map((l, j) => line(l, `${i}.${j}`))
            ) : (
              <tr key={i}>
                <td colSpan={4} className="bg-zinc-50 py-0.5 text-center dark:bg-zinc-900">
                  <button onClick={() => setOpen((s) => new Set(s).add(i))} className="text-[11px] text-zinc-500 hover:text-violet-600">
                    ⋯ {r.lines.length} unchanged line{r.lines.length === 1 ? "" : "s"}
                  </button>
                </td>
              </tr>
            )
          ) : (
            line(r, String(i))
          ),
        )}
      </tbody>
    </table>
  );
}

function RenameField({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const name = toNoteName(value);
  return (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name) onDone(name);
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        className="min-w-0 rounded-md border border-violet-300 bg-white px-1.5 py-0.5 text-sm outline-none dark:border-violet-500/40 dark:bg-zinc-900"
        aria-label="Note name"
      />
      <span className="text-xs text-zinc-400">.md</span>
    </form>
  );
}
