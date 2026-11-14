import { useEffect, type RefObject } from "react";

export const ANSWER_LANGUAGES = [
  { code: "auto", label: "Same as my question", english: "", short: "" },
  { code: "en", label: "English", english: "", short: "EN" },
  { code: "de", label: "Deutsch", english: "German", short: "DE" },
  { code: "fr", label: "Français", english: "French", short: "FR" },
  { code: "es", label: "Español", english: "Spanish", short: "ES" },
  { code: "it", label: "Italiano", english: "Italian", short: "IT" },
  { code: "pt", label: "Português", english: "Portuguese", short: "PT" },
  { code: "nl", label: "Nederlands", english: "Dutch", short: "NL" },
  { code: "pl", label: "Polski", english: "Polish", short: "PL" },
  { code: "tr", label: "Türkçe", english: "Turkish", short: "TR" },
  { code: "ru", label: "Русский", english: "Russian", short: "RU" },
  { code: "uk", label: "Українська", english: "Ukrainian", short: "UK" },
  { code: "ar", label: "العربية", english: "Arabic", short: "AR" },
  { code: "zh", label: "简体中文", english: "Chinese", short: "ZH" },
  { code: "ja", label: "日本語", english: "Japanese", short: "JA" },
  { code: "ko", label: "한국어", english: "Korean", short: "KO" },
] as const;

/** How deep/technical explanations should be (sent with every question). */
export const LEVELS = [
  { id: "auto", label: "Auto", hint: "No preference" },
  { id: "beginner", label: "Beginner", hint: "Intuition, simple examples, terms explained" },
  { id: "intermediate", label: "Student", hint: "Clear and complete, not oversimplified" },
  { id: "advanced", label: "Advanced", hint: "Precise and rigorous, skips the basics" },
  { id: "exam", label: "Exam prep", hint: "What gets asked, pitfalls, practice questions" },
] as const;

export type TextSize = "s" | "m" | "l" | "xl";
export const TEXT_SIZES: { id: TextSize; label: string; px: number }[] = [
  { id: "s", label: "Small", px: 14 },
  { id: "m", label: "Medium", px: 16 },
  { id: "l", label: "Large", px: 18 },
  { id: "xl", label: "Extra large", px: 20 },
];

/** Literal class names (Tailwind only generates classes it can see in the source). */
export const SIZE_CLASSES: Record<TextSize, { prose: string; text: string; small: string }> = {
  s: { prose: "prose-sm", text: "text-sm", small: "text-xs" },
  m: { prose: "prose-base", text: "text-base", small: "text-sm" },
  l: { prose: "prose-lg", text: "text-lg", small: "text-[15px]" },
  xl: { prose: "prose-xl", text: "text-xl", small: "text-base" },
};

/** Close a popover on outside click or Escape. */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, root]);
}
