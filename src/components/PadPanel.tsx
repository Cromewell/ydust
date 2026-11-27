import clsx from "clsx";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eraser,
  FileCode2,
  GraduationCap,
  Grid2x2,
  Paperclip,
  Plus,
  QrCode,
  Redo2,
  Tablet,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ChatTarget,
  type PadActionEvent,
  type PadPairingStatus,
  type PaperStyle,
  type Sketch,
  type SketchInfo,
  type SketchOp,
  type Stroke,
  type StrokePoint,
} from "../lib/api";
import { encodeQr, qrSvgPath } from "../lib/qr";
import {
  SHEET_H,
  SHEET_W,
  applySketchOp,
  drawPaper,
  drawStroke,
  renderInkToCanvas,
  renderPageToBlob,
  renderPageToDataUrl,
  strokeHitsSegment,
} from "../lib/sketchCanvas";

const PEN_COLORS = [
  { hex: "#18181b", name: "Black" },
  { hex: "#2563eb", name: "Blue" },
  { hex: "#dc2626", name: "Red" },
  { hex: "#059669", name: "Green" },
  { hex: "#7c3aed", name: "Violet" },
];
const PEN_WIDTHS = [2, 4, 8];
const PAPER_CYCLE: PaperStyle[] = ["grid", "dots", "blank"];
const MAX_HISTORY = 50;

type EraserMode = "stroke" | "pixel";
type HistoryEntry = { undo: SketchOp; redo: SketchOp };

type Props = {
  chat: ChatTarget;
  visible: boolean;
  onAttachSheet: (blob: Blob, label: string) => void;
  onCheckSheet: (blob: Blob, label: string) => void;
  onConvertLatex: (images: string[], title: string) => void;
  onPadAction: (ev: PadActionEvent) => void;
  onFlash: (msg: string) => void;
};

