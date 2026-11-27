/**
 * Isolated LAN Pad Server for iPad / tablet handwriting pairing.
 *
 * The main ydust API stays strictly on 127.0.0.1. Only when the user explicitly
 * clicks "Pair iPad" do we open this separate HTTP listener bound to the single
 * chosen network interface IP (not 0.0.0.0), gated by a 192-bit random token
 * that rotates whenever the paired chat changes and auto-stops after 30 minutes
 * without a connected iPad.
 *
 * Security model:
 *  - Transport is plain local HTTP (intended for trusted home Wi-Fi; use
 *    Tailscale/WireGuard on untrusted networks).
 *  - A paired iPad can read/update only the single paired scratchpad and push a
 *    rendered PNG to the open PC tab ("Attach", "Check Proof", "→ LaTeX" — the
 *    latter two trigger the same read-only tutor/LaTeX CLI turn as clicking on
 *    the PC, but require an open PC tab on that chat).
 *  - It can NEVER browse the library, read/delete documents or notes, or run
 *    arbitrary commands.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  MAX_SKETCH_BYTES,
  SketchError,
  applyOp,
  dispatchPadAction,
  hasPcListener,
  isChatBusy,
  readSketch,
  sketchBus,
  type SketchEvent,
} from "./sketches.ts";
import { chatDir, saveImage, type ChatKind } from "./store.ts";

const ENGINE_JS = readFileSync(fileURLToPath(new URL("../src/lib/sketchEngine.js", import.meta.url)), "utf8");
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export type LanInterface = { ip: string; label: string };
export type LanAddress = { ip: string; label: string; url: string };

export type PadPairingStatus =
  | { active: false; interfaces: LanInterface[] }
  | {
      active: true;
      port: number;
      bindHost: string;
      token: string;
      kind: ChatKind;
      chatId: string;
      sketchId: string;
      chatName: string;
      clients: number;
      url: string;
      interfaces: LanInterface[];
      urls: LanAddress[];
    };

type ActivePairing = {
  server: ServerType;
  port: number;
  bindHost: string;
  token: string;
  kind: ChatKind;
  chatId: string;
  sketchId: string;
  chatName: string;
  clients: number;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

let active: ActivePairing | null = null;

const sameToken = (a: string | undefined, b: string) => {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Non-loopback IPv4 interfaces on this machine, sorted with private LAN and Tailscale first. */
export function localInterfaces(): LanInterface[] {
  const nets = networkInterfaces();
  const list: (LanInterface & { rank: number })[] = [];
  for (const [iface, entries] of Object.entries(nets)) {
    for (const e of entries ?? []) {
      if (e.family !== "IPv4" || e.internal) continue;
      const ip = e.address;
      const isTailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /tailscale|ts/i.test(iface);
      const isPrivate = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      const isDocker = /^(docker|br-|veth|virbr|podman|cni)/i.test(iface);
      const rank = isDocker ? 3 : isPrivate ? 0 : isTailscale ? 1 : 2;
      const tag = isTailscale ? "Tailscale" : isDocker ? iface : isPrivate ? `LAN (${iface})` : iface;
      list.push({ ip, label: `${tag} · ${ip}`, rank });
    }
  }
  return list
    .sort((a, b) => a.rank - b.rank || a.ip.localeCompare(b.ip))
    .map(({ ip, label }) => ({ ip, label }));
}

export function lanAddresses(port: number, token: string): LanAddress[] {
  return localInterfaces().map((x) => ({
    ...x,
    url: `http://${x.ip}:${port}/pad?token=${token}`,
  }));
}

function scheduleIdleShutdown() {
  if (!active) return;
  if (active.idleTimer) {
    clearTimeout(active.idleTimer);
    active.idleTimer = null;
  }
  if (active.clients > 0 || active.idleTimeoutMs <= 0) return;
  const target = active;
  active.idleTimer = setTimeout(() => {
    if (active === target && active.clients === 0) {
      void stopPadServer();
    }
  }, active.idleTimeoutMs);
  active.idleTimer.unref?.();
}

export function padStatus(): PadPairingStatus {
  const interfaces = localInterfaces();
  if (!active) return { active: false, interfaces };
  const url = `http://${active.bindHost}:${active.port}/pad?token=${active.token}`;
  const urls: LanAddress[] = [{ ip: active.bindHost, label: interfaces.find((x) => x.ip === active!.bindHost)?.label ?? active.bindHost, url }];
  return {
    active: true,
    port: active.port,
    bindHost: active.bindHost,
    token: active.token,
    kind: active.kind,
    chatId: active.chatId,
    sketchId: active.sketchId,
    chatName: active.chatName,
    clients: active.clients,
    url,
    interfaces,
    urls,
  };
}

