import clsx from "clsx";
import { Monitor, Moon, RotateCcw, Sun, SunMoon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  KELVIN_PRESETS,
  MIN_BRIGHTNESS,
  MIN_K,
  NEUTRAL_K,
  isDefaultAppearance,
  pageFilter,
  tintColor,
  type AppTheme,
  type PdfAppearance,
} from "../lib/appearance";
import { useDismiss } from "../lib/settings";

/** App theme (system / light / dark) + page colours (original or dark, warmth, brightness). */
export function AppearanceMenu({
  value,
  onChange,
  theme,
  onTheme,
}: {
  value: PdfAppearance;
  onChange: (a: PdfAppearance) => void;
  theme: AppTheme;
  onTheme: (t: AppTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, useCallback(() => setOpen(false), []), root);
  const set = (patch: Partial<PdfAppearance>) => onChange({ ...value, ...patch });
  const dark = value.mode === "dark";
  const tint = tintColor(value.kelvin);
  const custom = !isDefaultAppearance(value);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx(
          "icon-btn",
          open && "bg-zinc-100 dark:bg-zinc-800",
          (custom || theme !== "system") && "text-orange-500 dark:text-orange-400",
        )}
        title="Appearance: app theme & page colours"
      >
        <SunMoon className="size-4" />
      </button>
      {open && (
        <div className="animate-pop absolute top-full right-0 z-40 mt-1 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
            <p className="mb-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">App theme</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800" role="radiogroup" aria-label="App theme">
              {(
                [
                  ["system", Monitor, "System"],
                  ["light", Sun, "Light"],
                  ["dark", Moon, "Dark"],
                ] as const
              ).map(([t, Icon, label]) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  onClick={() => onTheme(t)}
                  className={clsx(
                    "flex items-center justify-center gap-1 rounded-md py-1 text-xs font-medium transition",
                    theme === t
                      ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3 flex items-center gap-3">
            {/* Preview: the same layers as a page. */}
            <div className="relative isolate h-14 w-12 shrink-0 overflow-hidden rounded border border-zinc-200 shadow-sm dark:border-zinc-700">
              <div className="absolute inset-0 bg-white px-1.5 py-1" style={{ filter: pageFilter(value) }}>
                <div className="font-serif text-[15px] leading-tight font-semibold text-black">Aa</div>
                <div className="mt-1 h-[3px] w-full rounded bg-zinc-800" />
                <div className="mt-[3px] h-[3px] w-4/5 rounded bg-zinc-800" />
                <div className="mt-[3px] h-[3px] w-3/5 rounded bg-amber-200" />
              </div>
              {tint && <div className="absolute inset-0 mix-blend-multiply" style={{ backgroundColor: tint }} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Page colours</p>
              <p className="text-[11px] leading-snug text-zinc-500">Only how pages look here. Snapshots for the assistant keep the original colours.</p>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800" role="radiogroup" aria-label="Page mode">
            {(["light", "dark"] as const).map((m) => {
              const Icon = m === "light" ? Sun : Moon;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={value.mode === m}
                  onClick={() => set({ mode: m })}
                  className={clsx(
                    "flex items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium transition",
                    value.mode === m
                      ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
                  )}
                >
                  <Icon className="size-3.5" />
                  {m === "light" ? "Original" : "Dark"}
                </button>
              );
            })}
          </div>

          <Slider
            label="Warmth"
            display={value.kelvin >= NEUTRAL_K ? "Off" : `${value.kelvin} K`}
            min={0}
            max={NEUTRAL_K - MIN_K}
            step={100}
            value={NEUTRAL_K - value.kelvin}
            onChange={(v) => set({ kelvin: NEUTRAL_K - v })}
            track="linear-gradient(to right, #ffffff, rgb(255 214 170), rgb(255 166 87))"
          />
          <div className="mt-1.5 mb-3 grid grid-cols-4 gap-1">
            {KELVIN_PRESETS.map((p) => (
              <button
                key={p.k}
                type="button"
                onClick={() => set({ kelvin: p.k })}
                className={clsx(
                  "rounded-md px-1 py-1 text-[11px] transition",
                  value.kelvin === p.k
                    ? "bg-orange-50 font-medium text-orange-700 ring-1 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/30"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
                title={`${p.k} K`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {dark ? (
            <Slider
              label="Background"
              display={value.darkBg <= 4 ? "Black" : value.darkBg >= 45 ? "Grey" : "Dark grey"}
              min={0}
              max={60}
              step={2}
              value={value.darkBg}
              onChange={(v) => set({ darkBg: v })}
              track="linear-gradient(to right, #000, #3c3c3c)"
            />
          ) : (
            <Slider
              label="Brightness"
              display={`${value.brightness}%`}
              min={MIN_BRIGHTNESS}
              max={100}
              step={5}
              value={value.brightness}
              onChange={(v) => set({ brightness: v })}
              track="linear-gradient(to right, #999, #fff)"
            />
          )}

          <button
            type="button"
            onClick={() => onChange(DEFAULT_APPEARANCE)}
            disabled={!custom && value.darkBg === DEFAULT_APPEARANCE.darkBg}
            className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500 transition hover:text-zinc-800 disabled:opacity-40 dark:hover:text-zinc-200"
          >
            <RotateCcw className="size-3" /> Reset to original
          </button>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  display,
  min,
  max,
  step,
  value,
  onChange,
  track,
}: {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  track: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="text-zinc-500 tabular-nums">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="appearance-slider w-full"
        style={{ "--track": track } as React.CSSProperties}
      />
    </label>
  );
}
