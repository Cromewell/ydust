/**
 * Handwritten scratchpads (sketches) per chat: stored as vector JSON in
 * <chatDir>/sketches/<id>.json so they stay crisp at any zoom, remain editable,
 * and sync live between PC browser tabs and a paired iPad via atomic operations.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SHEET_H, SHEET_W } from "../src/lib/sketchEngine.js";
import { chatDir, withLock, writeAtomic, type ChatKind } from "./store.ts";

export { SHEET_H, SHEET_W };

export const PAPER_STYLES = ["grid", "dots", "blank"] as const;
export type PaperStyle = (typeof PAPER_STYLES)[number];

/** [x, y, pressure] in logical sheet coordinates (0..SHEET_W, 0..SHEET_H, 0..1). */
export type StrokePoint = [number, number, number];

export type Stroke = {
  id: string;
  color: string;
  width: number;
  tool?: "pen" | "eraser";
  points: StrokePoint[];
};

export type SketchPage = {
  id: string;
  strokes: Stroke[];
};

export type Sketch = {
  id: string;
  title: string;
  paper: PaperStyle;
  pages: SketchPage[];
  createdAt: string;
  updatedAt: string;
};

export type SketchInfo = {
  id: string;
  title: string;
  paper: PaperStyle;
  pageCount: number;
  strokeCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Atomic, idempotent operations so concurrent PC + iPad drawing/undo never clobber each other. */
export type SketchOp =
  | { type: "add-strokes"; pageId: string; strokes: Stroke[] }
  | { type: "remove-strokes"; pageId: string; strokeIds: string[] }
  | { type: "add-page"; page: SketchPage }
  | { type: "clear-page"; pageId: string }
  | { type: "set-paper"; paper: PaperStyle };

export const MAX_SKETCHES = 100;
export const MAX_PAGES = 30;
export const MAX_STROKES_PER_PAGE = 4_000;
export const MAX_POINTS_PER_STROKE = 10_000;
export const MAX_SKETCH_BYTES = 5_000_000;

export class SketchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413,
  ) {
    super(message);
  }
}

export type SketchEvent =
  | { type: "op"; kind: ChatKind; chatId: string; sketchId: string; op: SketchOp; source?: string }
  | { type: "sync"; kind: ChatKind; chatId: string; sketch: Sketch; source?: string }
  | { type: "pad-clients"; count: number }
  | { type: "pad-stopped" };

export type PadActionPayload = {
  actionId: string;
  kind: ChatKind;
  chatId: string;
  sketchId: string;
  action: "attach" | "check" | "latex";
  pageId: string;
  pageIndex: number;
  imageId: string;
  label: string;
};

/** Live events shared between the main server (PC browser) and the LAN pad server (iPad). */
export const sketchBus = new EventEmitter();
sketchBus.setMaxListeners(50);

/** Active PC SSE listeners per chat (`kind:chatId`) so iPad actions are delivered to exactly one tab (or rejected with 409). */
type PcListener = { id: string; sendAction: (payload: PadActionPayload) => void };
const pcListeners = new Map<string, PcListener[]>();

/** Hook set by app.ts so pad.ts can reject "Check Proof" with 409 while the tutor is already answering. */
let busyCheck: (kind: ChatKind, chatId: string) => boolean = () => false;

export function setChatBusyCheck(fn: (kind: ChatKind, chatId: string) => boolean) {
  busyCheck = fn;
}

export function isChatBusy(kind: ChatKind, chatId: string): boolean {
  return busyCheck(kind, chatId);
}

export function registerPcListener(kind: ChatKind, chatId: string, sendAction: (payload: PadActionPayload) => void): () => void {
  const key = `${kind}:${chatId}`;
  const entry: PcListener = { id: randomUUID(), sendAction };
  const list = pcListeners.get(key) ?? [];
  list.push(entry);
  pcListeners.set(key, list);
  return () => {
    const cur = pcListeners.get(key);
    if (!cur) return;
    const next = cur.filter((x) => x.id !== entry.id);
    if (next.length) pcListeners.set(key, next);
    else pcListeners.delete(key);
  };
}

export function hasPcListener(kind: ChatKind, chatId: string): boolean {
  const list = pcListeners.get(`${kind}:${chatId}`);
  return !!list && list.length > 0;
}

/** Deliver an iPad action to the most recently active PC tab for this chat; returns false if none is open. */
export function dispatchPadAction(payload: PadActionPayload): boolean {
  const list = pcListeners.get(`${payload.kind}:${payload.chatId}`);
  if (!list || !list.length) return false;
  // Send to exactly one tab (the newest / most recently opened) to avoid duplicate runs.
  list[list.length - 1].sendAction(payload);
  return true;
}

