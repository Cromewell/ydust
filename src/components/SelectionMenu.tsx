import { BookOpenText, ChevronDown, GraduationCap, HelpCircle, ListChecks, NotebookPen, PenLine, Quote, Sparkles } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import type { Anchor } from "./NotePicker";
import type { PdfSelection } from "./PdfViewer";

export const QUICK_ACTIONS = [
  {
    id: "explain",
    label: "Explain",
    icon: BookOpenText,
    prompt: "Explain this passage in simple terms: what does it say, what do the key terms mean, and why does it matter here?",
  },
  {
    id: "summarize",
    label: "Summarize",
    icon: ListChecks,
    prompt: "Summarize this passage in a few concise bullet points.",
  },
  {
    id: "quiz",
    label: "Quiz me",
    icon: HelpCircle,
    prompt:
      "Write 3 short questions that test whether I understood this passage. List the questions first, then put the answers at the very end under a heading “Answers”.",
  },
] as const;

/** Ask the assistant to draft something into a note (it proposes; the user reviews the diff). */
export const NOTE_ACTIONS = [
  {
    id: "summary",
    label: "Summarize to note",
    icon: ListChecks,
    prompt:
      "Summarize this passage for my notes: the key points, definitions and formulas, with page links. Put it into the fitting note with write_note (add to an existing note if one fits).",
  },
  {
    id: "exercises",
    label: "Write exercises",
    icon: PenLine,
    prompt:
      "Write 3 to 5 exercises on this passage for my notes, from easy to harder, with short solutions at the end under a heading “Solutions”. Put them into a note with write_note (add to an existing exercises note if one fits).",
  },
] as const;

export function SelectionMenu(props: Parameters<typeof Menu>[0]) {
  // Remount per selection, so the notes submenu starts closed.
  return <Menu key={`${props.selection.page}:${props.selection.text.length}:${props.selection.end.left}`} {...props} />;
}

function Menu({
  selection,
  onAsk,
  onAction,
  onCheck,
  onAddToNote,
  openNote,
}: {
  selection: PdfSelection;
  onAsk: () => void;
  onAction: (prompt: string) => void;
  /** "Check my understanding": explain the passage in your own words. */
  onCheck: () => void;
  /** Quote the passage in a note (a picker opens at `at`, unless a note is open). */
  onAddToNote: (at: Anchor) => void;
  /** Name of the note open in the editor: the passage goes straight there. */
  openNote: string | null;
}) {
  const [noteMenu, setNoteMenu] = useState(false);
  // Show the menu where the user finished: below the end of a forward selection,
  // above the end of a backward one; flip if there's no room.
  const { end, backward } = selection;
  const MENU_H = 44;
  const fitsAbove = end.top - MENU_H - 8 >= 0;
  const fitsBelow = end.bottom + MENU_H + 8 <= window.innerHeight;
  const above = backward ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
  const left = Math.min(Math.max(end.left, 280), window.innerWidth - 280);
  // Clamp so the menu stays on screen even when neither side has room.
  const top = above ? Math.max(MENU_H + 8, end.top - 8) : Math.min(window.innerHeight - MENU_H - 8, end.bottom + 8);

  return (
    <div
      role="toolbar"
      aria-label="Ask about selection"
      // Keep the text selection alive when clicking the menu.
      onMouseDown={(e) => e.preventDefault()}
      className="animate-pop fixed z-50 flex items-center gap-0.5 rounded-xl whitespace-nowrap border border-zinc-200/80 bg-white/95 p-1 shadow-xl shadow-zinc-900/10 backdrop-blur dark:border-zinc-700/80 dark:bg-zinc-900/95"
      style={{ left, top, transform: `translate(-50%, ${above ? "-100%" : "0"})` }}
    >
      <button
        type="button"
        onClick={onAsk}
        className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-500"
        title="Ask a question about the selection (Ctrl+K)"
      >
        <Sparkles className="size-3.5" />
        Ask
      </button>
      <button
        type="button"
        onClick={onCheck}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        title="Explain it in your own words, the assistant checks it"
      >
        <GraduationCap className="size-3.5 text-emerald-500" />
        Check me
      </button>
      {QUICK_ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onAction(a.prompt)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <a.icon className="size-3.5 text-zinc-400" />
          {a.label}
        </button>
      ))}
      <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <div className="relative">
        <button
          type="button"
          onClick={() => setNoteMenu((v) => !v)}
          aria-expanded={noteMenu}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          title="Quote this passage in a note, or let the assistant draft a summary or exercises"
        >
          <NotebookPen className="size-3.5 text-violet-500" />
          Notes
          <ChevronDown className="size-3 text-zinc-400" />
        </button>
        {noteMenu && (
          <div
            role="menu"
            className={clsx(
              "animate-pop absolute right-0 z-10 flex w-56 flex-col rounded-xl border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900",
              above ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onAddToNote({ left: r.left, top: above ? r.top - 8 - 240 : r.bottom + 8 });
              }}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              title={openNote ? `Quote this passage in ${openNote}, at the cursor` : "Quote this passage in one of your notes"}
            >
              <Quote className="size-3.5 text-violet-500" />
              <span className="min-w-0 flex-1 truncate">{openNote ? `Add to ${openNote}` : "Add to note"}</span>
            </button>
            {NOTE_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => onAction(a.prompt)}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                title="The assistant drafts it; you see a diff and decide"
              >
                <a.icon className="size-3.5 text-zinc-400" />
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
