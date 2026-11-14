import clsx from "clsx";
import { Check, Settings2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ANSWER_LANGUAGES, LEVELS, TEXT_SIZES, useDismiss, type TextSize } from "../lib/settings";

export function ChatSettings({
  language,
  textSize,
  level,
  onLanguage,
  onTextSize,
  onLevel,
}: {
  language: string;
  textSize: TextSize;
  level: string;
  onLanguage: (code: string) => void;
  onTextSize: (size: TextSize) => void;
  onLevel: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, useCallback(() => setOpen(false), []), root);
  const short = ANSWER_LANGUAGES.find((l) => l.code === language)?.short;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx("icon-btn relative w-auto min-w-8 gap-1 px-1.5", open && "bg-zinc-100 dark:bg-zinc-800")}
        title="Chat settings: answer language, text size"
      >
        <Settings2 className="size-4" />
        {short && <span className="text-[10px] font-semibold text-violet-600 dark:text-violet-400">{short}</span>}
      </button>
      {open && (
        <div className="animate-pop absolute top-full right-0 z-40 mt-1 w-[23rem] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Answer language</p>
          <div className="grid max-h-[min(22rem,55vh)] grid-cols-2 gap-1 overflow-y-auto">
            {ANSWER_LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => onLanguage(l.code)}
                className={clsx(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition",
                  l.code === "auto" && "col-span-2",
                  l.code === language
                    ? "bg-violet-50 font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {l.label}
                  {l.english && <span className="ml-1.5 text-[11px] font-normal text-zinc-400">{l.english}</span>}
                </span>
                {l.code === language && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
          </div>

          <p className="mt-4 mb-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Explanation level</p>
          <div className="grid grid-cols-5 gap-0.5 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onLevel(l.id)}
                title={l.hint}
                className={clsx(
                  "rounded-md px-1 py-1.5 text-[11px] leading-tight font-medium transition",
                  l.id === level
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-400">{LEVELS.find((l) => l.id === level)?.hint}</p>

          <p className="mt-4 mb-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Text size</p>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
            {TEXT_SIZES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTextSize(t.id)}
                title={t.label}
                className={clsx(
                  "flex h-9 items-center justify-center rounded-md font-medium transition",
                  t.id === textSize
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                )}
                style={{ fontSize: t.px }}
              >
                Aa
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
