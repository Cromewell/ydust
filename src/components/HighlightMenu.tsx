import clsx from "clsx";
import { NotebookPen, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePageLabels } from "../hooks/usePageLabels";
import { HL_COLORS, type Highlight, type HlColor } from "../lib/api";
import { HL_STYLE } from "../lib/highlightColors";
import { pageLabel } from "../lib/pageLabels";
import type { Anchor } from "./NotePicker";

/** What you can do with a highlight you clicked: colour, comment, ask, note, delete. */
export function HighlightMenu({
  h,
  anchor,
  onColor,
  onComment,
  onAsk,
  onAddToNote,
  onDelete,
  onClose,
}: {
  h: Highlight;
  anchor: Anchor;
  onColor: (c: HlColor) => void;
  onComment: (comment: string) => void;
  onAsk: () => void;
  onAddToNote: (at: Anchor) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const label = pageLabel(usePageLabels().cite(), h.page);
  const [pos, setPos] = useState(anchor);
  const [comment, setComment] = useState(h.comment ?? "");
  const [confirm, setConfirm] = useState(false);
  const saveComment = () => comment.trim() !== (h.comment ?? "") && onComment(comment.trim());

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      saveComment();
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  });

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(anchor.left - r.width / 2, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(anchor.top, window.innerHeight - r.height - 8)) });
  }, [anchor]);

  const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800";
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Highlight"
      className="animate-pop fixed z-[65] w-64 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-2xl shadow-zinc-900/15 dark:border-zinc-700 dark:bg-zinc-900"
      style={pos}
    >
      <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-2" role="radiogroup" aria-label="Colour">
        {HL_COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={h.color === c}
            aria-label={HL_STYLE[c].label}
            onClick={() => onColor(c)}
            className={clsx(
              "size-5 rounded-full border border-black/10 transition hover:scale-110 dark:border-white/20",
              h.color === c && "ring-2 ring-zinc-500 ring-offset-2 ring-offset-white dark:ring-zinc-400 dark:ring-offset-zinc-900",
            )}
            style={{ backgroundColor: HL_STYLE[c].dot }}
          />
        ))}
        <span className="ml-auto text-[11px] text-zinc-400">p. {label}</span>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onBlur={saveComment}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            saveComment();
            onClose();
          }
        }}
        rows={2}
        placeholder="Comment… (e.g. definition, exam)"
        className="mb-1 w-full resize-none rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-800"
        aria-label="Comment"
      />
      <button onClick={onAsk} className={item}>
        <Sparkles className="size-3.5 text-violet-500" /> Ask about it
      </button>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onAddToNote({ left: r.left, top: r.bottom + 4 });
        }}
        className={item}
      >
        <NotebookPen className="size-3.5 text-violet-500" /> Add to note
      </button>
      {confirm ? (
        <button autoFocus onBlur={() => setConfirm(false)} onClick={onDelete} className={clsx(item, "bg-red-600 text-white hover:bg-red-500 dark:text-white dark:hover:bg-red-500")}>
          <Trash2 className="size-3.5" /> Delete this highlight
        </button>
      ) : (
        <button onClick={() => setConfirm(true)} className={clsx(item, "text-zinc-500 hover:text-red-600")}>
          <Trash2 className="size-3.5" /> Delete
        </button>
      )}
    </div>
  );
}
