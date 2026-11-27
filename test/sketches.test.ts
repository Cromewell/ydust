import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PadActionPayload } from "../server/sketches.ts";
import { applySketchOp, strokeHitsSegment } from "../src/lib/sketchCanvas.ts";

const lib = await mkdtemp(path.join(tmpdir(), "ydust-sketches-"));
process.env.YDUST_LIBRARY = lib;
process.env.YDUST_PAD_PORT = "0";
const { app } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { startPadServer, stopPadServer, padStatus } = await import("../server/pad.ts");
const { registerPcListener, setChatBusyCheck } = await import("../server/sketches.ts");
const { latexStatus } = await import("../server/latex.ts");

let docId = "";
let folderId = "";

// Valid minimal 1x1 PNG (> 64 bytes)
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  await store.ensureLibrary();
  const doc = await store.createDoc("Algebra Script", new Uint8Array(Buffer.from("%PDF-1.4\n")));
  docId = doc.id;
  const folder = await store.createFolder("Linear Algebra");
  folderId = folder.id;
});

afterAll(async () => {
  await stopPadServer();
  await rm(lib, { recursive: true, force: true });
});

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("scratchpad sketches API & atomic operations", () => {
  it("creates only one default Sheet 1 when ensure=1 is called concurrently (StrictMode / two tabs)", async () => {
    const [r1, r2] = await Promise.all([
      req("GET", `/api/folders/${folderId}/sketches?ensure=1`),
      req("GET", `/api/folders/${folderId}/sketches?ensure=1`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const l1 = await r1.json();
    const l2 = await r2.json();
    expect(l1).toHaveLength(1);
    expect(l2).toHaveLength(1);
    expect(l1[0].id).toBe(l2[0].id);
    expect(l1[0].title).toBe("Sheet 1");
  });

  it("supports atomic ops (add/remove strokes, add/clear page, set paper) without clobbering concurrent strokes", async () => {
    const createRes = await req("POST", `/api/docs/${docId}/sketches`, { title: "Proof 1", paper: "dots" });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const page1Id = created.pages[0].id;

    // PC adds stroke s1, iPad adds stroke s2 concurrently
    const s1 = { id: "pc-1", color: "#2563eb", width: 4, tool: "pen", points: [[10, 20, 0.5], [30, 40, 0.8]] };
    const s2 = { id: "ipad-1", color: "#18181b", width: 4, tool: "pen", points: [[50, 60, 0.6], [70, 80, 0.7]] };
    const [a1, a2] = await Promise.all([
      req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "add-strokes", pageId: page1Id, strokes: [s1] }),
      req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "add-strokes", pageId: page1Id, strokes: [s2] }),
    ]);
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(201);

    // PC undoes ONLY its own stroke pc-1 — ipad-1 must survive intact!
    const undoRes = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, {
      type: "remove-strokes",
      pageId: page1Id,
      strokeIds: ["pc-1"],
    });
    expect(undoRes.status).toBe(201);

    // Reject stroke on non-existent pageId
    const badPage = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, {
      type: "add-strokes",
      pageId: "does-not-exist",
      strokes: [s1],
    });
    expect(badPage.status).toBe(404);

    // Reject invalid stroke payload
    const badStroke = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, {
      type: "add-strokes",
      pageId: page1Id,
      strokes: [{ points: [] }],
    });
    expect(badStroke.status).toBe(400);

    // Add page, set paper, clear page
    const addPageRes = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "add-page", pageId: "page-2" });
    expect(addPageRes.status).toBe(201);
    const setPaperRes = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "set-paper", paper: "grid" });
    expect(setPaperRes.status).toBe(201);

    const fetched = await (await req("GET", `/api/docs/${docId}/sketches/${created.id}`)).json();
    expect(fetched.paper).toBe("grid");
    expect(fetched.pages).toHaveLength(2);
    expect(fetched.pages[0].strokes.map((s: { id: string }) => s.id)).toEqual(["ipad-1"]);

    const clearRes = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "clear-page", pageId: page1Id });
    expect(clearRes.status).toBe(201);
    const afterClear = await (await req("GET", `/api/docs/${docId}/sketches/${created.id}`)).json();
    expect(afterClear.pages[0].strokes).toHaveLength(0);

    // Invalid sketch id returns 404
    const missing = await req("GET", `/api/docs/${docId}/sketches/not-a-uuid`);
    expect(missing.status).toBe(404);

    // Legacy full-sketch PUT route is removed
    const putGone = await req("PUT", `/api/docs/${docId}/sketches/${created.id}`, { paper: "blank" });
    expect(putGone.status).toBe(404);

    // Undo of Clear on a dense page (>500 strokes) succeeds cleanly
    const sixHundred = Array.from({ length: 600 }, (_, i) => ({
      id: `bulk-${i}`,
      color: "#18181b",
      width: 3,
      tool: "pen",
      points: [[10 + (i % 100), 20 + Math.floor(i / 100), 0.5]],
    }));
    const bulkAdd = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, {
      type: "add-strokes",
      pageId: page1Id,
      strokes: sixHundred,
    });
    expect(bulkAdd.status).toBe(201);
    expect((await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, { type: "clear-page", pageId: page1Id })).status).toBe(201);
    const undoClear = await req("POST", `/api/docs/${docId}/sketches/${created.id}/ops`, {
      type: "add-strokes",
      pageId: page1Id,
      strokes: sixHundred,
    });
    expect(undoClear.status).toBe(201);
    const restored = await (await req("GET", `/api/docs/${docId}/sketches/${created.id}`)).json();
    expect(restored.pages[0].strokes).toHaveLength(600);

    // Delete sketch
    const delRes = await req("DELETE", `/api/docs/${docId}/sketches/${created.id}`);
    expect(delRes.status).toBe(200);
    const afterDel = await req("GET", `/api/docs/${docId}/sketches/${created.id}`);
    expect(afterDel.status).toBe(404);
  });
});

