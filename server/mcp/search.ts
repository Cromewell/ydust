/**
 * ydust's read-only document tools for the agents, as a tiny MCP server (stdio,
 * newline-delimited JSON-RPC, no dependencies).
 *
 *   search(query, doc?)            forgiving full-text search (accents, ß/ss, hyphenation,
 *                                  case and line breaks don't matter), like the in-app search
 *   read_pages(doc?, from, to?)    exact text of a page range
 *
 * Which documents it may read comes from ydust, never from the model: YDUST_DOCS is a JSON
 * array of { alias, name, textFile } (the first is the default document).
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { findInString, fold } from "../../src/lib/textMatch.ts";

export type ScopeDoc = { alias: string; name: string; textFile: string };

const MAX_PER_DOC = 8;
const MAX_TOTAL = 30;
const MAX_PAGES_PER_READ = 10;
const MAX_READ_CHARS = 40_000;
const AROUND = 70;

// --- Documents ---

const pageCache = new Map<string, Promise<string[]>>();

/** Pages of a document.txt ("=== Page N ===" markers; index 0 = page 1). */
function pagesOf(d: ScopeDoc): Promise<string[]> {
  let p = pageCache.get(d.alias);
  if (!p) {
    p = readFile(d.textFile, "utf8").then(
      (body) => body.split(/^=== Page \d+ ===$/m).slice(1).map((t) => t.trim()),
      () => [],
    );
    pageCache.set(d.alias, p);
  }
  return p;
}

/** A document by alias ("d3", "[d3]") or by name; the first one if none is given. */
function findDoc(docs: ScopeDoc[], ref: unknown): ScopeDoc | string {
  if (ref === undefined || ref === null || ref === "") return docs[0] ?? "No documents available.";
  if (typeof ref !== "string") return "`doc` must be a document id like d3.";
  const r = ref.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const hit = docs.find((d) => d.alias.toLowerCase() === r) ?? docs.find((d) => d.name.toLowerCase() === r);
  return hit ?? `Unknown document "${ref}". Available: ${docs.map((d) => `${d.alias} ("${d.name}")`).join(", ")}.`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function excerpt(text: string, start: number, end: number) {
  const a = Math.max(0, start - AROUND);
  const b = Math.min(text.length, end + AROUND);
  return `${a > 0 ? "…" : ""}${oneLine(text.slice(a, start))} «${oneLine(text.slice(start, end))}» ${oneLine(text.slice(end, b))}${b < text.length ? "…" : ""}`;
}

// --- Tools ---

export async function search(docs: ScopeDoc[], args: { query?: unknown; doc?: unknown }): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (fold(query).length < 2) return "The query is too short.";
  let scope = docs;
  if (args.doc !== undefined && args.doc !== null && args.doc !== "") {
    const d = findDoc(docs, args.doc);
    if (typeof d === "string") return d;
    scope = [d];
  }

  type Hit = { page: number; text: string };
  const phrase: { doc: ScopeDoc; hits: Hit[]; count: number }[] = [];
  for (const d of scope) {
    const pages = await pagesOf(d);
    const hits: Hit[] = [];
    let count = 0;
    pages.forEach((text, i) => {
      for (const [a, b] of findInString(text, query, 200)) {
        count++;
        if (hits.length < MAX_PER_DOC) hits.push({ page: i + 1, text: excerpt(text, a, b) });
      }
    });
    if (count) phrase.push({ doc: d, hits, count });
  }

  if (phrase.length) {
    const total = phrase.reduce((n, r) => n + r.count, 0);
    const out = [`"${query}": ${total} match${total === 1 ? "" : "es"} in ${phrase.length} document${phrase.length === 1 ? "" : "s"}.`];
    let shown = 0;
    for (const r of phrase.sort((x, y) => y.count - x.count)) {
      out.push("", `[${r.doc.alias}] "${r.doc.name}" (${r.count}):`);
      for (const h of r.hits) {
        if (shown >= MAX_TOTAL) break;
        out.push(`  p. ${h.page}: ${h.text}`);
        shown++;
      }
      if (r.count > r.hits.length) out.push(`  … ${r.count - r.hits.length} more (search with doc: "${r.doc.alias}" or a more specific query)`);
    }
    return out.join("\n");
  }

  // No exact phrase: pages that contain all of its words.
  const words = query.split(/\s+/).map(fold).filter((w) => w.length >= 2);
  if (words.length >= 2) {
    const out: string[] = [];
    for (const d of scope) {
      const pages = await pagesOf(d);
      const found = pages.map((t, i) => ({ folded: fold(t), text: t, page: i + 1 })).filter((p) => words.every((w) => p.folded.includes(w)));
      if (!found.length) continue;
      out.push("", `[${d.alias}] "${d.name}" (${found.length} page${found.length === 1 ? "" : "s"}):`);
      for (const p of found.slice(0, MAX_PER_DOC)) {
        const [a, b] = findInString(p.text, query.split(/\s+/)[0], 1)[0] ?? [0, 0];
        out.push(`  p. ${p.page}: ${excerpt(p.text, a, b)}`);
      }
      if (found.length > MAX_PER_DOC) out.push(`  … ${found.length - MAX_PER_DOC} more pages`);
    }
    if (out.length) return [`No exact match for "${query}". Pages that contain all of its words:`, ...out].join("\n");
  }
  return `No matches for "${query}"${scope.length === 1 ? ` in [${scope[0].alias}] "${scope[0].name}"` : ""}. Try a shorter query or another word form.`;
}

