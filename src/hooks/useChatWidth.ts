import { useEffect, useState } from "react";
import { store } from "../lib/storage";

const CHAT_DEFAULT = 420;
const CHAT_MIN = 300;
const VIEWER_MIN = 320;

/**
 * The chat panel's width: dragged at its left edge (double-click resets it), remembered, and
 * kept so that the PDF viewer always has room (`reserved`: the width of the sidebar, if shown).
 */
export function useChatWidth(reserved: number) {
  const [chosen, setChosen] = useState(() => Number(store.get("chatWidth")) || CHAT_DEFAULT);
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const max = Math.max(CHAT_MIN, winWidth - reserved - VIEWER_MIN);
  const width = Math.min(Math.max(chosen, CHAT_MIN), max);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let next = width;
    const onMove = (ev: PointerEvent) => {
      next = Math.min(Math.max(window.innerWidth - ev.clientX, CHAT_MIN), max);
      setChosen(next);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      setResizing(false);
      store.set("chatWidth", String(Math.round(next)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    handle.addEventListener("lostpointercapture", onUp, { once: true });
  };

  const reset = () => {
    setChosen(CHAT_DEFAULT);
    store.set("chatWidth", String(CHAT_DEFAULT));
  };

  const nudge = (delta: number) => {
    const next = Math.min(Math.max(width + delta, CHAT_MIN), max);
    setChosen(next);
    store.set("chatWidth", String(Math.round(next)));
  };

  return { width, min: CHAT_MIN, max, resizing, startResize, reset, nudge };
}
