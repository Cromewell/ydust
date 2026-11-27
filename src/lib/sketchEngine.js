/**
 * Shared vector scratchpad rendering and whole-stroke hit-testing engine.
 * Used directly by both the PC React app (via Vite/TS) and the iPad Pad page
 * (served at /pad/engine.js), guaranteeing pixel-identical rendering and physics.
 */

export const SHEET_W = 1200;
export const SHEET_H = 1600;

/**
 * Draw the sheet paper background (grid, dots, or blank).
 * @param {CanvasRenderingContext2D} ctx
 * @param {"grid" | "dots" | "blank"} paper
 * @param {number} [w]
 * @param {number} [h]
 */
export function drawPaper(ctx, paper, w = SHEET_W, h = SHEET_H) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const step = 40;
  if (paper === "grid") {
    ctx.strokeStyle = "#e4e4e7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
  } else if (paper === "dots") {
    ctx.fillStyle = "#cbd5e1";
    for (let x = step; x < w; x += step) {
      for (let y = step; y < h; y += step) {
        ctx.fillRect(x - 1, y - 1, 2.2, 2.2);
      }
    }
  }
  ctx.restore();
}

/**
 * Draw a single stroke onto a transparent ink canvas.
 * Pixel-eraser strokes use `destination-out` so they erase ink without touching the paper layer.
 * Both PC and iPad store eraser strokes with their final width already scaled (`width * 5`)
 * and draw them at 1x, with the same pressure curve (`0.55 + p * 0.9`).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ color: string; width: number; tool?: "pen" | "eraser"; points: [number, number, number][] }} stroke
 */
export function drawStroke(ctx, stroke) {
  const pts = stroke.points;
  if (!pts || !pts.length) return;
  const isEraser = stroke.tool === "eraser";
  ctx.save();
  ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = isEraser ? "rgba(0,0,0,1)" : stroke.color;
  ctx.fillStyle = isEraser ? "rgba(0,0,0,1)" : stroke.color;
  if (pts.length === 1) {
    const r = Math.max(0.8, (stroke.width * (isEraser ? 1 : 0.65 + pts[0][2] * 0.7)) / 2);
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p = (p0[2] + p1[2]) * 0.5;
    ctx.lineWidth = Math.max(0.8, stroke.width * (isEraser ? 1 : 0.55 + p * 0.9));
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Render all strokes of a page onto a transparent ink canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{ color: string; width: number; tool?: "pen" | "eraser"; points: [number, number, number][] }>} strokes
 * @param {{ color: string; width: number; tool?: "pen" | "eraser"; points: [number, number, number][] } | null} [activeStroke]
 */
export function renderInkToCanvas(canvas, strokes, activeStroke = null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / SHEET_W;
  const sy = canvas.height / SHEET_H;
  ctx.save();
  ctx.scale(sx, sy);
  for (const s of strokes) drawStroke(ctx, s);
  if (activeStroke) drawStroke(ctx, activeStroke);
  ctx.restore();
}

/**
 * Composite paper + transparent ink layer into a single opaque canvas (for PNG export).
 * @param {HTMLCanvasElement} canvas
 * @param {{ strokes: Array<{ color: string; width: number; tool?: "pen" | "eraser"; points: [number, number, number][] }> }} page
 * @param {"grid" | "dots" | "blank"} paper
 * @param {number} [scale]
 */
export function renderPageToCanvas(canvas, page, paper, scale = 1) {
  const w = Math.round(SHEET_W * scale);
  const h = Math.round(SHEET_H * scale);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(scale, scale);
  drawPaper(ctx, paper);
  ctx.restore();

  const ink = document.createElement("canvas");
  ink.width = w;
  ink.height = h;
  renderInkToCanvas(ink, page.strokes || []);
  ctx.drawImage(ink, 0, 0);
  // Release temporary backing store immediately (important on iOS Safari's canvas memory budget).
  ink.width = 0;
  ink.height = 0;
}

function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function ccw(ax, ay, bx, by, cx, cy) {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  return ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) && ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);
}

function segmentToSegmentDistSq(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointToSegmentDistSq(ax, ay, cx, cy, dx, dy),
    pointToSegmentDistSq(bx, by, cx, cy, dx, dy),
    pointToSegmentDistSq(cx, cy, ax, ay, bx, by),
    pointToSegmentDistSq(dx, dy, ax, ay, bx, by),
  );
}

/**
 * Returns true if the eraser path segment (x1, y1)-(x2, y2) touches this pen stroke
 * within `radius` (in logical sheet coordinates). Ignores pixel-eraser mask strokes.
 * @param {{ width: number; tool?: "pen" | "eraser"; points: [number, number, number][] }} stroke
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} radius
 * @returns {boolean}
 */
export function strokeHitsSegment(stroke, x1, y1, x2, y2, radius) {
  if (stroke.tool === "eraser") return false;
  const pts = stroke.points;
  if (!pts || !pts.length) return false;
  const hitR = radius + stroke.width * 0.5;
  const hitRSq = hitR * hitR;

  const minEx = Math.min(x1, x2) - hitR;
  const maxEx = Math.max(x1, x2) + hitR;
  const minEy = Math.min(y1, y2) - hitR;
  const maxEy = Math.max(y1, y2) + hitR;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minEx || minX > maxEx || maxY < minEy || minY > maxEy) return false;

  if (pts.length === 1) {
    return pointToSegmentDistSq(pts[0][0], pts[0][1], x1, y1, x2, y2) <= hitRSq;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (segmentToSegmentDistSq(a[0], a[1], b[0], b[1], x1, y1, x2, y2) <= hitRSq) return true;
  }
  return false;
}

/**
 * Apply an atomic sketch operation idempotently to a sketch object (returns a new sketch).
 * Shared by PC and iPad so live SSE updates merge cleanly without clobbering concurrent work.
 * @template {{ paper: "grid" | "dots" | "blank"; pages: Array<{ id: string; strokes: Array<{ id: string }> }> }} T
 * @param {T} sketch
 * @param {any} op
 * @returns {T}
 */
export function applySketchOp(sketch, op) {
  if (!sketch || !op) return sketch;
  if (op.type === "add-strokes") {
    const strokes = Array.isArray(op.strokes) ? op.strokes : [];
    return {
      ...sketch,
      pages: sketch.pages.map((p) => {
        if (p.id !== op.pageId) return p;
        const have = new Set(p.strokes.map((s) => s.id));
        const added = strokes.filter((s) => s && !have.has(s.id));
        return added.length ? { ...p, strokes: [...p.strokes, ...added] } : p;
      }),
    };
  }
  if (op.type === "remove-strokes") {
    const gone = new Set(Array.isArray(op.strokeIds) ? op.strokeIds : []);
    if (!gone.size) return sketch;
    return {
      ...sketch,
      pages: sketch.pages.map((p) => (p.id === op.pageId ? { ...p, strokes: p.strokes.filter((s) => !gone.has(s.id)) } : p)),
    };
  }
  if (op.type === "add-page") {
    if (!op.page || sketch.pages.some((p) => p.id === op.page.id)) return sketch;
    return { ...sketch, pages: [...sketch.pages, { id: op.page.id, strokes: op.page.strokes || [] }] };
  }
  if (op.type === "clear-page") {
    return {
      ...sketch,
      pages: sketch.pages.map((p) => (p.id === op.pageId ? { ...p, strokes: [] } : p)),
    };
  }
  if (op.type === "set-paper") {
    return { ...sketch, paper: op.paper };
  }
  return sketch;
}