describe("isolated LAN iPad pairing server", () => {
  it("binds to requested IP, enforces token auth, rotates token on chat switch, delivers actions once, and stops cleanly", async () => {
    const sk1 = await (await req("POST", `/api/docs/${docId}/sketches`, { title: "iPad Sheet 1" })).json();
    const sk2 = await (await req("POST", `/api/docs/${docId}/sketches`, { title: "iPad Sheet 2" })).json();
    const folderList = await (await req("GET", `/api/folders/${folderId}/sketches?ensure=1`)).json();
    const folderSketchId = folderList[0].id;

    // Bind explicitly to 127.0.0.1
    const startRes = await req("POST", "/api/pad/start", { kind: "doc", chatId: docId, sketchId: sk1.id, host: "127.0.0.1" });
    expect(startRes.status).toBe(200);
    const st = await startRes.json();
    expect(st.active).toBe(true);
    expect(st.bindHost).toBe("127.0.0.1");
    expect(st.port).toBeGreaterThan(0);
    expect(st.token).toMatch(/^[0-9a-f]{48}$/);

    const base = `http://127.0.0.1:${st.port}`;
    // Missing or wrong token → 403 everywhere
    expect((await fetch(`${base}/pad`)).status).toBe(403);
    expect((await fetch(`${base}/pad/engine.js`)).status).toBe(403);
    expect((await fetch(`${base}/pad/api/sketch`, { headers: { "x-pad-token": "wrong" } })).status).toBe(403);
    expect(
      (
        await fetch(`${base}/pad/api/op`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-pad-token": "wrong" },
          body: JSON.stringify({ type: "set-paper", paper: "blank" }),
        })
      ).status,
    ).toBe(403);

    // Valid token serves HTML + shared engine module
    const htmlRes = await fetch(`${base}/pad?token=${st.token}`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("ydust Pad");
    expect(html).toContain("/pad/engine.js");
    expect(html).toContain("paperCv");
    expect(html).toContain("erStroke");
    expect(html).toContain("touchstart");
    expect(html).toContain("MAX_CANVAS_PIXELS");
    expect(html).toContain("PALM_LOCK_MS");
    expect(html).toContain("commitPinch");
    expect(html).toContain("markExpired");
    // The page script must parse: a syntax error leaves the iPad without any drawing or touch handling.
    const pageScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(pageScript).toBeTruthy();
    const scriptDir = await mkdtemp(path.join(tmpdir(), "ydust-pad-script-"));
    try {
      await writeFile(path.join(scriptDir, "page.mjs"), pageScript!);
      expect(() => execFileSync(process.execPath, ["--check", path.join(scriptDir, "page.mjs")], { stdio: "pipe" })).not.toThrow();
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }

    // Legacy PUT /pad/api/sketch is removed
    const padPutGone = await fetch(`${base}/pad/api/sketch`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pad-token": st.token },
      body: JSON.stringify({ paper: "blank" }),
    });
    expect(padPutGone.status).toBe(404);

    const engineRes = await fetch(`${base}/pad/engine.js?token=${st.token}`);
    expect(engineRes.status).toBe(200);
    expect(await engineRes.text()).toContain("destination-out");

    // Push atomic stroke from iPad + reject non-existent page
    const page1Id = sk1.pages[0].id;
    const badPageOp = await fetch(`${base}/pad/api/op`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pad-token": st.token },
      body: JSON.stringify({ type: "add-strokes", pageId: "missing", strokes: [{ id: "x", color: "#18181b", width: 3, points: [[1, 2, 0.5]] }] }),
    });
    expect(badPageOp.status).toBe(404);

    const padOp = await fetch(`${base}/pad/api/op`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pad-token": st.token },
      body: JSON.stringify({
        type: "add-strokes",
        pageId: page1Id,
        strokes: [{ id: "ipad-op-1", color: "#18181b", width: 3, points: [[50, 60, 0.7], [80, 90, 0.8]] }],
      }),
    });
    expect(padOp.status).toBe(200);
    const pcSketch = await (await req("GET", `/api/docs/${docId}/sketches/${sk1.id}`)).json();
    expect(pcSketch.pages[0].strokes.some((s: { id: string }) => s.id === "ipad-op-1")).toBe(true);

    // Action with NO open PC listener → 409 and does NOT save an orphan PNG!
    const imgDir = path.join(store.chatDir("doc", docId), "images");
    const imgsBefore = await readdir(imgDir).catch(() => [] as string[]);
    const pngDataUrl = "data:image/png;base64," + TINY_PNG.toString("base64");
    const noPc = await fetch(`${base}/pad/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pad-token": st.token },
      body: JSON.stringify({ action: "check", pageId: page1Id, png: pngDataUrl }),
    });
    expect(noPc.status).toBe(409);
    const imgsAfter409 = await readdir(imgDir).catch(() => [] as string[]);
    expect(imgsAfter409).toEqual(imgsBefore);

    // Action with TWO open PC tabs → delivered to EXACTLY ONE tab (no duplicate CLI runs!)
    // Also verify 409 when tutor is busy answering for "check", while "attach" still works.
    const received1: PadActionPayload[] = [];
    const received2: PadActionPayload[] = [];
    const off1 = registerPcListener("doc", docId, (p) => received1.push(p));
    const off2 = registerPcListener("doc", docId, (p) => received2.push(p));
    try {
      // Invalid PNG with an open listener → 415
      const badPng = await fetch(`${base}/pad/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pad-token": st.token },
        body: JSON.stringify({ action: "attach", pageId: page1Id, png: "data:image/png;base64," + Buffer.alloc(100, 65).toString("base64") }),
      });
      expect(badPng.status).toBe(415);

      // Busy tutor rejects "check" with 409 and writes no orphan image
      setChatBusyCheck(() => true);
      const busyCheck = await fetch(`${base}/pad/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pad-token": st.token },
        body: JSON.stringify({ action: "check", pageId: page1Id, png: pngDataUrl }),
      });
      expect(busyCheck.status).toBe(409);
      expect(await readdir(imgDir).catch(() => [] as string[])).toEqual(imgsBefore);
      setChatBusyCheck(() => false);

      const okAction = await fetch(`${base}/pad/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pad-token": st.token },
        body: JSON.stringify({ action: "check", pageId: page1Id, png: pngDataUrl }),
      });
      expect(okAction.status).toBe(200);
      expect(received1.length + received2.length).toBe(1);
    } finally {
      setChatBusyCheck(() => false);
      off1();
      off2();
    }

    // Switching sheet within the SAME chat keeps the same token
    const sameChatSwitch = await (
      await req("POST", "/api/pad/start", { kind: "doc", chatId: docId, sketchId: sk2.id, host: "127.0.0.1" })
    ).json();
    expect(sameChatSwitch.token).toBe(st.token);
    expect(sameChatSwitch.sketchId).toBe(sk2.id);

    // Switching to a DIFFERENT chat rotates the token and invalidates the old one
    const diffChatSwitch = await (
      await req("POST", "/api/pad/start", { kind: "folder", chatId: folderId, sketchId: folderSketchId, host: "127.0.0.1" })
    ).json();
    expect(diffChatSwitch.token).not.toBe(st.token);
    const newBase = `http://127.0.0.1:${diffChatSwitch.port}`;
    expect((await fetch(`${newBase}/pad/api/sketch`, { headers: { "x-pad-token": st.token } })).status).toBe(403);
    expect((await fetch(`${newBase}/pad/api/sketch`, { headers: { "x-pad-token": diffChatSwitch.token } })).status).toBe(200);

    // Stop pairing → status inactive, port closed
    const stopRes = await req("POST", "/api/pad/stop");
    expect(stopRes.status).toBe(200);
    const statusAfter = await (await req("GET", "/api/pad")).json();
    expect(statusAfter.active).toBe(false);
    await expect(fetch(`${newBase}/pad/api/sketch`, { headers: { "x-pad-token": diffChatSwitch.token } })).rejects.toThrow();
  });

  it("auto-stops after idle timeout when no iPad is connected", async () => {
    const sk = await (await req("POST", `/api/docs/${docId}/sketches`, { title: "Idle Test" })).json();
    const st = await startPadServer({ kind: "doc", chatId: docId, sketchId: sk.id, chatName: "Idle", host: "127.0.0.1", idleTimeoutMs: 60 });
    expect(st.active).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(padStatus().active).toBe(false);
  });
});