export function PadPanel({ chat, visible, onAttachSheet, onCheckSheet, onConvertLatex, onPadAction, onFlash }: Props) {
  const [list, setList] = useState<SketchInfo[]>([]);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [pageId, setPageId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const [color, setColor] = useState("#18181b");
  const [width, setWidth] = useState(4);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [eraserMode, setEraserMode] = useState<EraserMode>("stroke");
  const [undoMap, setUndoMap] = useState<Record<string, HistoryEntry[]>>({});
  const [redoMap, setRedoMap] = useState<Record<string, HistoryEntry[]>>({});

  const [pairing, setPairing] = useState<PadPairingStatus>({ active: false, interfaces: [] });
  const [showQr, setShowQr] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [ipadClients, setIpadClients] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const paperCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const sketchRef = useRef<Sketch | null>(null);
  sketchRef.current = sketch;
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  const onPadActionRef = useRef(onPadAction);
  onPadActionRef.current = onPadAction;

  const activeStroke = useRef<Stroke | null>(null);
  const activePointer = useRef<number | null>(null);
  const strokeErasing = useRef<{ prev: StrokePoint; pageId: string; removed: Stroke[] } | null>(null);

  // Stable per-tab client id so two open PC tabs receive each other's live ops.
  const clientId = useMemo(() => crypto.randomUUID(), []);

  // Offline / transient-failure retry queue for outgoing atomic ops
  const opQueueRef = useRef<{ sketchId: string; op: SketchOp }[]>([]);
  const flushingRef = useRef(false);

  const pushHistory = useCallback((pid: string, undo: SketchOp, redo: SketchOp) => {
    setUndoMap((m) => ({ ...m, [pid]: [...(m[pid] ?? []), { undo, redo }].slice(-MAX_HISTORY) }));
    setRedoMap((m) => (m[pid]?.length ? { ...m, [pid]: [] } : m));
  }, []);

  const reloadCurrentSketch = useCallback(async () => {
    const sid = sketchRef.current?.id;
    if (!sid) return;
    try {
      const fresh = await api.getSketch(chat, sid);
      let merged = fresh;
      for (const item of opQueueRef.current) {
        if (item.sketchId === sid) merged = applySketchOp(merged, item.op);
      }
      setSketch(merged);
      setPageId((cur) => (merged.pages.some((p) => p.id === cur) ? cur : (merged.pages[0]?.id ?? "")));
    } catch {
      /* ignore transient reconnect error */
    }
  }, [chat]);

  const flushQueue = useCallback(async () => {
    if (flushingRef.current || !opQueueRef.current.length) return;
    flushingRef.current = true;
    try {
      while (opQueueRef.current.length) {
        const next = opQueueRef.current[0];
        try {
          await api.applySketchOp(chat, next.sketchId, next.op, clientId);
          opQueueRef.current.shift();
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            // Permanent client error: drop this op, reload server state, and keep flushing remaining ops.
            opQueueRef.current.shift();
            onFlash(`Scratchpad sync rejected: ${e.message}`);
            await reloadCurrentSketch();
            continue;
          }
          onFlash(`Could not sync scratchpad change: ${(e as Error).message}`);
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [chat, clientId, onFlash, reloadCurrentSketch]);

  const enqueueOp = useCallback(
    (sid: string, op: SketchOp) => {
      setSketch((cur) => {
        if (!cur || cur.id !== sid) return cur;
        const next = applySketchOp(cur, op);
        sketchRef.current = next;
        return next;
      });
      opQueueRef.current.push({ sketchId: sid, op });
      void flushQueue();
    },
    [flushQueue],
  );

  const loadListAndOpen = useCallback(async () => {
    setLoading(true);
    try {
      // Server creates "Sheet 1" atomically under lock if empty (no duplicates under StrictMode / 2 tabs).
      const items = await api.listSketches(chat, { ensure: true });
      setList(items);
      if (items.length) {
        const full = await api.getSketch(chat, items[0].id);
        setSketch(full);
        setPageId(full.pages[0]?.id ?? "");
      }
    } catch (e) {
      onFlash(`Could not load scratchpad: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [chat, onFlash]);

  useEffect(() => {
    setSketch(null);
    setPageId("");
    setUndoMap({});
    setRedoMap({});
    setConfirmDelete(false);
    opQueueRef.current = [];
    void loadListAndOpen();
    api
      .padStatus()
      .then((st) => {
        setPairing(st);
        setIpadClients(st.active && st.kind === chat.kind && st.chatId === chat.id ? st.clients : 0);
      })
      .catch(() => {});
  }, [chat.kind, chat.id, loadListAndOpen]);

  // Retry queued ops periodically and resync when returning to tab
  useEffect(() => {
    const timer = setInterval(() => {
      if (opQueueRef.current.length) void flushQueue();
    }, 4000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void flushQueue().then(() => reloadCurrentSketch());
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flushQueue, reloadCurrentSketch]);

  // Live SSE sync from server (atomic ops, full syncs, single-delivered iPad actions, client count, idle stop).
  useEffect(() => {
    let connectedOnce = false;
    const es = new EventSource(api.sketchesEventsUrl(chat, clientId));
    es.addEventListener("open", () => {
      if (connectedOnce) {
        void flushQueue().then(() => reloadCurrentSketch());
      }
      connectedOnce = true;
    });
    es.addEventListener("op", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { sketchId: string; op: SketchOp };
        setSketch((cur) => {
          if (!cur || cur.id !== d.sketchId) return cur;
          return applySketchOp(cur, d.op);
        });
      } catch {
        /* ignore malformed event */
      }
    });
    es.addEventListener("sync", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { sketch: Sketch };
        setSketch((cur) => {
          if (!cur || cur.id !== d.sketch.id) return cur;
          let merged = d.sketch;
          for (const item of opQueueRef.current) {
            if (item.sketchId === d.sketch.id) merged = applySketchOp(merged, item.op);
          }
          return merged;
        });
        setPageId((cur) => (d.sketch.pages.some((p) => p.id === cur) ? cur : (d.sketch.pages[0]?.id ?? "")));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("pad-clients", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { count: number };
        setIpadClients(d.count);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("pad-stopped", () => {
      setIpadClients(0);
      setShowQr(false);
      api
        .padStatus()
        .then(setPairing)
        .catch(() => setPairing({ active: false, interfaces: [] }));
    });
    es.addEventListener("pad-action", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as PadActionEvent;
        onPadActionRef.current(d);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [chat.kind, chat.id, clientId, flushQueue, reloadCurrentSketch]);

  const pageIndex = useMemo(() => {
    if (!sketch || !sketch.pages.length) return 0;
    const idx = sketch.pages.findIndex((p) => p.id === pageId);
    return idx === -1 ? 0 : idx;
  }, [sketch, pageId]);

  const currentPage = sketch?.pages[pageIndex] ?? null;

  // Redraw paper layer whenever paper style or visibility changes.
  useEffect(() => {
    const c = paperCanvasRef.current;
    const s = sketch;
    if (!c || !s) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawPaper(ctx, s.paper);
  }, [sketch?.paper, visible]);

  // Redraw transparent ink layer whenever strokes, page, or visibility changes.
  const redrawInk = useCallback(() => {
    const c = inkCanvasRef.current;
    const s = sketchRef.current;
    if (!c || !s) return;
    const page = s.pages.find((p) => p.id === pageIdRef.current) ?? s.pages[0];
    if (!page) return;
    renderInkToCanvas(c, page.strokes, activeStroke.current);
  }, []);

  useEffect(() => {
    redrawInk();
  }, [sketch, pageIndex, visible, redrawInk]);

  const toSheetPoint = (e: PointerEvent): StrokePoint => {
    const c = inkCanvasRef.current!;
    const r = c.getBoundingClientRect();
    const x = Math.round((((e.clientX - r.left) / r.width) * SHEET_W) * 10) / 10;
    const y = Math.round((((e.clientY - r.top) / r.height) * SHEET_H) * 10) / 10;
    const p = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return [x, y, Math.round(Math.min(1, Math.max(0.05, p)) * 100) / 100];
  };

  const eraseStrokesAlong = (p0: StrokePoint, p1: StrokePoint) => {
    const s = sketchRef.current;
    const se = strokeErasing.current;
    if (!s || !se) return;
    const curPage = s.pages.find((p) => p.id === se.pageId);
    if (!curPage) return;
    const radius = Math.max(12, width * 2.5);
    const hit: Stroke[] = [];
    const remaining: Stroke[] = [];
    for (const st of curPage.strokes) {
      if (strokeHitsSegment(st, p0[0], p0[1], p1[0], p1[1], radius)) hit.push(st);
      else remaining.push(st);
    }
    if (!hit.length) return;
    se.removed.push(...hit);
    const next: Sketch = {
      ...s,
      pages: s.pages.map((p) => (p.id === se.pageId ? { ...p, strokes: remaining } : p)),
    };
    sketchRef.current = next;
    setSketch(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!sketch || !currentPage || (e.button !== 0 && e.pointerType === "mouse")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    const pt = toSheetPoint(e.nativeEvent);

    if (tool === "eraser" && eraserMode === "stroke") {
      strokeErasing.current = { prev: pt, pageId: currentPage.id, removed: [] };
      eraseStrokesAlong(pt, pt);
      return;
    }

    const stroke: Stroke = {
      id: crypto.randomUUID(),
      color: tool === "eraser" ? "#000000" : color,
      width: tool === "eraser" ? width * 5 : width,
      tool,
      points: [pt],
    };
    activeStroke.current = stroke;
    const ctx = inkCanvasRef.current?.getContext("2d");
    if (ctx) drawStroke(ctx, stroke);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== e.pointerId) return;
    e.preventDefault();
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];

    if (strokeErasing.current) {
      for (const ev of events) {
        const pt = toSheetPoint(ev);
        eraseStrokesAlong(strokeErasing.current.prev, pt);
        strokeErasing.current.prev = pt;
      }
      return;
    }

    if (!activeStroke.current) return;
    const ctx = inkCanvasRef.current?.getContext("2d");
    const st = activeStroke.current;
    for (const ev of events) {
      const pt = toSheetPoint(ev);
      const prev = st.points[st.points.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) < 1.2) continue;
      st.points.push(pt);
      if (ctx) drawStroke(ctx, { ...st, points: [prev, pt] });
    }
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== e.pointerId || !sketchRef.current) return;
    activePointer.current = null;
    const cur = sketchRef.current;

    if (strokeErasing.current) {
      const se = strokeErasing.current;
      strokeErasing.current = null;
      if (se.removed.length) {
        const redoOp: SketchOp = { type: "remove-strokes", pageId: se.pageId, strokeIds: se.removed.map((s) => s.id) };
        const undoOp: SketchOp = { type: "add-strokes", pageId: se.pageId, strokes: se.removed };
        pushHistory(se.pageId, undoOp, redoOp);
        enqueueOp(cur.id, redoOp);
      }
      return;
    }

    if (!activeStroke.current) return;
    const finished = activeStroke.current;
    activeStroke.current = null;
    const pid = cur.pages.find((p) => p.id === pageIdRef.current)?.id ?? cur.pages[0]?.id;
    if (!pid) return;
    const addOp: SketchOp = { type: "add-strokes", pageId: pid, strokes: [finished] };
    const undoOp: SketchOp = { type: "remove-strokes", pageId: pid, strokeIds: [finished.id] };
    pushHistory(pid, undoOp, addOp);
    enqueueOp(cur.id, addOp);
  };

  const undoStack = currentPage ? (undoMap[currentPage.id] ?? []) : [];
  const redoStack = currentPage ? (redoMap[currentPage.id] ?? []) : [];

  const undo = () => {
    if (!sketch || !currentPage || !undoStack.length) return;
    const entry = undoStack[undoStack.length - 1];
    setUndoMap((m) => ({ ...m, [currentPage.id]: undoStack.slice(0, -1) }));
    setRedoMap((m) => ({ ...m, [currentPage.id]: [...(m[currentPage.id] ?? []), entry].slice(-MAX_HISTORY) }));
    enqueueOp(sketch.id, entry.undo);
  };

  const redo = () => {
    if (!sketch || !currentPage || !redoStack.length) return;
    const entry = redoStack[redoStack.length - 1];
    setRedoMap((m) => ({ ...m, [currentPage.id]: redoStack.slice(0, -1) }));
    setUndoMap((m) => ({ ...m, [currentPage.id]: [...(m[currentPage.id] ?? []), entry].slice(-MAX_HISTORY) }));
    enqueueOp(sketch.id, entry.redo);
  };

  const clearPage = () => {
    if (!sketch || !currentPage || !currentPage.strokes.length) return;
    const snapshot = currentPage.strokes.slice();
    const clearOp: SketchOp = { type: "clear-page", pageId: currentPage.id };
    const undoOp: SketchOp = { type: "add-strokes", pageId: currentPage.id, strokes: snapshot };
    pushHistory(currentPage.id, undoOp, clearOp);
    enqueueOp(sketch.id, clearOp);
  };

  const cyclePaper = () => {
    if (!sketch) return;
    const nextPaper = PAPER_CYCLE[(PAPER_CYCLE.indexOf(sketch.paper) + 1) % PAPER_CYCLE.length];
    enqueueOp(sketch.id, { type: "set-paper", paper: nextPaper });
  };

  const addPage = () => {
    if (!sketch) return;
    const newId = crypto.randomUUID();
    setPageId(newId);
    enqueueOp(sketch.id, { type: "add-page", pageId: newId, page: { id: newId, strokes: [] } });
  };

  const switchSheet = async (sid: string) => {
    try {
      await flushQueue();
      const full = await api.getSketch(chat, sid);
      setSketch(full);
      setPageId(full.pages[0]?.id ?? "");
      setConfirmDelete(false);
      // If an iPad is paired to THIS chat, re-target it to the newly selected sheet (keeps token).
      if (pairing.active && pairing.kind === chat.kind && pairing.chatId === chat.id) {
        const st = await api.startPad({ kind: chat.kind, chatId: chat.id, sketchId: full.id, host: pairing.bindHost });
        setPairing(st);
      }
    } catch (e) {
      onFlash(`Could not open sheet: ${(e as Error).message}`);
    }
  };

  const newSheet = async () => {
    try {
      await flushQueue();
      const created = await api.createSketch(chat, { paper: sketch?.paper ?? "grid" });
      setList((prev) => [
        {
          id: created.id,
          title: created.title,
          paper: created.paper,
          pageCount: created.pages.length,
          strokeCount: 0,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        ...prev,
      ]);
      setSketch(created);
      setPageId(created.pages[0]?.id ?? "");
      if (pairing.active && pairing.kind === chat.kind && pairing.chatId === chat.id) {
        const st = await api.startPad({ kind: chat.kind, chatId: chat.id, sketchId: created.id, host: pairing.bindHost });
        setPairing(st);
      }
    } catch (e) {
      onFlash(`Could not create sheet: ${(e as Error).message}`);
    }
  };

  const removeSheet = async () => {
    if (!sketch) return;
    try {
      await api.deleteSketch(chat, sketch.id);
      const rest = list.filter((x) => x.id !== sketch.id);
      setConfirmDelete(false);
      if (rest.length) {
        setList(rest);
        const full = await api.getSketch(chat, rest[0].id);
        setSketch(full);
        setPageId(full.pages[0]?.id ?? "");
      } else {
        await loadListAndOpen();
      }
    } catch (e) {
      onFlash(`Could not delete sheet: ${(e as Error).message}`);
    }
  };

  const openPairing = async (host?: string) => {
    if (!sketch) return;
    try {
      const st = await api.startPad({ kind: chat.kind, chatId: chat.id, sketchId: sketch.id, host });
      setPairing(st);
      setIpadClients(st.active ? st.clients : 0);
      setShowQr(true);
    } catch (e) {
      onFlash(`Could not start iPad pairing: ${(e as Error).message}`);
    }
  };

  const stopPairing = async () => {
    try {
      const st = await api.stopPad();
      setPairing(st);
      setIpadClients(0);
      setShowQr(false);
    } catch (e) {
      onFlash(`Could not stop pairing: ${(e as Error).message}`);
    }
  };

  const activeUrl = pairing.active ? (pairing.url ?? pairing.urls?.[0]?.url ?? "") : "";
  const activeInterfaces = pairing.interfaces ?? [];
  const activeBindHost = pairing.active ? (pairing.bindHost ?? pairing.urls?.[0]?.ip ?? "LAN") : "";
  const qr = useMemo(() => {
    if (!activeUrl) return null;
    try {
      const m = encodeQr(activeUrl);
      return { size: m.size + 8, d: qrSvgPath(m, 4) };
    } catch {
      return null;
    }
  }, [activeUrl]);

  const copyPairingUrl = async () => {
    if (!activeUrl) return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const handleAttach = async () => {
    if (!sketch || !currentPage) return;
    try {
      const blob = await renderPageToBlob(currentPage, sketch.paper, 1);
      onAttachSheet(blob, `${sketch.title} · p. ${pageIndex + 1}`);
    } catch (e) {
      onFlash((e as Error).message);
    }
  };

  const handleCheck = async () => {
    if (!sketch || !currentPage) return;
    try {
      const blob = await renderPageToBlob(currentPage, sketch.paper, 1);
      onCheckSheet(blob, `${sketch.title} · p. ${pageIndex + 1}`);
    } catch (e) {
      onFlash((e as Error).message);
    }
  };

  const handleLatex = () => {
    if (!sketch || !currentPage) return;
    const nonEmpty = sketch.pages.filter((p) => p.strokes.length > 0);
    const targets = nonEmpty.length ? nonEmpty.slice(0, 10) : [currentPage];
    const images = targets.map((p) => renderPageToDataUrl(p, sketch.paper, 1));
    onConvertLatex(images, sketch.title);
  };

  const pairedHere = pairing.active && pairing.kind === chat.kind && pairing.chatId === chat.id;

  return (
    <div hidden={!visible} className="flex min-h-0 flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
      {/* Sheet selector + Pair iPad */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <select
          value={sketch?.id ?? ""}
          onChange={(e) => void switchSheet(e.target.value)}
          disabled={loading || !list.length}
          aria-label="Scratchpad sheet"
          className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-800 outline-none focus:border-violet-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
        >
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button onClick={() => void newSheet()} className="icon-btn size-7" title="New sheet">
          <Plus className="size-3.5" />
        </button>
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button onClick={() => void removeSheet()} className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-500">
              Delete
            </button>
            <button onClick={() => setConfirmDelete(false)} className="icon-btn size-7" title="Cancel">
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} disabled={!sketch} className="icon-btn size-7" title="Delete sheet">
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          onClick={() => (showQr && pairedHere ? setShowQr(false) : void openPairing())}
          disabled={!sketch}
          className={clsx(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition",
            pairedHere && ipadClients > 0
              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
              : pairedHere
                ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
          )}
          title="Connect an iPad or tablet on the same Wi-Fi / Tailscale network"
        >
          {pairedHere && ipadClients > 0 ? <Tablet className="size-3.5" /> : <QrCode className="size-3.5" />}
          <span>{pairedHere && ipadClients > 0 ? `iPad (${ipadClients})` : "Pair iPad"}</span>
        </button>
      </div>

      {/* Expandable QR Pairing Card */}
      {showQr && pairedHere && pairing.active && (
        <div className="shrink-0 border-b border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900/70">
          <div className="flex items-start gap-3">
            {qr ? (
              <div className="shrink-0 rounded-xl border border-zinc-200 bg-white p-2 shadow-xs">
                <svg viewBox={`0 0 ${qr.size} ${qr.size}`} className="size-28" shapeRendering="crispEdges" role="img" aria-label="iPad pairing QR code">
                  <rect width={qr.size} height={qr.size} fill="#ffffff" />
                  <path d={qr.d} fill="#09090b" />
                </svg>
              </div>
            ) : (
              <div className="flex size-28 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-center text-[11px] text-zinc-500">
                No LAN IP detected
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">Scan with your iPad Camera</span>
                <button onClick={() => setShowQr(false)} className="icon-btn size-6" title="Hide QR">
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Bound to <code className="font-mono">{activeBindHost}:{pairing.port}</code> (auto-stops after 30 min idle). Use Tailscale on untrusted Wi-Fi.
              </p>
              {activeInterfaces.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={activeBindHost}
                    onChange={(e) => void openPairing(e.target.value)}
                    aria-label="Network interface"
                    className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    {activeInterfaces.map((iface) => (
                      <option key={iface.ip} value={iface.ip}>
                        {iface.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void copyPairingUrl()}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {copiedUrl ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
                    {copiedUrl ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between pt-0.5">
                <span className={clsx("text-[11px] font-medium", ipadClients > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400")}>
                  {ipadClients > 0 ? `● ${ipadClients} iPad connected` : "○ Waiting for iPad…"}
                </span>
                <button
                  onClick={() => void stopPairing()}
                  className="text-[11px] font-medium text-red-600 hover:underline dark:text-red-400"
                >
                  Stop pairing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drawing Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-1">
          {PEN_COLORS.map((c) => (
            <button
              key={c.hex}
              onClick={() => {
                setColor(c.hex);
                setTool("pen");
              }}
              aria-label={`${c.name} pen`}
              title={c.name}
              className={clsx(
                "size-5 rounded-full border border-black/15 transition",
                tool === "pen" && color === c.hex && "ring-2 ring-violet-500 ring-offset-1 dark:ring-offset-zinc-950",
              )}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>

        <span className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        <div className="flex items-center gap-0.5">
          {PEN_WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => setWidth(w)}
              title={`Stroke width ${w}`}
              className={clsx(
                "flex size-6 items-center justify-center rounded-md transition",
                width === w ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
              )}
            >
              <span className="rounded-full bg-current" style={{ width: w + 3, height: w + 3 }} />
            </button>
          ))}
        </div>

        <button
          onClick={() => setTool((t) => (t === "eraser" ? "pen" : "eraser"))}
          className={clsx(
            "icon-btn size-7",
            tool === "eraser" && "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
          )}
          title={eraserMode === "stroke" ? "Eraser (whole strokes)" : "Eraser (pixel / partial)"}
        >
          <Eraser className="size-3.5" />
        </button>

        {tool === "eraser" && (
          <div className="flex items-center rounded-md border border-zinc-200 p-0.5 text-[10px] font-medium dark:border-zinc-700">
            {(["stroke", "pixel"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setEraserMode(m)}
                className={clsx(
                  "rounded px-1.5 py-0.5 transition",
                  eraserMode === m
                    ? "bg-violet-600 text-white"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                )}
                title={m === "stroke" ? "Erase whole strokes on touch" : "Erase parts of strokes without erasing paper lines"}
              >
                {m === "stroke" ? "Stroke" : "Pixel"}
              </button>
            ))}
          </div>
        )}

        <span className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        <button onClick={undo} disabled={!undoStack.length} className="icon-btn size-7" title="Undo (your changes)">
          <Undo2 className="size-3.5" />
        </button>
        <button onClick={redo} disabled={!redoStack.length} className="icon-btn size-7" title="Redo">
          <Redo2 className="size-3.5" />
        </button>
        <button onClick={cyclePaper} disabled={!sketch} className="icon-btn size-7" title={`Paper: ${sketch?.paper ?? "grid"} (click to cycle)`}>
          <Grid2x2 className="size-3.5" />
        </button>
        <button onClick={clearPage} disabled={!currentPage?.strokes.length} className="ml-auto text-[11px] font-medium text-zinc-500 hover:text-red-600 disabled:opacity-30 dark:text-zinc-400">
          Clear
        </button>
      </div>

      {/* Two-layer Canvas Stage: paper background underneath, transparent ink layer on top */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="relative mx-auto aspect-[3/4] w-full max-w-[680px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800">
          <canvas ref={paperCanvasRef} width={SHEET_W} height={SHEET_H} className="pointer-events-none absolute inset-0 size-full" />
          <canvas
            ref={inkCanvasRef}
            width={SHEET_W}
            height={SHEET_H}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            className="absolute inset-0 size-full touch-none select-none"
          />
        </div>
      </div>

      {/* Footer: Pages + Tutor & LaTeX Actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => sketch && pageIndex > 0 && setPageId(sketch.pages[pageIndex - 1].id)}
            disabled={pageIndex <= 0}
            className="icon-btn size-7"
            title="Previous page"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="min-w-10 text-center text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
            {sketch ? `${pageIndex + 1} / ${sketch.pages.length}` : "—"}
          </span>
          <button
            onClick={() => sketch && pageIndex < sketch.pages.length - 1 && setPageId(sketch.pages[pageIndex + 1].id)}
            disabled={!sketch || pageIndex >= sketch.pages.length - 1}
            className="icon-btn size-7"
            title="Next page"
          >
            <ChevronRight className="size-3.5" />
          </button>
          <button onClick={addPage} disabled={!sketch} className="icon-btn size-7" title="Add new page">
            <Plus className="size-3.5" />
          </button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => void handleAttach()}
            disabled={!sketch}
            className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            title="Attach this sheet to the chat composer"
          >
            <Paperclip className="size-3.5" />
            Attach
          </button>
          <button
            onClick={() => void handleCheck()}
            disabled={!sketch}
            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            title="Ask the AI tutor to check your handwritten proof / derivation"
          >
            <GraduationCap className="size-3.5" />
            Check
          </button>
          <button
            onClick={handleLatex}
            disabled={!sketch}
            className="flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            title="Convert handwriting to standalone LaTeX (.tex) and compile to PDF"
          >
            <FileCode2 className="size-3.5" />
            LaTeX / PDF
          </button>
        </div>
      </div>
    </div>
  );
}
