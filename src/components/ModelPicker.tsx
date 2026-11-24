import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { ProviderInfo } from "../lib/api";
import { effortLabel } from "../lib/effort";
import { choose } from "../lib/models";
import { useDismiss } from "../lib/settings";
import { EffortSlider } from "./EffortSlider";

/** Custom dropdown: native <select> menus render greyed-out/unthemed on some desktops. */
export function ModelPicker({
  provider,
  value,
  onChange,
  effort: wantedEffort,
  onEffort,
}: {
  provider?: ProviderInfo;
  value: string;
  onChange: (id: string) => void;
  /** "" = the CLI's default effort. */
  effort: string;
  onEffort: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, useCallback(() => setOpen(false), []), root);

  const models = provider?.models ?? [];
  const def = provider?.defaultModel ?? null;
  const name = provider?.label ?? "the CLI";
  const { model, id, efforts, effort, defaultEffort } = choose(provider, value, wantedEffort);
  // The switch next to it already names the assistant: "Claude Opus 5.5" → "Opus 5.5" (but not "Gemini 4 …" → "4 …").
  const short = (label: string) => (provider && label.startsWith(`${provider.label} `) && /^\p{L}/u.test(label.slice(provider.label.length + 1)) ? label.slice(provider.label.length + 1) : label);
  const shownEffort = effort || defaultEffort;

  const options = [
    { id: "", label: def ? `Default: ${short(def.label)}` : "Default model", sub: `Your ${name} setting` },
    ...models.map((m) => ({ id: m.id, label: short(m.label), sub: m.description })),
  ];

  return (
    <div ref={root} className="relative ml-auto min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={clsx(
          "flex max-w-[min(16rem,100%)] min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
          open && "bg-zinc-100 dark:bg-zinc-800",
        )}
        title={model ? `${model.label}${id ? "" : " (default)"}${shownEffort ? `, effort ${effortLabel(shownEffort)}` : ""}` : "Model"}
        aria-label="Model and effort"
      >
        <span className="truncate">{model ? short(model.label) : "Default model"}</span>
        {efforts.length > 1 && shownEffort && (
          <span className={clsx("shrink-0 text-[10px]", effort ? "font-semibold text-violet-600 dark:text-violet-400" : "font-normal text-zinc-400")}>{effortLabel(shownEffort)}</span>
        )}
        <ChevronDown className={clsx("size-3.5 shrink-0 text-zinc-400 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div role="dialog" aria-label="Model and effort" className="animate-pop absolute top-full right-0 z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900">
          <ul role="listbox" aria-label="Model" className="max-h-80 overflow-y-auto p-1">
            {options.map((m) => (
              <li key={m.id || "default"} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={m.id === id}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.label}</span>
                    {m.sub && <span className="block truncate text-[11px] text-zinc-400">{m.sub}</span>}
                  </span>
                  {m.id === id && <Check className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />}
                </button>
              </li>
            ))}
          </ul>
          {efforts.length > 1 && (
            <div className="border-t border-zinc-200 p-1 dark:border-zinc-700/80">
              <EffortSlider efforts={efforts} value={effort} fallback={defaultEffort} onChange={onEffort} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
