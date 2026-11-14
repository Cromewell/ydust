import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { ProviderInfo } from "../lib/api";
import { useDismiss } from "../lib/settings";

/** Custom dropdown: native <select> menus render greyed-out/unthemed on some desktops. */
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max" };

export function ModelPicker({
  provider,
  value,
  onChange,
  effort,
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
  const current = models.find((m) => m.id === value);
  // The switch next to it already names the CLI: "Claude Opus 5.5" → "Opus 5.5".
  const short = (label: string) => (provider && label.startsWith(`${provider.label} `) ? label.slice(provider.label.length + 1) : label);
  const buttonLabel = short(current ? current.label : (def?.label ?? "Default model"));
  const isDefault = !current && !!def;

  const options = [
    {
      id: "",
      label: def ? `Default: ${def.label}` : "Default model",
      sub: def?.detail ? `${def.detail} · your ${name} setting` : `Whatever ${name} is configured to use`,
    },
    ...models.map((m) => ({ id: m.id, label: m.label, sub: m.detail && m.detail !== m.id ? `${m.detail} · alias "${m.id}"` : m.id })),
  ];

  return (
    <div ref={root} className="relative ml-auto min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          "flex max-w-[min(14rem,100%)] min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
          open && "bg-zinc-100 dark:bg-zinc-800",
        )}
        title={current?.detail ?? def?.detail ?? "Model"}
        aria-label="Model"
      >
        <span className="truncate">{buttonLabel}</span>
        {isDefault && !effort && <span className="shrink-0 text-[10px] font-normal text-zinc-400">default</span>}
        {effort && <span className="shrink-0 text-[10px] font-semibold text-violet-600 dark:text-violet-400">{EFFORT_LABEL[effort] ?? effort}</span>}
        <ChevronDown className={clsx("size-3.5 shrink-0 text-zinc-400 transition", open && "rotate-180")} />
      </button>
      {open && (
        <ul
          role="listbox"
          className="animate-pop absolute top-full right-0 z-40 mt-1 max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
        >
          {options.map((m) => (
            <li key={m.id || "default"}>
              <button
                type="button"
                role="option"
                aria-selected={m.id === value}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-800 transition hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.label}</span>
                  <span className="block truncate font-mono text-[10.5px] text-zinc-400">{m.sub}</span>
                </span>
                {m.id === value && <Check className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />}
              </button>
            </li>
          ))}
          {!!provider?.efforts.length && (
            <li className="mt-1 border-t border-zinc-200 px-1.5 pt-2.5 pb-1.5 dark:border-zinc-700/80">
              <div className="mb-1.5 flex items-baseline justify-between px-1">
                <span className="text-[11px] font-medium tracking-wide text-zinc-400 uppercase">Effort</span>
                <span className="text-[10.5px] text-zinc-400">more thinking = slower, more tokens</span>
              </div>
              <div role="radiogroup" aria-label="Effort" className="grid grid-cols-6 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
                {["", ...provider.efforts].map((e) => (
                  <button
                    key={e || "default"}
                    type="button"
                    role="radio"
                    aria-checked={e === effort}
                    onClick={() => onEffort(e)}
                    title={e ? `--effort ${e}` : `Your ${name} setting${provider.defaultEffort ? ` (${provider.defaultEffort})` : ""}`}
                    className={clsx(
                      "rounded-md px-1 py-1 text-[11px] font-medium transition",
                      e === effort
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                    )}
                  >
                    {e ? EFFORT_LABEL[e] ?? e : "Auto"}
                  </button>
                ))}
              </div>
              {!effort && provider.defaultEffort && (
                <p className="mt-1.5 px-1 text-[10.5px] text-zinc-400">Auto = your {name} setting: {provider.defaultEffort}</p>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