const ID_RE = /^[0-9a-f-]{36}$/;
const PAGE_ID_RE = /^[0-9a-zA-Z_-]{1,64}$/;
export const sketchesDir = (kind: ChatKind, id: string) => path.join(chatDir(kind, id), "sketches");
const fileOf = (dir: string, sid: string) => {
  if (!ID_RE.test(sid)) throw new SketchError("Sketch not found.", 404);
  return path.join(dir, `${sid}.json`);
};
const lockKey = (dir: string) => `sketches:${dir}`;

export const summarizeSketch = (s: Sketch): SketchInfo => ({
  id: s.id,
  title: s.title,
  paper: s.paper,
  pageCount: s.pages.length,
  strokeCount: s.pages.reduce((n, p) => n + p.strokes.length, 0),
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function cleanStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64 ? r.id : randomUUID();
  const color = typeof r.color === "string" && COLOR_RE.test(r.color) ? r.color : "#18181b";
  const width = typeof r.width === "number" && Number.isFinite(r.width) ? Math.min(80, Math.max(0.5, r.width)) : 3;
  const tool = r.tool === "eraser" ? "eraser" : "pen";
  if (!Array.isArray(r.points) || !r.points.length || r.points.length > MAX_POINTS_PER_STROKE) return null;
  const points: StrokePoint[] = [];
  for (const pt of r.points) {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    const p = pt.length >= 3 ? Number(pt[2]) : 0.5;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p)) return null;
    points.push([
      Math.round(Math.min(SHEET_W + 200, Math.max(-200, x)) * 10) / 10,
      Math.round(Math.min(SHEET_H + 200, Math.max(-200, y)) * 10) / 10,
      Math.round(Math.min(1, Math.max(0.05, p)) * 100) / 100,
    ]);
  }
  return { id, color, width, tool, points };
}

async function readSketchFile(dir: string, sid: string): Promise<Sketch | null> {
  try {
    return JSON.parse(await readFile(fileOf(dir, sid), "utf8")) as Sketch;
  } catch (err) {
    if (err instanceof SketchError) throw err;
    return null;
  }
}

async function persistSketch(dir: string, cur: Sketch) {
  cur.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(cur);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SKETCH_BYTES) throw new SketchError("Scratchpad is too large.", 413);
  await writeAtomic(fileOf(dir, cur.id), serialized);
}

export async function listSketches(kind: ChatKind, id: string, opts: { ensureDefault?: boolean } = {}): Promise<SketchInfo[]> {
  const dir = sketchesDir(kind, id);
  const readAll = async () => {
    const files = await readdir(dir).catch(() => [] as string[]);
    const all = await Promise.all(files.filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => readSketchFile(dir, f.slice(0, -5))));
    return all
      .filter((s): s is Sketch => s !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeSketch);
  };
  if (!opts.ensureDefault) return readAll();
  // Create a single default "Sheet 1" atomically under lock so React StrictMode or two tabs never create duplicates.
  return withLock(lockKey(dir), async () => {
    const existing = await readAll();
    if (existing.length) return existing;
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const sketch: Sketch = {
      id: randomUUID(),
      title: "Sheet 1",
      paper: "grid",
      pages: [{ id: randomUUID(), strokes: [] }],
      createdAt: now,
      updatedAt: now,
    };
    await writeAtomic(fileOf(dir, sketch.id), JSON.stringify(sketch));
    return [summarizeSketch(sketch)];
  });
}

export async function readSketch(kind: ChatKind, id: string, sid: string): Promise<Sketch> {
  const s = await readSketchFile(sketchesDir(kind, id), sid);
  if (!s) throw new SketchError("Sketch not found.", 404);
  return s;
}

export async function createSketch(kind: ChatKind, id: string, body: { title?: unknown; paper?: unknown } = {}): Promise<Sketch> {
  const dir = sketchesDir(kind, id);
  const paper: PaperStyle = typeof body.paper === "string" && PAPER_STYLES.includes(body.paper as PaperStyle) ? (body.paper as PaperStyle) : "grid";
  return withLock(lockKey(dir), async () => {
    await mkdir(dir, { recursive: true });
    const existing = await readdir(dir).catch(() => [] as string[]);
    const count = existing.filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).length;
    if (count >= MAX_SKETCHES) throw new SketchError(`A chat can have at most ${MAX_SKETCHES} scratchpads.`, 400);
    const title = (typeof body.title === "string" ? body.title.trim().slice(0, 120) : "") || `Sheet ${count + 1}`;
    const now = new Date().toISOString();
    const sketch: Sketch = {
      id: randomUUID(),
      title,
      paper,
      pages: [{ id: randomUUID(), strokes: [] }],
      createdAt: now,
      updatedAt: now,
    };
    await writeAtomic(fileOf(dir, sketch.id), JSON.stringify(sketch));
    return sketch;
  });
}

