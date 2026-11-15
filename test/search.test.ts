import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchServer } from "../server/mcp/launch.ts";
import { readPages, search, type ScopeDoc } from "../server/mcp/search.ts";

// search.ts caches pages per alias for the life of the process: every fixture gets its own alias.
let dir: string;
let analysis: ScopeDoc, roads: ScopeDoc, many: ScopeDoc, long: ScopeDoc, scan: ScopeDoc;

const textFile = (pages: string[]) => pages.map((t, i) => `=== Page ${i + 1} ===\n${t}\n`).join("\n");

async function fixture(alias: string, name: string, pages: string[] | null): Promise<ScopeDoc> {
  const file = path.join(dir, `${alias}.txt`);
  if (pages) await writeFile(file, textFile(pages));
  return { alias, name, textFile: file };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ydust-search-"));
  analysis = await fixture("d1", "Analysis", [
    "Die Sätze von Rolle und Lagrange. Der Satz von Rolle ist wichtig.",
    "Man beschäf-\ntigt sich mit Grenzwerten und Folgen.",
    "Folgen konvergieren. Grenzwert einer Folge.",
  ]);
  roads = await fixture("d2", "Roads", ["Eine Straße und eine Strasse."]);
  many = await fixture("d3", "Many", ["Lemma ".repeat(12)]);
  long = await fixture("d4", "Long", Array.from({ length: 15 }, (_, i) => `Seite ${i + 1} `.padEnd(15_000, "x")));
  scan = await fixture("d5", "Scan", null); // no document.txt
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("search", () => {
  it("finds a phrase forgivingly and reports the count", async () => {
    const out = await search([analysis, roads], { query: "satze" });
    expect(out).toMatch(/^"satze": 1 match in 1 document\./);
    expect(out).toContain(`[d1] "Analysis" (1):`);
    expect(out).toContain("p. 1: Die «Sätze» von Rolle");
  });

  it("counts every hit on a page", async () => {
    expect(await search([analysis], { query: "Satz" })).toMatch(/^"Satz": 2 matches in 1 document\./);
  });

  it("finds words split by hyphenation, and ß/ss", async () => {
    expect(await search([analysis], { query: "beschäftigt" })).toContain("p. 2:");
    expect(await search([roads], { query: "Straße" })).toMatch(/2 matches/);
  });

  it("falls back to pages that contain all words", async () => {
    const out = await search([analysis, roads], { query: "Grenzwert Folge" });
    expect(out).toMatch(/^No exact match for "Grenzwert Folge"\. Pages that contain all of its words:/);
    expect(out).toContain(`[d1] "Analysis" (2 pages):`);
    expect(out).toContain("p. 2:");
    expect(out).toContain("p. 3:");
    expect(out).not.toContain("Roads");
  });

  it("limits hits per document and says how many more there are", async () => {
    const out = await search([many], { query: "Lemma" });
    expect(out).toMatch(/^"Lemma": 12 matches/);
    expect(out.match(/ {2}p\. 1:/g)).toHaveLength(8);
    expect(out).toContain(`… 4 more (search with doc: "d3"`);
  });

  it("restricts to one document by alias, bracketed alias or name", async () => {
    for (const doc of ["d2", "[d2]", "roads"]) {
      expect(await search([analysis, roads], { query: "Folge", doc })).toBe(`No matches for "Folge" in [d2] "Roads". Try a shorter query or another word form.`);
    }
  });

  it("rejects unknown documents, listing the available ones", async () => {
    expect(await search([analysis, roads], { query: "Folge", doc: "d9" })).toBe(
      `Unknown document "d9". Available: d1 ("Analysis"), d2 ("Roads").`,
    );
    expect(await search([analysis], { query: "Folge", doc: 3 })).toBe("`doc` must be a document id like d3.");
  });

  it("rejects queries that are too short", async () => {
    expect(await search([analysis], { query: "a" })).toBe("The query is too short.");
    expect(await search([analysis], { query: " - " })).toBe("The query is too short.");
    expect(await search([analysis], {})).toBe("The query is too short.");
  });

  it("says when nothing matches", async () => {
    expect(await search([analysis, roads], { query: "Integral" })).toBe(`No matches for "Integral". Try a shorter query or another word form.`);
  });
});

describe("readPages", () => {
  it("reads one page of the default (first) document", async () => {
    expect(await readPages([analysis, roads], { from: 2 })).toBe(`=== [d1] "Analysis", page 2 ===\nMan beschäf-\ntigt sich mit Grenzwerten und Folgen.`);
  });

  it("reads a range of another document", async () => {
    const out = await readPages([analysis, long], { doc: "d1", from: 2, to: 3 });
    expect(out).toContain(`page 2 ===`);
    expect(out).toContain(`page 3 ===`);
  });

  it("validates page numbers", async () => {
    const msg = "`from` and `to` must be page numbers with 1 ≤ from ≤ to.";
    expect(await readPages([analysis], { from: 0 })).toBe(msg);
    expect(await readPages([analysis], { from: 3, to: 2 })).toBe(msg);
    expect(await readPages([analysis], { from: "x" })).toBe(msg);
    expect(await readPages([analysis], { from: 1.5 })).toBe(msg);
  });

  it("handles pages past the end", async () => {
    expect(await readPages([analysis], { from: 9 })).toBe(`[d1] "Analysis" has only 3 pages.`);
    expect(await readPages([analysis], { from: 3, to: 9 })).toMatch(/\(The document ends at page 3\.\)$/);
  });

  it("stops at about 40,000 characters and says where to go on", async () => {
    const out = await readPages([long], { from: 1, to: 5 });
    expect(out.match(/^=== \[d4\]/gm)).toHaveLength(2);
    expect(out).toMatch(/\(Stopped after page 2 to keep this short; read from page 3 next\.\)$/);
  });

  it("says when a document has no text", async () => {
    expect(await readPages([scan], { from: 1 })).toBe(`[d5] "Scan" has no extracted text (probably a scanned PDF).`);
  });

  it("rejects unknown documents", async () => {
    expect(await readPages([analysis], { doc: "nope", from: 1 })).toMatch(/^Unknown document "nope"/);
    expect(await readPages([], { from: 1 })).toBe("No documents available.");
  });
});

describe("page cap", () => {
  it("caps at 10 pages even when they are small", async () => {
    const tiny = await fixture("d6", "Tiny", Array.from({ length: 12 }, (_, i) => `p${i + 1}`));
    const out = await readPages([tiny], { from: 1, to: 12 });
    expect(out.match(/^=== \[d6\]/gm)).toHaveLength(10);
    expect(out).toMatch(/Stopped after page 10 .* read from page 11 next/);
  });
});

describe("MCP server over stdio", () => {
  it("speaks JSON-RPC: initialize, tools/list, tools/call, errors", async () => {
    const server = searchServer([analysis]);
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
    const replies = new Map<number, (msg: any) => void>();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const msg = JSON.parse(line);
      replies.get(msg.id)?.(msg);
    });
    let nextId = 1;
    const call = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        replies.set(id, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      const init = await call("initialize", { protocolVersion: "2025-03-26" });
      expect(init.result.protocolVersion).toBe("2025-03-26");
      expect(init.result.serverInfo.name).toBe("ydust");
      // Notifications get no reply; the next request must still work.
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const list = await call("tools/list");
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "read_pages"]);

      const hit = await call("tools/call", { name: "search", arguments: { query: "Rolle" } });
      expect(hit.result.isError).toBeUndefined();
      expect(hit.result.content[0].text).toMatch(/^"Rolle": 2 matches/);

      const unknown = await call("tools/call", { name: "write_file", arguments: {} });
      expect(unknown.result).toEqual({ content: [{ type: "text", text: "Unknown tool write_file" }], isError: true });

      const bad = await call("resources/list");
      expect(bad.error.code).toBe(-32601);
    } finally {
      child.kill();
    }
  });
});
