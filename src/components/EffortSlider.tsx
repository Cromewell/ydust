import clsx from "clsx";
import { useRef } from "react";
import { effortLabel } from "../lib/effort";

/** Reasoning effort as a row of dots to click or drag over: "Effort (Medium) · ○ ● ○ ○ ○". */
export function EffortSlider({
  efforts,
  value,
  fallback,
  onChange,
}: {
  efforts: string[];
  /** "" = none chosen: `fallback` is used (null: whatever the model does by itself). */
  value: string;
  fallback: string | null;
  onChange: (effort: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const shown = value || fallback || "";
  const at = efforts.indexOf(shown);
  // Without a known level the knob has no place: start from the middle.
  const index = at >= 0 ? at : Math.floor((efforts.length - 1) / 2);
  const pick = (e: { currentTarget: HTMLInputElement }) => {
    const next = efforts[Number(e.currentTarget.value)];
    if (next && next !== value) onChange(next);
  };
  const left = (i: number) => `calc(0.75rem + ${i / Math.max(1, efforts.length - 1)} * (100% - 1.5rem))`;
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[13px]">
      <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-100">
        Effort <span className="text-zinc-400">({at >= 0 ? effortLabel(shown) : "Default"})</span>
      </span>
      {value && (
        <button
          type="button"
          onClick={() => {
            input.current?.focus(); // this button goes away
            onChange("");
          }}
          className="shrink-0 rounded px-1 text-[11px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          title={fallback ? `Back to the default (${effortLabel(fallback)})` : "Back to the default"}
        >
          Reset
        </button>
      )}
      <div
        className="relative h-5 shrink-0 rounded-full bg-zinc-200/80 has-focus-visible:ring-2 has-focus-visible:ring-violet-400 dark:bg-zinc-800"
        style={{ width: `${Math.max(3, efforts.length) * 1.125 + 0.375}rem` }}
        title="More thinking = slower, more tokens"
      >
        {efforts.map((e, i) => (
          <span key={e} className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-400 dark:bg-zinc-600" style={{ left: left(i) }} />
        ))}
        {at >= 0 && (
          <span
            className={clsx(
              "absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm transition-[left]",
              value ? "bg-violet-600 dark:bg-violet-400" : "bg-zinc-500 dark:bg-zinc-300",
            )}
            style={{ left: left(index) }}
          />
        )}
        <input
          ref={input}
          type="range"
          min={0}
          max={efforts.length - 1}
          step={1}
          value={index}
          onChange={pick}
          // Clicking the level the knob is on (e.g. the default) chooses it too.
          onClick={pick}
          aria-label="Effort"
          aria-valuetext={at >= 0 ? `${effortLabel(shown)}${value ? "" : " (default)"}` : "Default"}
          className="absolute inset-0 m-0 w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}