function createPadApp() {
  const pad = new Hono();

  pad.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  });

  const requireToken = (c: Context) => {
    if (!active) return false;
    const tok = c.req.header("x-pad-token") ?? c.req.query("token");
    return sameToken(tok, active.token);
  };

  pad.get("/pad", (c) => {
    if (!requireToken(c)) {
      return c.html(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:2rem;text-align:center;color:#444"><h2>Pairing link expired</h2><p>Scan the new QR code in ydust on your computer.</p></body>`,
        403,
      );
    }
    scheduleIdleShutdown();
    return c.html(padHtml(active!.token, active!.chatName));
  });

  pad.get("/pad/engine.js", (c) => {
    if (!requireToken(c)) return c.text("unauthorized", 403);
    return new Response(ENGINE_JS, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  pad.use("/pad/api/*", async (c, next) => {
    if (!requireToken(c)) return c.json({ error: "unauthorized" }, 403);
    scheduleIdleShutdown();
    await next();
  });

  pad.get("/pad/api/sketch", async (c) => {
    if (!active) return c.json({ error: "not paired" }, 404);
    try {
      const sketch = await readSketch(active.kind, active.chatId, active.sketchId);
      return c.json({ sketch, chatName: active.chatName });
    } catch (err) {
      if (err instanceof SketchError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  pad.post("/pad/api/op", bodyLimit({ maxSize: MAX_SKETCH_BYTES + 1024 * 1024 }), async (c) => {
    if (!active) return c.json({ error: "not paired" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid request" }, 400);
    try {
      const op = await applyOp(active.kind, active.chatId, active.sketchId, body, "ipad");
      return c.json({ ok: true, op });
    } catch (err) {
      if (err instanceof SketchError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  pad.post("/pad/api/action", bodyLimit({ maxSize: 16 * 1024 * 1024 }), async (c) => {
    if (!active) return c.json({ error: "not paired" }, 404);
    const body = await c.req.json<{ action?: unknown; pageId?: unknown; pageIndex?: unknown; png?: unknown }>().catch(() => null);
    if (!body || (body.action !== "attach" && body.action !== "check" && body.action !== "latex") || typeof body.png !== "string") {
      return c.json({ error: "invalid request" }, 400);
    }
    // Check preconditions BEFORE saving the PNG to disk so rejected requests leave no orphan images.
    if (!hasPcListener(active.kind, active.chatId)) {
      return c.json({ error: "Open this chat in ydust on your PC first." }, 409);
    }
    if (body.action === "check" && isChatBusy(active.kind, active.chatId)) {
      return c.json({ error: "The tutor is still answering — wait a moment and try again." }, 409);
    }
    const b64 = body.png.replace(/^data:image\/png;base64,/, "");
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (bytes.byteLength < 64 || bytes.byteLength > 15 * 1024 * 1024) return c.json({ error: "invalid image" }, 400);
    const sketch = await readSketch(active.kind, active.chatId, active.sketchId).catch(() => null);
    let pageIndex = 0;
    let pageId = "";
    if (sketch) {
      if (typeof body.pageId === "string") {
        const idx = sketch.pages.findIndex((p) => p.id === body.pageId);
        if (idx !== -1) {
          pageIndex = idx;
          pageId = body.pageId;
        }
      }
      if (!pageId && typeof body.pageIndex === "number" && Number.isInteger(body.pageIndex) && body.pageIndex >= 0 && body.pageIndex < sketch.pages.length) {
        pageIndex = body.pageIndex;
        pageId = sketch.pages[pageIndex].id;
      }
      if (!pageId && sketch.pages[0]) pageId = sketch.pages[0].id;
    }
    const imageId = await saveImage(chatDir(active.kind, active.chatId), bytes);
    if (!imageId) return c.json({ error: "expected PNG image" }, 415);
    const label = `${sketch?.title ?? "Pad"} · p. ${pageIndex + 1}`;
    const delivered = dispatchPadAction({
      actionId: randomUUID(),
      kind: active.kind,
      chatId: active.chatId,
      sketchId: active.sketchId,
      action: body.action,
      pageId,
      pageIndex,
      imageId,
      label,
    });
    if (!delivered) {
      return c.json({ error: "Open this chat in ydust on your PC first." }, 409);
    }
    return c.json({ ok: true, imageId, delivered: true });
  });

  pad.get("/pad/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const session = active;
      if (!session) return;
      session.clients++;
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      sketchBus.emit("event", { type: "pad-clients", count: session.clients } satisfies SketchEvent);
      let chain = Promise.resolve();
      const send = (event: string, data: unknown) =>
        (chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));
      const onEvent = (e: SketchEvent) => {
        if (active !== session) return;
        if (e.type === "op" && e.source !== "ipad" && e.kind === session.kind && e.chatId === session.chatId && e.sketchId === session.sketchId) {
          void send("op", { op: e.op });
        } else if (e.type === "sync" && e.source !== "ipad" && e.kind === session.kind && e.chatId === session.chatId && e.sketch.id === session.sketchId) {
          void send("sync", { sketch: e.sketch, chatName: session.chatName });
        } else if (e.type === "pad-stopped") {
          void send("pad-stopped", {});
        }
      };
      sketchBus.on("event", onEvent);
      const ping = setInterval(() => void send("ping", {}), 20_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(ping);
      sketchBus.off("event", onEvent);
      session.clients = Math.max(0, session.clients - 1);
      if (active === session) {
        sketchBus.emit("event", { type: "pad-clients", count: session.clients } satisfies SketchEvent);
        scheduleIdleShutdown();
      }
    });
  });

  return pad;
}

function listenOn(app: Hono, hostname: string, port: number): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    let srv: ServerType;
    try {
      srv = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => resolve({ server: srv, port: info.port }));
      srv.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

function pickBindHost(requested?: string): string {
  const ifaces = localInterfaces();
  if (requested) {
    if (requested === "127.0.0.1" || ifaces.some((x) => x.ip === requested)) return requested;
  }
  return ifaces[0]?.ip ?? "127.0.0.1";
}

/**
 * Start (or re-target) the isolated LAN iPad pairing server for this scratchpad.
 * - Switching to a DIFFERENT chat or network interface rotates the token and closes old connections.
 * - Switching sheets within the SAME chat keeps the active pairing and syncs the new sheet.
 */
export async function startPadServer(opts: {
  kind: ChatKind;
  chatId: string;
  sketchId: string;
  chatName: string;
  host?: string;
  idleTimeoutMs?: number;
}): Promise<PadPairingStatus> {
  const targetHost = pickBindHost(opts.host ?? active?.bindHost);
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  if (active) {
    const sameChat = active.kind === opts.kind && active.chatId === opts.chatId;
    const sameHost = active.bindHost === targetHost;
    if (sameChat && sameHost) {
      active.sketchId = opts.sketchId;
      active.chatName = opts.chatName;
      active.idleTimeoutMs = idleTimeoutMs;
      scheduleIdleShutdown();
      const sketch = await readSketch(opts.kind, opts.chatId, opts.sketchId).catch(() => null);
      if (sketch) sketchBus.emit("event", { type: "sync", kind: opts.kind, chatId: opts.chatId, sketch, source: "pc" } satisfies SketchEvent);
      return padStatus();
    }
    // Different chat or different interface: tear down old server and mint a fresh token.
    await stopPadServer({ silent: true });
  }

  const padApp = createPadApp();
  const preferred = Number(process.env.YDUST_PAD_PORT ?? 8788);
  let bound: { server: ServerType; port: number };
  try {
    bound = await listenOn(padApp, targetHost, preferred);
  } catch {
    bound = await listenOn(padApp, targetHost, 0);
  }
  active = {
    server: bound.server,
    port: bound.port,
    bindHost: targetHost,
    token: randomBytes(24).toString("hex"),
    kind: opts.kind,
    chatId: opts.chatId,
    sketchId: opts.sketchId,
    chatName: opts.chatName,
    clients: 0,
    idleTimeoutMs,
    idleTimer: null,
  };
  scheduleIdleShutdown();
  return padStatus();
}

export async function stopPadServer(opts: { silent?: boolean } = {}): Promise<void> {
  if (!active) return;
  const cur = active;
  if (!opts.silent) {
    // Notify any connected iPad SSE clients before closing the socket.
    sketchBus.emit("event", { type: "pad-stopped" } satisfies SketchEvent);
  }
  active = null;
  if (cur.idleTimer) {
    clearTimeout(cur.idleTimer);
    cur.idleTimer = null;
  }
  sketchBus.emit("event", { type: "pad-clients", count: 0 } satisfies SketchEvent);
  const srv = cur.server as ServerType & { closeAllConnections?: () => void };
  await new Promise<void>((resolve) => {
    cur.server.close(() => resolve());
    srv.closeAllConnections?.();
  });
}

/**
 * Self-contained Apple-Pencil-ready HTML/CSS/JS drawing surface served directly to the paired iPad.
 * Shares the exact same rendering & hit-testing module (/pad/engine.js) as the PC frontend.
 */
function padHtml(token: string, chatName: string) {
  const safeName = chatName.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<title>ydust Pad — ${safeName}</title>
<style>
  :root { --bg: #f4f4f5; --bar: #ffffff; --border: #e4e4e7; --text: #18181b; --muted: #71717a; --accent: #7c3aed; }
  * { box-sizing: border-box; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; -webkit-user-drag: none; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; overscroll-behavior: none; }
  body { display: flex; flex-direction: column; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
  header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--bar); border-bottom: 1px solid var(--border); flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .sep { width: 1px; height: 22px; background: var(--border); flex-shrink: 0; margin: 0 2px; }
  button { appearance: none; border: 1px solid transparent; background: transparent; color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; cursor: pointer; }
  button:active { opacity: 0.7; }
  button.active { background: #ede9fe; color: #5b21b6; border-color: #c4b5fd; }
  button.primary { background: var(--accent); color: #fff; }
  button.emerald { background: #059669; color: #fff; }
  button.outline { border-color: var(--border); background: #fafafa; }
  button:disabled { opacity: 0.35; }
  .seg { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; padding: 2px; background: #fafafa; flex-shrink: 0; }
  .seg button { padding: 4px 8px; font-size: 12px; border-radius: 6px; border: none; }
  .seg button.active { background: var(--accent); color: #fff; }
  .dot { width: 22px; height: 22px; border-radius: 999px; padding: 0; border: 2px solid transparent; }
  .dot.active { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--accent); }
  .sizes { display: inline-flex; gap: 4px; align-items: center; }
  .sz { width: 28px; height: 28px; padding: 0; justify-content: center; border-radius: 8px; }
  .sz span { display: block; border-radius: 999px; background: currentColor; }
  .stage { flex: 1; position: relative; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 14px; touch-action: none; }
  .sheet-wrap { position: relative; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.1); border-radius: 4px; touch-action: none; flex-shrink: 0; }
  canvas { display: block; touch-action: none; border-radius: 4px; }
  #paperCv { pointer-events: none; }
  #cv { position: absolute; inset: 0; background: transparent; }
  .status { position: fixed; bottom: calc(14px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); background: rgba(24,24,27,0.92); color: #fff; padding: 7px 14px; border-radius: 999px; font-size: 13px; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 20; max-width: 90vw; text-align: center; }
  .status.show { opacity: 1; }
  .title { font-weight: 600; font-size: 13px; color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sync-dot { width: 8px; height: 8px; border-radius: 999px; background: #a1a1aa; flex-shrink: 0; }
  .sync-dot.ok { background: #10b981; }
  .sync-dot.warn { background: #f59e0b; }
  .sync-dot.err { background: #ef4444; }
</style>
</head>
<body>
<header>
  <span class="sync-dot" id="syncDot" title="Connection status"></span>
  <span class="title" id="title">${safeName}</span>
  <div class="sep"></div>
  <button class="dot active" data-color="#18181b" style="background:#18181b" aria-label="Black"></button>
  <button class="dot" data-color="#2563eb" style="background:#2563eb" aria-label="Blue"></button>
  <button class="dot" data-color="#dc2626" style="background:#dc2626" aria-label="Red"></button>
  <button class="dot" data-color="#059669" style="background:#059669" aria-label="Green"></button>
  <button class="dot" data-color="#7c3aed" style="background:#7c3aed" aria-label="Violet"></button>
  <div class="sep"></div>
  <div class="sizes">
    <button class="sz" data-w="2" aria-label="Thin"><span style="width:4px;height:4px"></span></button>
    <button class="sz active" data-w="4" aria-label="Medium"><span style="width:7px;height:7px"></span></button>
    <button class="sz" data-w="8" aria-label="Thick"><span style="width:11px;height:11px"></span></button>
  </div>
  <button id="eraser" class="outline">Eraser</button>
  <div id="eraserSeg" class="seg" style="display:none">
    <button id="erStroke" class="active" title="Erase whole strokes">Stroke</button>
    <button id="erPixel" title="Erase parts of strokes">Pixel</button>
  </div>
  <button id="pencilOnly" class="outline" title="Pencil draws; 1 finger scrolls, 2 fingers zoom">Pencil only</button>
  <button id="zoomReset" class="outline" style="display:none" title="Reset zoom to 100%">100%</button>
  <div class="sep"></div>
  <button id="undo" class="outline">Undo</button>
  <button id="redo" class="outline">Redo</button>
  <button id="paper" class="outline">Grid</button>
  <button id="clear" class="outline">Clear</button>
  <div class="sep"></div>
  <button id="prevPage" class="outline">◀</button>
  <span id="pageLabel" style="font-size:12px;color:var(--muted);min-width:44px;text-align:center">1 / 1</span>
  <button id="nextPage" class="outline">▶</button>
  <button id="addPage" class="outline">+ Page</button>
  <div class="sep"></div>
  <button id="btnAttach" class="primary">Attach to Chat</button>
  <button id="btnCheck" class="emerald">Check Proof</button>
  <button id="btnLatex" class="outline">→ LaTeX</button>
</header>
<div class="stage" id="stage">
  <div class="sheet-wrap" id="wrap">
    <canvas id="paperCv"></canvas>
    <canvas id="cv"></canvas>
  </div>
</div>
<div class="status" id="toast"></div>
<script type="module">
import {
  SHEET_W as W,
  SHEET_H as H,
  drawPaper,
  drawStroke,
  renderInkToCanvas,
  renderPageToCanvas,
  strokeHitsSegment,
  applySketchOp,
} from ${JSON.stringify(`/pad/engine.js?token=${encodeURIComponent(token)}`)}; // a static import takes only a string literal

const TOKEN = ${JSON.stringify(token)};
const headers = { "content-type": "application/json", "x-pad-token": TOKEN };
const paperCv = document.getElementById("paperCv");
const pctx = paperCv.getContext("2d");
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d", { desynchronized: true });
const wrap = document.getElementById("wrap");
const stage = document.getElementById("stage");
const toastEl = document.getElementById("toast");
const syncDot = document.getElementById("syncDot");

let sketch = { id: "", title: "", paper: "grid", pages: [{ id: "p0", strokes: [] }] };
let pageId = "p0";
// Per-page own undo/redo history: stores inverse atomic ops so undo NEVER deletes PC strokes.
const undoMap = new Map();
const redoMap = new Map();
const MAX_HISTORY = 50;

let color = "#18181b";
let width = 4;
let tool = "pen";
let eraserMode = "stroke";
let pencilOnly = false;
let activeStroke = null;
let activePointer = null;
let activePointerType = null;
let strokeErasing = null;
let penActive = false;
let lastPenEnd = 0;
let baseScale = 1;
let userZoom = 1;
let backingScale = 1;
let toastTimer = null;
let expired = false;
let checkingAuth = false;

const MAX_CANVAS_PIXELS = 12_000_000;
const PALM_LOCK_MS = 350;

// Retry queue for offline / dropped network operations
const opQueue = [];
let flushing = false;
let hasLoaded = false;

// ?debug=1: shows which touches iOS got to handle itself, and what got selected, on the iPad's screen.
if (new URLSearchParams(location.search).has("debug")) {
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:30;margin:0;padding:6px 8px;max-width:70vw;background:rgba(0,0,0,0.75);color:#fff;font:11px/1.35 ui-monospace,monospace;border-radius:6px;pointer-events:none;white-space:pre-wrap";
  document.body.append(box);
  const lines = [];
  const where = (t) => (t instanceof Element ? t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") : t ? t.nodeName : "-");
  const log = (msg) => {
    lines.push(new Date().toISOString().slice(17, 23) + " " + msg);
    if (lines.length > 14) lines.shift();
    box.textContent = lines.join("\\n");
  };
  for (const evName of ["touchstart", "touchend"]) {
    // Bubble phase on window, after every other listener: an unprevented touch is one iOS may claim.
    window.addEventListener(evName, (e) => {
      if (!e.defaultPrevented) log(evName + " NOT prevented on " + where(e.target) + " (" + (e.changedTouches[0]?.touchType || "?") + ")");
    });
  }
  for (const evName of ["selectstart", "contextmenu", "pointercancel"]) {
    document.addEventListener(evName, (e) => log(evName + " " + (e.pointerType || "") + " on " + where(e.target)), true);
  }
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) log("selection " + JSON.stringify(sel.toString().slice(0, 30)) + " in " + where(sel.anchorNode?.parentElement));
  });
}

// Prevent iPadOS / Firefox-iOS WKWebView long-press selection & "Search in Firefox | Find in page" callout.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("selectstart", (e) => e.preventDefault());
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.rangeCount) sel.removeAllRanges();
});
// iPadOS runs its own long-press selection, loupe and edit menu for every touch whose touchstart isn't
// cancelled; CSS and pointer events don't stop it. Cancel all touches outside the toolbar, so a palm on
// the safe-area strip at the bottom edge is covered too. The toolbar keeps its touches: its buttons need
// their click events and it scrolls sideways.
for (const evName of ["touchstart", "touchmove", "touchend"]) {
  document.addEventListener(
    evName,
    (e) => {
      if (!(e.target instanceof Element && e.target.closest("header"))) e.preventDefault();
    },
    { passive: false, capture: true },
  );
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function markExpired() {
  if (expired) return;
  expired = true;
  syncDot.className = "sync-dot err";
  try { es.close(); } catch {}
  toast("Pairing link expired — scan the new QR code in ydust");
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function currentPageIndex() {
  const i = sketch.pages.findIndex((p) => p.id === pageId);
  if (i !== -1) return i;
  if (sketch.pages[0]) pageId = sketch.pages[0].id;
  return 0;
}

function currentPage() {
  return sketch.pages[currentPageIndex()] || null;
}

function pushHistory(pid, undoOp, redoOp) {
  const u = undoMap.get(pid) || [];
  u.push({ undo: undoOp, redo: redoOp });
  if (u.length > MAX_HISTORY) u.shift();
  undoMap.set(pid, u);
  redoMap.set(pid, []);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const pid = currentPage()?.id || "";
  document.getElementById("undo").disabled = !(undoMap.get(pid)?.length);
  document.getElementById("redo").disabled = !(redoMap.get(pid)?.length);
}

function layout() {
  const availW = Math.max(320, stage.clientWidth - 28);
  baseScale = Math.min(availW / W, 1.25);
  const totalScale = baseScale * userZoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Stay safely below iOS Safari's ~16.7M pixel canvas limit even at 300% zoom.
  const maxBacking = Math.sqrt(MAX_CANVAS_PIXELS / (W * H));
  backingScale = Math.min(totalScale * dpr, maxBacking);
  const pw = Math.round(W * backingScale);
  const ph = Math.round(H * backingScale);
  const cssW = Math.round(W * totalScale) + "px";
  const cssH = Math.round(H * totalScale) + "px";
  for (const c of [paperCv, cv]) {
    c.width = pw;
    c.height = ph;
    c.style.width = cssW;
    c.style.height = cssH;
  }
  wrap.style.width = cssW;
  wrap.style.height = cssH;
  pctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  const zr = document.getElementById("zoomReset");
  zr.style.display = Math.abs(userZoom - 1) > 0.03 ? "inline-flex" : "none";
  zr.textContent = Math.round(userZoom * 100) + "%";
  redraw();
}

function redrawPaper() {
  drawPaper(pctx, sketch.paper);
  document.getElementById("paper").textContent = sketch.paper === "grid" ? "Grid" : sketch.paper === "dots" ? "Dots" : "Blank";
}

function redrawInk() {
  const page = currentPage();
  renderInkToCanvas(cv, page ? page.strokes : [], activeStroke);
  const idx = currentPageIndex();
  document.getElementById("pageLabel").textContent = (idx + 1) + " / " + sketch.pages.length;
  document.getElementById("prevPage").disabled = idx === 0;
  document.getElementById("nextPage").disabled = idx >= sketch.pages.length - 1;
  updateHistoryButtons();
}

function redraw() {
  redrawPaper();
  redrawInk();
}

function renderExportPng() {
  const page = currentPage();
  if (!page) return "";
  const out = document.createElement("canvas");
  renderPageToCanvas(out, page, sketch.paper, 1.5);
  const dataUrl = out.toDataURL("image/png");
  out.width = 0;
  out.height = 0;
  return dataUrl;
}

function enqueueOp(op) {
  sketch = applySketchOp(sketch, op);
  if (op.type === "set-paper") redrawPaper();
  else redrawInk();
  opQueue.push(op);
  void flushQueue();
}

async function flushQueue() {
  if (flushing || !opQueue.length || expired) return;
  flushing = true;
  try {
    while (opQueue.length && !expired) {
      const next = opQueue[0];
      try {
        const res = await fetch("/pad/api/op", { method: "POST", headers, body: JSON.stringify(next) });
        if (res.status === 403) {
          markExpired();
          break;
        }
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            const body = await res.json().catch(() => ({}));
            opQueue.shift();
            toast(body.error || "Sync rejected — reloading sheet");
            await reloadSketch(true);
            continue;
          }
          throw new Error("HTTP " + res.status);
        }
        opQueue.shift();
        syncDot.className = "sync-dot ok";
      } catch {
        syncDot.className = "sync-dot warn";
        toast("Disconnected — check Wi-Fi or re-pair on PC");
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(() => {
  if (opQueue.length && !expired) void flushQueue();
}, 4000);

async function reloadSketch(silent = false) {
  if (expired) return;
  try {
    const res = await fetch("/pad/api/sketch?token=" + encodeURIComponent(TOKEN));
    if (res.status === 403) {
      markExpired();
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.sketch) {
      let merged = data.sketch;
      for (const pending of opQueue) merged = applySketchOp(merged, pending);
      sketch = merged;
      if (!sketch.pages.some((p) => p.id === pageId) && sketch.pages[0]) {
        pageId = sketch.pages[0].id;
      }
    }
    if (data.chatName) document.getElementById("title").textContent = data.chatName;
    syncDot.className = "sync-dot ok";
    if (!hasLoaded) {
      hasLoaded = true;
      layout();
      if (!silent) toast("Connected to ydust");
    } else {
      redraw();
    }
  } catch {
    syncDot.className = "sync-dot warn";
    if (!silent) toast("Could not connect to ydust on your PC");
  }
}

function toSheet(ev) {
  const r = cv.getBoundingClientRect();
  const x = Math.round(((ev.clientX - r.left) / r.width) * W * 10) / 10;
  const y = Math.round(((ev.clientY - r.top) / r.height) * H * 10) / 10;
  const p = ev.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0.5;
  return [x, y, Math.round(Math.min(1, Math.max(0.05, p)) * 100) / 100];
}

function eraseStrokesAlong(p0, p1) {
  const page = currentPage();
  if (!page || !strokeErasing) return;
  const r = Math.max(14, width * 3);
  const hit = [];
  const keep = [];
  for (const st of page.strokes) {
    if (strokeHitsSegment(st, p0[0], p0[1], p1[0], p1[1], r)) hit.push(st);
    else keep.push(st);
  }
  if (hit.length) {
    strokeErasing.removed.push(...hit);
    page.strokes = keep;
    redrawInk();
  }
}

// --- Custom touch pan (1-finger scroll in Pencil mode) + smooth CSS-transform 2-finger pinch-zoom ---
const touchPts = new Map();
let panState = null;   // { pointerId, lastX, lastY, startX, startY, dragging }
let pinchState = null; // { dist, startMidX, startMidY, originX, originY, startZoom, targetZoom, dx, dy }

const isPalmLocked = () => penActive || performance.now() - lastPenEnd < PALM_LOCK_MS;

function cancelActiveDraw() {
  if (activeStroke || strokeErasing) {
    if (strokeErasing && strokeErasing.removed.length) {
      const page = currentPage();
      if (page) page.strokes.push(...strokeErasing.removed);
    }
    activeStroke = null;
    strokeErasing = null;
    activePointer = null;
    activePointerType = null;
    redrawInk();
  }
}

function commitPinch() {
  if (!pinchState) return;
  const ps = pinchState;
  pinchState = null;
  wrap.style.transform = "";
  wrap.style.transformOrigin = "";
  const ratio = ps.targetZoom / ps.startZoom;
  const stageRect = stage.getBoundingClientRect();
  const anchorX = stage.scrollLeft + (ps.startMidX - stageRect.left);
  const anchorY = stage.scrollTop + (ps.startMidY - stageRect.top);
  userZoom = ps.targetZoom;
  layout();
  stage.scrollLeft = Math.max(0, anchorX * ratio - (ps.startMidX - stageRect.left) - ps.dx);
  stage.scrollTop = Math.max(0, anchorY * ratio - (ps.startMidY - stageRect.top) - ps.dy);
}

stage.addEventListener("pointerdown", (e) => {
  if (e.button && e.button !== 0) return;

  // Pen always takes priority: lock out palm touches and finish any in-flight touch gesture.
  if (e.pointerType === "pen") {
    penActive = true;
    if (pinchState) commitPinch();
    panState = null;
    touchPts.clear();
  }

  // Track touch pointers only when no pen is active (and past the post-pen palm-lock window).
  if (e.pointerType === "touch") {
    if (isPalmLocked()) return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size === 2) {
      // Only cancel an in-flight touch stroke; never cancel a pen stroke.
      if (activePointerType === "touch") cancelActiveDraw();
      panState = null;
      const [a, b] = [...touchPts.values()];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const wr = wrap.getBoundingClientRect();
      pinchState = {
        dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        startMidX: midX,
        startMidY: midY,
        originX: midX - wr.left,
        originY: midY - wr.top,
        startZoom: userZoom,
        targetZoom: userZoom,
        dx: 0,
        dy: 0,
      };
      return;
    }
    if (pencilOnly) {
      // 1 finger in Pencil-only mode scrolls the stage once dragged > 6px (resting palm does nothing)
      panState = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, dragging: false };
      return;
    }
  }

  // Only start drawing if the pointer landed on the canvas
  if (e.target !== cv) return;

  if (e.pointerType === "pen" && !pencilOnly) {
    pencilOnly = true;
    document.getElementById("pencilOnly").classList.add("active");
    toast("Apple Pencil detected — 1 finger scrolls, 2 fingers zoom");
  }
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  activePointer = e.pointerId;
  activePointerType = e.pointerType;
  const pt = toSheet(e);
  if (tool === "eraser" && eraserMode === "stroke") {
    strokeErasing = { prev: pt, pageId: currentPage()?.id || pageId, removed: [] };
    eraseStrokesAlong(pt, pt);
    return;
  }
  activeStroke = {
    id: uid(),
    color: tool === "eraser" ? "#000000" : color,
    width: tool === "eraser" ? width * 5 : width,
    tool,
    points: [pt],
  };
  ctx.save();
  ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  drawStroke(ctx, activeStroke);
  ctx.restore();
});

stage.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") {
    if (isPalmLocked()) return;
    if (touchPts.has(e.pointerId)) {
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchState && touchPts.size === 2) {
        const [a, b] = [...touchPts.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const nextZoom = Math.min(3, Math.max(0.6, pinchState.startZoom * (dist / pinchState.dist)));
        const scaleRatio = nextZoom / pinchState.startZoom;
        const dx = midX - pinchState.startMidX;
        const dy = midY - pinchState.startMidY;
        pinchState.targetZoom = nextZoom;
        pinchState.dx = dx;
        pinchState.dy = dy;
        wrap.style.transformOrigin = pinchState.originX + "px " + pinchState.originY + "px";
        wrap.style.transform = "translate3d(" + dx + "px," + dy + "px,0) scale(" + scaleRatio + ")";
        return;
      }
      if (panState && panState.pointerId === e.pointerId) {
        const distFromStart = Math.hypot(e.clientX - panState.startX, e.clientY - panState.startY);
        if (!panState.dragging && distFromStart > 6) panState.dragging = true;
        if (panState.dragging) {
          stage.scrollLeft -= e.clientX - panState.lastX;
          stage.scrollTop -= e.clientY - panState.lastY;
        }
        panState.lastX = e.clientX;
        panState.lastY = e.clientY;
        return;
      }
    }
  }

  if (e.pointerId !== activePointer) return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (strokeErasing) {
    for (const ev of events) {
      const pt = toSheet(ev);
      eraseStrokesAlong(strokeErasing.prev, pt);
      strokeErasing.prev = pt;
    }
    return;
  }
  if (!activeStroke) return;
  const pts = activeStroke.points;
  ctx.save();
  ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  for (const ev of events) {
    const pt = toSheet(ev);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1.2) {
      pts.push(pt);
      drawStroke(ctx, { ...activeStroke, points: [last || pt, pt] });
    }
  }
  ctx.restore();
});

function finishPointer(e) {
  if (e.pointerType === "touch") {
    touchPts.delete(e.pointerId);
    if (panState && panState.pointerId === e.pointerId) panState = null;
    if (pinchState && touchPts.size < 2) commitPinch();
  }
  if (e.pointerType === "pen" && (e.pointerId === activePointer || penActive)) {
    penActive = false;
    lastPenEnd = performance.now();
  }
  if (e.pointerId !== activePointer) return;
  activePointer = null;
  activePointerType = null;
  if (strokeErasing) {
    const se = strokeErasing;
    strokeErasing = null;
    if (se.removed.length) {
      const ids = se.removed.map((s) => s.id);
      const redoOp = { type: "remove-strokes", pageId: se.pageId, strokeIds: ids };
      const undoOp = { type: "add-strokes", pageId: se.pageId, strokes: se.removed };
      pushHistory(se.pageId, undoOp, redoOp);
      enqueueOp(redoOp);
    }
    return;
  }
  if (!activeStroke) return;
  const finished = activeStroke;
  activeStroke = null;
  const pid = currentPage()?.id || pageId;
  const addOp = { type: "add-strokes", pageId: pid, strokes: [finished] };
  const undoOp = { type: "remove-strokes", pageId: pid, strokeIds: [finished.id] };
  pushHistory(pid, undoOp, addOp);
  enqueueOp(addOp);
}
stage.addEventListener("pointerup", finishPointer);
stage.addEventListener("pointercancel", finishPointer);

// Always release palm lock even if pen is lifted over the toolbar or iOS drops a stage event.
function releasePenGlobal(e) {
  if (e.pointerType === "pen" && penActive) {
    penActive = false;
    lastPenEnd = performance.now();
  }
}
window.addEventListener("pointerup", releasePenGlobal);
window.addEventListener("pointercancel", releasePenGlobal);
window.addEventListener("blur", () => {
  penActive = false;
  touchPts.clear();
  panState = null;
  if (pinchState) commitPinch();
});

async function sendAction(action, label) {
  toast(label + "…");
  await flushQueue();
  const png = renderExportPng();
  const pid = currentPage()?.id || pageId;
  try {
    const res = await fetch("/pad/api/action", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, pageId: pid, pageIndex: currentPageIndex(), png }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) toast("Sent to ydust on your PC!");
    else toast(body.error || "Could not send to PC");
  } catch {
    toast("Could not reach ydust — check Wi-Fi");
  }
}

function updateEraserUi() {
  const on = tool === "eraser";
  document.getElementById("eraser").classList.toggle("active", on);
  document.getElementById("eraserSeg").style.display = on ? "inline-flex" : "none";
  document.getElementById("erStroke").classList.toggle("active", eraserMode === "stroke");
  document.getElementById("erPixel").classList.toggle("active", eraserMode === "pixel");
}

document.querySelectorAll(".dot").forEach((b) => b.addEventListener("click", () => {
  color = b.dataset.color;
  tool = "pen";
  document.querySelectorAll(".dot").forEach((x) => x.classList.toggle("active", x === b));
  updateEraserUi();
}));
document.querySelectorAll(".sz").forEach((b) => b.addEventListener("click", () => {
  width = Number(b.dataset.w);
  document.querySelectorAll(".sz").forEach((x) => x.classList.toggle("active", x === b));
}));
document.getElementById("eraser").addEventListener("click", () => {
  tool = tool === "eraser" ? "pen" : "eraser";
  updateEraserUi();
});
document.getElementById("erStroke").addEventListener("click", () => {
  eraserMode = "stroke";
  tool = "eraser";
  updateEraserUi();
  toast("Stroke eraser (whole strokes)");
});
document.getElementById("erPixel").addEventListener("click", () => {
  eraserMode = "pixel";
  tool = "eraser";
  updateEraserUi();
  toast("Pixel eraser (partial)");
});
document.getElementById("pencilOnly").addEventListener("click", () => {
  pencilOnly = !pencilOnly;
  document.getElementById("pencilOnly").classList.toggle("active", pencilOnly);
  toast(pencilOnly ? "Pencil only (1 finger scrolls, 2 fingers zoom)" : "Finger + Pencil (2 fingers zoom)");
});
document.getElementById("zoomReset").addEventListener("click", () => {
  userZoom = 1;
  layout();
});
document.getElementById("undo").addEventListener("click", () => {
  const pid = currentPage()?.id || pageId;
  const u = undoMap.get(pid);
  if (!u || !u.length) return;
  const entry = u.pop();
  const r = redoMap.get(pid) || [];
  r.push(entry);
  redoMap.set(pid, r);
  enqueueOp(entry.undo);
  updateHistoryButtons();
});
document.getElementById("redo").addEventListener("click", () => {
  const pid = currentPage()?.id || pageId;
  const r = redoMap.get(pid);
  if (!r || !r.length) return;
  const entry = r.pop();
  const u = undoMap.get(pid) || [];
  u.push(entry);
  undoMap.set(pid, u);
  enqueueOp(entry.redo);
  updateHistoryButtons();
});
document.getElementById("paper").addEventListener("click", () => {
  const order = ["grid", "dots", "blank"];
  const nextPaper = order[(order.indexOf(sketch.paper) + 1) % order.length];
  enqueueOp({ type: "set-paper", paper: nextPaper });
});
document.getElementById("clear").addEventListener("click", () => {
  const page = currentPage();
  if (!page || !page.strokes.length) return;
  if (!confirm("Clear this page?")) return;
  const snapshot = page.strokes.slice();
  const clearOp = { type: "clear-page", pageId: page.id };
  const undoOp = { type: "add-strokes", pageId: page.id, strokes: snapshot };
  pushHistory(page.id, undoOp, clearOp);
  enqueueOp(clearOp);
});
document.getElementById("prevPage").addEventListener("click", () => {
  const idx = currentPageIndex();
  if (idx > 0) { pageId = sketch.pages[idx - 1].id; redrawInk(); }
});
document.getElementById("nextPage").addEventListener("click", () => {
  const idx = currentPageIndex();
  if (idx < sketch.pages.length - 1) { pageId = sketch.pages[idx + 1].id; redrawInk(); }
});
document.getElementById("addPage").addEventListener("click", () => {
  const newId = uid();
  pageId = newId;
  enqueueOp({ type: "add-page", pageId: newId, page: { id: newId, strokes: [] } });
});
document.getElementById("btnAttach").addEventListener("click", () => sendAction("attach", "Attaching sheet"));
document.getElementById("btnCheck").addEventListener("click", () => sendAction("check", "Sending proof to tutor"));
document.getElementById("btnLatex").addEventListener("click", () => sendAction("latex", "Converting to LaTeX"));

window.addEventListener("resize", layout);
window.addEventListener("online", () => {
  void flushQueue().then(() => reloadSketch(true));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    penActive = false;
    touchPts.clear();
    panState = null;
    if (pinchState) commitPinch();
  } else if (document.visibilityState === "visible") {
    penActive = false;
    void flushQueue().then(() => reloadSketch(true));
  }
});

await reloadSketch(false);

let sseConnectedOnce = false;
const es = new EventSource("/pad/api/events?token=" + encodeURIComponent(TOKEN));
es.addEventListener("open", () => {
  syncDot.className = "sync-dot ok";
  if (sseConnectedOnce) {
    // Reconnected after sleep / Wi-Fi switch: flush queued strokes and pull missed updates.
    void flushQueue().then(() => reloadSketch(true));
  }
  sseConnectedOnce = true;
});
es.addEventListener("error", () => {
  if (expired) return;
  syncDot.className = "sync-dot warn";
  if (checkingAuth) return;
  checkingAuth = true;
  fetch("/pad/api/sketch?token=" + encodeURIComponent(TOKEN))
    .then((r) => {
      if (r.status === 403) markExpired();
    })
    .catch(() => {})
    .finally(() => {
      checkingAuth = false;
    });
});
es.addEventListener("pad-stopped", () => {
  if (expired) return;
  expired = true;
  syncDot.className = "sync-dot err";
  try { es.close(); } catch {}
  toast("Pairing stopped on PC — scan a new QR code in ydust");
});
es.addEventListener("op", (ev) => {
  const { op } = JSON.parse(ev.data);
  sketch = applySketchOp(sketch, op);
  if (op.type === "set-paper") redrawPaper();
  else redrawInk();
});
es.addEventListener("sync", (ev) => {
  const data = JSON.parse(ev.data);
  if (data.sketch) {
    let merged = data.sketch;
    for (const pending of opQueue) merged = applySketchOp(merged, pending);
    sketch = merged;
    if (!sketch.pages.some((p) => p.id === pageId) && sketch.pages[0]) pageId = sketch.pages[0].id;
    if (data.chatName) document.getElementById("title").textContent = data.chatName;
    redraw();
  }
});
</script>
</body>
</html>`;
}