describe("LaTeX compile & import API", () => {
  it("compiles standalone .tex to PDF and can import it directly into a folder", async () => {
    const status = await latexStatus();
    if (!status.available) return;

    const tex = "\\documentclass{article}\\begin{document}Hello $a^2+b^2=c^2$.\\end{document}";
    const pdfRes = await req("POST", "/api/latex/compile", { tex, filename: "Pythagoras" });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-");

    const importRes = await req("POST", "/api/latex/compile", {
      tex,
      filename: "Pythagoras Proof",
      importTo: { folderId },
    });
    expect(importRes.status).toBe(201);
    const imported = await importRes.json();
    expect(imported.name).toBe("Pythagoras Proof");
    expect(imported.folderId).toBe(folderId);
  });

  it("returns 422 with compiler log on broken LaTeX", async () => {
    const status = await latexStatus();
    if (!status.available) return;

    const res = await req("POST", "/api/latex/compile", { tex: "\\documentclass{article}\\begin{document}\\bogusCommand\\end{document}" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe("shared sketchEngine helpers", () => {
  it("detects intersecting and nearby pen strokes, skips distant strokes and pixel-eraser masks", () => {
    const line = { id: "a", color: "#18181b", width: 4, tool: "pen" as const, points: [[100, 100, 0.5], [200, 100, 0.5]] as [number, number, number][] };
    const dot = { id: "b", color: "#18181b", width: 4, tool: "pen" as const, points: [[300, 300, 0.5]] as [number, number, number][] };
    const mask = { id: "c", color: "#000000", width: 20, tool: "eraser" as const, points: [[100, 100, 0.5], [200, 100, 0.5]] as [number, number, number][] };

    expect(strokeHitsSegment(line, 150, 80, 150, 120, 10)).toBe(true);
    expect(strokeHitsSegment(line, 100, 110, 200, 110, 10)).toBe(true);
    expect(strokeHitsSegment(line, 100, 140, 200, 140, 10)).toBe(false);
    expect(strokeHitsSegment(dot, 295, 295, 305, 305, 10)).toBe(true);
    expect(strokeHitsSegment(dot, 350, 350, 360, 360, 10)).toBe(false);
    expect(strokeHitsSegment(mask, 150, 80, 150, 120, 10)).toBe(false);
  });

  it("applies atomic operations idempotently", () => {
    const base = {
      id: "sk1",
      title: "Sheet 1",
      paper: "grid" as const,
      pages: [{ id: "p1", strokes: [] }],
      createdAt: "",
      updatedAt: "",
    };
    const st = { id: "s1", color: "#18181b", width: 4, tool: "pen" as const, points: [[1, 2, 0.5]] as [number, number, number][] };
    const once = applySketchOp(base, { type: "add-strokes", pageId: "p1", strokes: [st] });
    const twice = applySketchOp(once, { type: "add-strokes", pageId: "p1", strokes: [st] });
    expect(twice.pages[0].strokes).toHaveLength(1);
    const removed = applySketchOp(twice, { type: "remove-strokes", pageId: "p1", strokeIds: ["s1"] });
    expect(removed.pages[0].strokes).toHaveLength(0);
    const addedPage = applySketchOp(removed, { type: "add-page", page: { id: "p2", strokes: [] } });
    expect(addedPage.pages).toHaveLength(2);
    const paper = applySketchOp(addedPage, { type: "set-paper", paper: "dots" });
    expect(paper.paper).toBe("dots");
  });
});
