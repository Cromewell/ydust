import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-highlights-"));
process.env.YDUST_LIBRARY = lib;
const { app } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { highlightsPath } = await import("../server/highlights.ts");
const { listHighlightsTool } = await import("../server/mcp/search.ts");

afterAll(() => rm(lib, { recursive: true, force: true }));

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("highlights", () => {
  let doc: string;
  let base: string;
  beforeAll(async () => {
    doc = (await store.createDoc("Analysis", new TextEncoder().encode("%PDF"))).id;
    base = `/api/docs/${doc}/highlights`;
  });

  it("starts empty", async () => {
    expect(await (await req("GET", base)).json()).toEqual([]);
  });

  it("adds highlights, sorted by page, in their own file", async () => {
    const a = await req("POST", base, { page: 3, text: "Every bounded\n sequence", occurrence: 1, color: "green" });
    expect(a.status).toBe(201);
    expect(await a.json()).toMatchObject({ page: 3, text: "Every bounded sequence", occurrence: 1, color: "green" });
    await req("POST", base, { page: 1, text: "Limits are unique", color: "yellow", comment: "  definition  " });
    const list = await (await req("GET", base)).json();
    expect(list.map((h: { page: number }) => h.page)).toEqual([1, 3]);
    expect(list[0].comment).toBe("definition");
    const file = JSON.parse(await readFile(highlightsPath(doc), "utf8"));
    expect(file.highlights).toHaveLength(2);
    // The chat's meta.json is not touched by highlights.
    expect(JSON.parse(await readFile(path.join(store.docDir(doc), "meta.json"), "utf8"))).not.toHaveProperty("highlights");
  });

  it("changes colour and comment, and removes an empty comment", async () => {
    const [h] = await (await req("GET", base)).json();
    const p = await (await req("PATCH", `${base}/${h.id}`, { color: "pink", comment: "exam!" })).json();
    expect(p).toMatchObject({ color: "pink", comment: "exam!" });
    const q = await (await req("PATCH", `${base}/${h.id}`, { comment: "" })).json();
    expect(q).not.toHaveProperty("comment");
    expect(q.color).toBe("pink");
  });

  it("deletes", async () => {
    const [h] = await (await req("GET", base)).json();
    expect((await req("DELETE", `${base}/${h.id}`)).status).toBe(200);
    expect((await req("DELETE", `${base}/${h.id}`)).status).toBe(404);
    expect(await (await req("GET", base)).json()).toHaveLength(1);
  });

  it("validates", async () => {
    for (const bad of [
      { page: 0, text: "x", color: "green" },
      { page: 1.5, text: "x", color: "green" },
      { page: 1, text: " ", color: "green" },
      { page: 1, text: "x", color: "purple" },
      { page: 1, text: "x", color: "green", occurrence: -1 },
      { page: 1, text: "x".repeat(4001), color: "green" },
      { page: 1, text: "x", color: "green", comment: 5 },
    ]) {
      expect((await req("POST", base, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const [h] = await (await req("GET", base)).json();
    expect((await req("PATCH", `${base}/${h.id}`, { color: "black" })).status).toBe(400);
    expect((await req("PATCH", `${base}/nope`, { color: "green" })).status).toBe(404);
  });

  it("404s for unknown documents, without creating anything", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect((await req("GET", `/api/docs/${ghost}/highlights`)).status).toBe(404);
    expect((await req("POST", `/api/docs/${ghost}/highlights`, { page: 1, text: "x", color: "green" })).status).toBe(404);
  });

  it("serializes concurrent changes", async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => req("POST", base, { page: i + 1, text: `t${i}`, color: "blue" })));
    expect(await (await req("GET", base)).json()).toHaveLength(16);
  });

  it("never overwrites a highlights file it can't read", async () => {
    const d = (await store.createDoc("Broken", new TextEncoder().encode("%PDF"))).id;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(highlightsPath(d), '{"highlights": [ {"id": "keep"');
    expect((await req("POST", `/api/docs/${d}/highlights`, { page: 1, text: "x", color: "green" })).status).toBe(500);
    expect((await req("GET", `/api/docs/${d}/highlights`)).status).toBe(500);
    expect(await readFile(highlightsPath(d), "utf8")).toBe('{"highlights": [ {"id": "keep"');
    const docs = [{ alias: "d2", name: "Broken", textFile: "/none", highlightsFile: highlightsPath(d) }];
    expect(await listHighlightsTool(docs, {})).toBe(`[d2] "Broken": its highlights could not be read.`);
  });

  it("list_highlights shows them to the assistant, by colour", async () => {
    const docs = [{ alias: "d1", name: "Analysis", textFile: "/none", highlightsFile: highlightsPath(doc) }];
    const all = await listHighlightsTool(docs, {});
    expect(all).toMatch(/^16 highlights:/);
    expect(all).toContain(`[d1] "Analysis" (16):`);
    expect(all).toContain("p. 3 (green): «Every bounded sequence»");
    await req("POST", base, { page: 2, text: "Cauchy", color: "orange", comment: "know this" });
    expect(await listHighlightsTool(docs, { color: "orange" })).toBe(`1 highlight in orange:\n\n[d1] "Analysis" (1):\n  p. 2 (orange): «Cauchy» — my comment: know this`);
    expect(await listHighlightsTool(docs, { color: "yellow" })).toBe(`No highlights in yellow in [d1] "Analysis".`);
    expect(await listHighlightsTool(docs, { color: "purple" })).toContain("must be one of");
    expect(await listHighlightsTool(docs, { doc: "d9" })).toContain("Unknown document");
  });
});
