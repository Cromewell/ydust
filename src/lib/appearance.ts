/** How PDF pages are shown: original, or dark (inverted), with an optional warm tint. */
export type PdfAppearance = {
  mode: "light" | "dark";
  /** Colour temperature of the tint in Kelvin; NEUTRAL_K = no tint. */
  kelvin: number;
  /** Light mode: page brightness in percent (MIN_BRIGHTNESS…100, 100 = untouched), to tone down glaring white. */
  brightness: number;
  /** Dark mode: grey level of the page background (0 = black … 60 = dark grey). */
  darkBg: number;
};

export const NEUTRAL_K = 6500;
export const MIN_K = 2500;
export const MIN_BRIGHTNESS = 60;

export const DEFAULT_APPEARANCE: PdfAppearance = { mode: "light", kelvin: NEUTRAL_K, brightness: 100, darkBg: 28 };

export const KELVIN_PRESETS = [
  { k: 6500, label: "Neutral" },
  { k: 5600, label: "Warm" },
  { k: 4800, label: "Sepia" },
  { k: 3600, label: "Night" },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Black-body colour of a temperature (Tanner Helland's approximation), 0–255 per channel. */
function kelvinRgb(k: number): [number, number, number] {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

/** The tint multiplied over the page (white at NEUTRAL_K), or null for none. */
export function tintColor(kelvin: number): string | null {
  if (kelvin >= NEUTRAL_K) return null;
  const white = kelvinRgb(NEUTRAL_K);
  const c = kelvinRgb(clamp(kelvin, MIN_K, NEUTRAL_K)).map((v, i) => Math.round(clamp((v / white[i]) * 255, 0, 255)));
  return `rgb(${c.join(" ")})`;
}

/**
 * CSS filter for the page itself (canvas + highlights). Dark mode inverts it so that white
 * becomes the chosen dark grey and black a light grey; hue-rotate keeps colours roughly
 * their hue (red stays red-ish), so figures and highlights still make sense.
 */
export function pageFilter(a: PdfAppearance): string | undefined {
  if (a.mode === "dark") {
    const amount = 1 - clamp(a.darkBg, 0, 80) / 255;
    return `invert(${amount.toFixed(3)}) hue-rotate(180deg)`;
  }
  return a.brightness < 100 ? `brightness(${clamp(a.brightness, MIN_BRIGHTNESS, 100) / 100})` : undefined;
}

export function parseAppearance(raw: string | null): PdfAppearance {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<PdfAppearance> | null;
    if (!v || typeof v !== "object") return DEFAULT_APPEARANCE;
    const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
    return {
      mode: v.mode === "dark" ? "dark" : "light",
      kelvin: clamp(num(v.kelvin, NEUTRAL_K), MIN_K, NEUTRAL_K),
      brightness: clamp(num(v.brightness, 100), MIN_BRIGHTNESS, 100),
      darkBg: clamp(num(v.darkBg, DEFAULT_APPEARANCE.darkBg), 0, 80),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export const isDefaultAppearance = (a: PdfAppearance) => a.mode === "light" && a.kelvin >= NEUTRAL_K && a.brightness >= 100;
