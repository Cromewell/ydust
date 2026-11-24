import clsx from "clsx";
import { Asterisk, Sparkles } from "lucide-react";
import type { ProviderInfo } from "../lib/api";

export const PROVIDER_ICON: Record<string, { icon: typeof Sparkles; color: string }> = {
  agy: { icon: Sparkles, color: "text-violet-500" },
  claude: { icon: Asterisk, color: "text-orange-500" },
};

/** Segmented control to choose which CLI answers. */
export function ProviderSwitch({
  providers,
  value,
  disabled,
  onChange,
}: {
  providers: ProviderInfo[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Assistant" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/80">
      {providers.map((p) => {
        const { icon: Icon, color } = PROVIDER_ICON[p.id] ?? PROVIDER_ICON.agy;
        const active = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!p.available || disabled}
            onClick={() => onChange(p.id)}
            aria-label={p.label}
            title={
              !p.available
                ? `${p.label} needs ${p.cli}, which was not found on this computer`
                : disabled
                  ? "Wait until the current answer is finished"
                  : `Ask ${p.label}`
            }
            className={clsx(
              "flex items-center gap-1 rounded-md py-1 text-xs font-semibold transition disabled:cursor-not-allowed",
              active ? "px-2" : "px-1.5",
              active
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-800 disabled:opacity-40 disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
          >
            <Icon className={clsx("size-3.5", active ? color : "text-current")} />
            {/* Only the active one is spelled out, to leave room for the model name. */}
            {active && p.label}
          </button>
        );
      })}
    </div>
  );
}