/** Apply an atomic operation (`add-strokes`, `remove-strokes`, `add-page`, `clear-page`, `set-paper`) under lock. */
export async function applyOp(kind: ChatKind, id: string, sid: string, rawOp: Record<string, unknown>, source?: string): Promise<SketchOp> {
  const type = rawOp.type;
  const dir = sketchesDir(kind, id);
  return withLock(lockKey(dir), async () => {
    const cur = await readSketchFile(dir, sid);
    if (!cur) throw new SketchError("Sketch not found.", 404);

    const findPage = (pageId: unknown, pageIndex?: unknown): SketchPage => {
      if (typeof pageId === "string" && pageId) {
        const p = cur.pages.find((x) => x.id === pageId);
        if (!p) throw new SketchError("Page not found.", 404);
        return p;
      }
      if (typeof pageIndex === "number" && Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < cur.pages.length) {
        return cur.pages[pageIndex];
      }
      throw new SketchError("Page not found.", 404);
    };

    let op: SketchOp;
    if (type === "add-strokes") {
      const page = findPage(rawOp.pageId, rawOp.pageIndex);
      const rawList = Array.isArray(rawOp.strokes) ? rawOp.strokes : rawOp.stroke ? [rawOp.stroke] : [];
      if (!rawList.length || rawList.length > MAX_STROKES_PER_PAGE) throw new SketchError("Invalid strokes.", 400);
      const strokes: Stroke[] = [];
      for (const s of rawList) {
        const cleaned = cleanStroke(s);
        if (!cleaned) throw new SketchError("Invalid stroke.", 400);
        strokes.push(cleaned);
      }
      const have = new Set(page.strokes.map((s) => s.id));
      const fresh = strokes.filter((s) => !have.has(s.id));
      if (page.strokes.length + fresh.length > MAX_STROKES_PER_PAGE) {
        throw new SketchError(`A page can have at most ${MAX_STROKES_PER_PAGE} strokes.`, 400);
      }
      page.strokes.push(...fresh);
      op = { type: "add-strokes", pageId: page.id, strokes: fresh };
    } else if (type === "remove-strokes") {
      const page = findPage(rawOp.pageId, rawOp.pageIndex);
      if (!Array.isArray(rawOp.strokeIds) || rawOp.strokeIds.some((x) => typeof x !== "string")) {
        throw new SketchError("`strokeIds` must be an array of strings.", 400);
      }
      const gone = new Set(rawOp.strokeIds as string[]);
      page.strokes = page.strokes.filter((s) => !gone.has(s.id));
      op = { type: "remove-strokes", pageId: page.id, strokeIds: [...gone] };
    } else if (type === "add-page") {
      const pid = typeof rawOp.pageId === "string" && PAGE_ID_RE.test(rawOp.pageId) ? rawOp.pageId : randomUUID();
      let page = cur.pages.find((p) => p.id === pid);
      if (!page) {
        if (cur.pages.length >= MAX_PAGES) throw new SketchError(`A scratchpad can have at most ${MAX_PAGES} pages.`, 400);
        page = { id: pid, strokes: [] };
        cur.pages.push(page);
      }
      op = { type: "add-page", page };
    } else if (type === "clear-page") {
      const page = findPage(rawOp.pageId, rawOp.pageIndex);
      page.strokes = [];
      op = { type: "clear-page", pageId: page.id };
    } else if (type === "set-paper") {
      if (typeof rawOp.paper !== "string" || !PAPER_STYLES.includes(rawOp.paper as PaperStyle)) {
        throw new SketchError("Invalid paper style.", 400);
      }
      cur.paper = rawOp.paper as PaperStyle;
      op = { type: "set-paper", paper: cur.paper };
    } else {
      throw new SketchError("Unknown sketch operation.", 400);
    }

    await persistSketch(dir, cur);
    sketchBus.emit("event", { type: "op", kind, chatId: id, sketchId: sid, op, source } satisfies SketchEvent);
    return op;
  });
}

export async function deleteSketch(kind: ChatKind, id: string, sid: string): Promise<void> {
  const dir = sketchesDir(kind, id);
  return withLock(lockKey(dir), async () => {
    const cur = await readSketchFile(dir, sid);
    if (!cur) throw new SketchError("Sketch not found.", 404);
    await rm(fileOf(dir, sid), { force: true });
  });
}

export const clearSketches = (kind: ChatKind, id: string) => rm(sketchesDir(kind, id), { recursive: true, force: true });