export async function readPages(docs: ScopeDoc[], args: { doc?: unknown; from?: unknown; to?: unknown }): Promise<string> {
  const d = findDoc(docs, args.doc);
  if (typeof d === "string") return d;
  const pages = await pagesOf(d);
  if (!pages.length) return `[${d.alias}] "${d.name}" has no extracted text (probably a scanned PDF).`;
  const from = Number(args.from);
  const to = args.to === undefined || args.to === null ? from : Number(args.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return "`from` and `to` must be page numbers with 1 ≤ from ≤ to.";
  if (from > pages.length) return `[${d.alias}] "${d.name}" has only ${pages.length} pages.`;
  const last = Math.min(to, pages.length, from + MAX_PAGES_PER_READ - 1);
  const out: string[] = [];
  let size = 0;
  let n = from;
  for (; n <= last; n++) {
    const block = `=== [${d.alias}] "${d.name}", page ${n} ===\n${pages[n - 1] || "(no text on this page)"}`;
    if (out.length && size + block.length > MAX_READ_CHARS) break;
    out.push(block);
    size += block.length;
  }
  const lastShown = n - 1;
  if (lastShown < Math.min(to, pages.length)) out.push(`(Stopped after page ${lastShown} to keep this short; read from page ${lastShown + 1} next.)`);
  else if (to > pages.length) out.push(`(The document ends at page ${pages.length}.)`);
  return out.join("\n\n");
}

const TOOLS = [
  {
    name: "search",
    description:
      "Search the text of the user's documents. Forgiving: accents/umlauts, ß/ss, case, line breaks and hyphenation don't matter. " +
      "Returns matching pages with short excerpts (match in «»). If the exact phrase isn't found, lists pages containing all its words. " +
      "Use it to find where something is discussed, then read those pages with read_pages.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A word or short phrase, e.g. a term or a name." },
        doc: { type: "string", description: "Optional: only this document (its id, e.g. d3). Default: all documents." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_pages",
    description: `Read the exact text of pages of a document (at most ${MAX_PAGES_PER_READ} pages per call).`,
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document id, e.g. d3. Default: the document this chat is about (or the first one)." },
        from: { type: "integer", description: "First page (1-based)." },
        to: { type: "integer", description: "Last page (inclusive). Default: same as from." },
      },
      required: ["from"],
    },
  },
];

// --- JSON-RPC over stdio ---

function serve(docs: ScopeDoc[]) {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let req: { jsonrpc?: string; id?: string | number; method?: string; params?: any };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.id === undefined || req.id === null) return; // a notification
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ydust", version: "1.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};
        try {
          const text = name === "search" ? await search(docs, args) : name === "read_pages" ? await readPages(docs, args) : null;
          if (text === null) return reply({ content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true });
          return reply({ content: [{ type: "text", text }] });
        } catch (err) {
          return reply({ content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
        }
      }
      default:
        return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
    }
  });
}

/** The documents this server may read (from YDUST_DOCS). */
function scopeFromEnv(): ScopeDoc[] {
  try {
    const raw = JSON.parse(process.env.YDUST_DOCS ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((d) => d && typeof d.alias === "string" && typeof d.name === "string" && typeof d.textFile === "string")
      : [];
  } catch {
    return [];
  }
}

if (process.env.YDUST_DOCS !== undefined) serve(scopeFromEnv());
