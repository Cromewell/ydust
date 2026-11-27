import type { HlColor } from "./api";

/**
 * Highlight colours. Bars are drawn on the "paper" with multiply, like the selection, so the
 * text stays crisp. Dark pages invert the paper's lightness (keeping the hue), which turns
 * pale pastels into near-black; a warm tint swallows blue. So those get stronger colours:
 * after the filter they keep their hue, and yellow and orange stay apart.
 */
export const HL_STYLE: Record<HlColor, { bar: string; strong: string; dot: string; label: string }> = {
  yellow: { bar: "#fde68a", strong: "#facc15", dot: "#facc15", label: "Yellow" },
  green: { bar: "#bbf7d0", strong: "#86efac", dot: "#4ade80", label: "Green" },
  blue: { bar: "#bfdbfe", strong: "#93c5fd", dot: "#60a5fa", label: "Blue" },
  pink: { bar: "#fbcfe8", strong: "#f9a8d4", dot: "#f472b6", label: "Pink" },
  orange: { bar: "#fed7aa", strong: "#fb923c", dot: "#fb923c", label: "Orange" },
};

/** User-defined names per highlight colour (e.g. { green: "Definition", pink: "Exam" }). */
export type HighlightLabels = Partial<Record<HlColor, string>>;

/** The bar colour for the current page colours. */
export const barColor = (c: HlColor, opts: { dark: boolean; tinted: boolean }) => (opts.dark || opts.tinted ? HL_STYLE[c].strong : HL_STYLE[c].bar);

/** Label shown for a highlight colour: custom name if set, else the colour's name. */
export const hlLabel = (c: HlColor, labels?: HighlightLabels) => labels?.[c]?.trim() || HL_STYLE[c].label;
