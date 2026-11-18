import { useCallback, useEffect, useState } from "react";
import type { HighlightClick, PdfSelection } from "../components/PdfViewer";
import { api, HL_COLORS, type Highlight, type HlColor } from "../lib/api";
import { store } from "../lib/storage";

const byPage = (a: Highlight, b: Highlight) => a.page - b.page || a.createdAt.localeCompare(b.createdAt);

/**
 * The coloured highlights of the open PDF, the colour used last (ringed in the menu), and the
 * menu of a clicked highlight. Changes show at once and are saved; `flash` reports failures.
 */
export function useHighlights(docId: string | null, flash: (msg: string) => void) {
  const [list, setList] = useState<Highlight[]>([]);
  const [color, setColorState] = useState<HlColor>(() => {
    const c = store.get("hlColor");
    return HL_COLORS.includes(c as HlColor) ? (c as HlColor) : "yellow";
  });
  const [menu, setMenu] = useState<HighlightClick | null>(null);
  const setColor = useCallback((c: HlColor) => {
    setColorState(c);
    store.set("hlColor", c);
  }, []);

  useEffect(() => {
    setList([]);
    setMenu(null);
    if (!docId) return;
    let cancelled = false;
    api.listHighlights(docId).then((l) => !cancelled && setList(l), () => {});
    return () => {
      cancelled = true;
    };
  }, [docId]);

  /** Mark a selection in a colour (and remember the colour). */
  const add = useCallback(
    async (sel: PdfSelection, c: HlColor) => {
      if (!docId) return;
      setColor(c);
      try {
        const h = await api.addHighlight(docId, { page: sel.page, text: sel.text, occurrence: sel.occurrence, color: c });
        setList((l) => [...l, h].sort(byPage));
      } catch (e) {
        flash(`Could not highlight: ${(e as Error).message}`);
      }
    },
    [docId, flash, setColor],
  );

  const change = useCallback(
    async (id: string, patch: { color?: HlColor; comment?: string }) => {
      if (!docId) return;
      setList((l) => l.map((h) => (h.id === id ? { ...h, ...patch, comment: patch.comment === undefined ? h.comment : patch.comment || undefined } : h)));
      if (patch.color) setColor(patch.color);
      await api.patchHighlight(docId, id, patch).catch((e) => flash(`Could not save: ${(e as Error).message}`));
    },
    [docId, flash, setColor],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!docId) return;
      setMenu(null);
      setList((l) => l.filter((h) => h.id !== id));
      await api.removeHighlight(docId, id).catch((e) => flash(`Could not delete: ${(e as Error).message}`));
    },
    [docId, flash],
  );

  return { list, color, menu, setMenu, add, change, remove };
}
