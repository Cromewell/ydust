/**
 * ydust's tools for the agents, as a tiny MCP server (stdio, newline-delimited JSON-RPC,
 * no dependencies).
 *
 *   search(query, doc?)            forgiving full-text search (accents, ß/ss, hyphenation,
 *                                  case and line breaks don't matter), like the in-app search
 *   read_pages(doc?, from, to?)    exact text of a page range
 *   list_highlights(doc?, color?)  the passages the user marked in colour, with their comments
 *   list_notes()                   the chat's notes: names, sizes, dates, first heading
 *   read_note(name)                the text of one note
 *   write_note(name, content,      proposes a draft for the user to review; never writes the
 *              mode, summary)      note itself (ydust stores the draft, the user accepts it)
 *   approve(tool_name, input)      Claude Code's permission prompt (web turns): allows nothing but
 *                                  a WebSearch whose query the user approved in the app
 *
 * What it may touch comes from ydust, never from the model:
 *   YDUST_DOCS        JSON array of { alias, name, textFile, … } (the first is the default document)
 *   YDUST_NOTES_DIR   the chat's notes folder (read only)
 *   YDUST_API, YDUST_TURN_TOKEN   where to hand drafts and approvals to ydust, valid while this turn runs
 *   YDUST_NOTES_WRITE=0   this turn may not draft notes (a review)
 *   YDUST_WEB=1       this turn may search the web, query by query (adds `approve`)
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createInterface } from "node:readline";
import { findInString, fold } from "../../src/lib/textMatch.ts";
import { cleanLabels, pageLabel, type PageLabels } from "../../src/lib/pageLabels.ts";
import { readHighlightsFile } from "../highlights.ts";
import { NoteError, listNotesIn, readNoteIn } from "../notes.ts";

export type ScopeDoc = { alias: string; name: string; textFile: string; highlightsFile?: string; metaFile?: string };

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

/** " (printed 233)" for a PDF page that prints another number, else "". */
async function printedOf(d: ScopeDoc): Promise<(page: number) => string> {
  let labels: PageLabels;
  try {
    const meta = d.metaFile ? JSON.parse(await readFile(d.metaFile, "utf8")) : null;
    labels = cleanLabels(meta?.pageLabels, meta?.pages);
  } catch {
    /* no labels */
  }
  return (page) => (pageLabel(labels, page) === String(page) ? "" : ` (printed ${pageLabel(labels, page)})`);
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

  type Hit = { page: string; text: string };
  const phrase: { doc: ScopeDoc; hits: Hit[]; count: number }[] = [];
  for (const d of scope) {
    const pages = await pagesOf(d);
    const printed = await printedOf(d);
    const hits: Hit[] = [];
    let count = 0;
    pages.forEach((text, i) => {
      for (const [a, b] of findInString(text, query, 200)) {
        count++;
        if (hits.length < MAX_PER_DOC) hits.push({ page: `${i + 1}${printed(i + 1)}`, text: excerpt(text, a, b) });
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
      const printed = await printedOf(d);
      out.push("", `[${d.alias}] "${d.name}" (${found.length} page${found.length === 1 ? "" : "s"}):`);
      for (const p of found.slice(0, MAX_PER_DOC)) {
        const [a, b] = findInString(p.text, words[0], 1)[0] ?? [0, 0];
        out.push(`  p. ${p.page}${printed(p.page)}: ${excerpt(p.text, a, b)}`);
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
  const printed = await printedOf(d);
  const out: string[] = [];
  let size = 0;
  let n = from;
  for (; n <= last; n++) {
    const block = `=== [${d.alias}] "${d.name}", page ${n}${printed(n)} ===\n${pages[n - 1] || "(no text on this page)"}`;
    if (out.length && size + block.length > MAX_READ_CHARS) break;
    out.push(block);
    size += block.length;
  }
  const lastShown = n - 1;
  if (lastShown < Math.min(to, pages.length)) out.push(`(Stopped after page ${lastShown} to keep this short; read from page ${lastShown + 1} next.)`);
  else if (to > pages.length) out.push(`(The document ends at page ${pages.length}.)`);
  return out.join("\n\n");
}

const COLORS = ["yellow", "green", "blue", "pink", "orange"];

export async function listHighlightsTool(
  docs: ScopeDoc[],
  args: { doc?: unknown; color?: unknown },
  labels: Record<string, string> = {},
): Promise<string> {
  let scope = docs;
  if (args.doc !== undefined && args.doc !== null && args.doc !== "") {
    const d = findDoc(docs, args.doc);
    if (typeof d === "string") return d;
    scope = [d];
  }
  const rawColor = typeof args.color === "string" && args.color.trim() ? args.color.trim().toLowerCase() : null;
  let color: string | null = null;
  if (rawColor) {
    color =
      COLORS.find((c) => c === rawColor) ??
      COLORS.find((c) => labels[c] && fold(labels[c]) === fold(rawColor)) ??
      null;
    if (!color) {
      const names = COLORS.map((c) => (labels[c] ? `${c} (${labels[c]})` : c)).join(", ");
      return `\`color\` must be one of ${names}.`;
    }
  }
  const tag = (c: string) => (labels[c] ? `${c} · ${labels[c]}` : c);
  const out: string[] = [];
  let total = 0;
  for (const d of scope) {
    if (!d.highlightsFile) continue;
    const list = await readHighlightsFile(d.highlightsFile).catch(() => null);
    if (!list) {
      out.push("", `[${d.alias}] "${d.name}": its highlights could not be read.`);
      continue;
    }
    const shown = list.filter((h) => !color || h.color === color).sort((a, b) => a.page - b.page);
    if (!shown.length) continue;
    total += shown.length;
    out.push("", `[${d.alias}] "${d.name}" (${shown.length}):`);
    const printed = await printedOf(d);
    for (const h of shown) out.push(`  p. ${h.page}${printed(h.page)} (${tag(h.color)}): «${oneLine(h.text).slice(0, 600)}»${h.comment ? ` — my comment: ${oneLine(h.comment)}` : ""}`);
  }
  if (!total && out.length) return out.join("\n").trim();
  if (!total) return `No highlights${color ? ` in ${tag(color)}` : ""}${scope.length === 1 ? ` in [${scope[0].alias}] "${scope[0].name}"` : ""}.`;
  return [`${total} highlight${total === 1 ? "" : "s"}${color ? ` in ${tag(color)}` : ""}:`, ...out].join("\n");
}

const DOC_TOOLS = [
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
        from: { type: "integer", description: "First page (1-based, the PDF's count of pages)." },
        to: { type: "integer", description: "Last page (inclusive). Default: same as from." },
      },
      required: ["from"],
    },
  },
  {
    name: "list_highlights",
    description:
      "List the passages the user highlighted in the documents (page, colour, text, their comment). Useful for \"quiz me on what I marked\" or summaries of the user's marks.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Optional: only this document (its id, e.g. d3). Default: all documents." },
        color: { type: "string", enum: COLORS, description: "Optional: only highlights in this colour." },
      },
    },
  },
];

// --- Notes ---

/** The chat's notes; `api` + `token` reach ydust (drafts, approvals); `write: false` = no drafts this turn. */
export type NotesScope = { dir: string; api?: string; token?: string; write?: boolean };
const MAX_NOTE_READ = 100_000;

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export async function listNotesTool(scope: NotesScope): Promise<string> {
  const notes = await listNotesIn(scope.dir);
  if (!notes.length) return "There are no notes yet.";
  return [
    `${notes.length} note${notes.length === 1 ? "" : "s"}:`,
    ...notes.map((n) => `- ${n.name} (${kb(n.size)}, edited ${n.updatedAt.slice(0, 10)})${n.title ? `: # ${n.title}` : ""}`),
  ].join("\n");
}

/** Versions of the notes read in this turn: "replace" is only accepted for a note read as it is now. */
const readVersions = new Map<string, string>();

export async function readNoteTool(scope: NotesScope, args: { name?: unknown }): Promise<string> {
  if (typeof args.name !== "string") return "`name` must be the note's file name, e.g. summary.md (see list_notes).";
  try {
    const note = await readNoteIn(scope.dir, args.name);
    readVersions.set(note.name, note.version);
    const text = note.content.length > MAX_NOTE_READ ? `${note.content.slice(0, MAX_NOTE_READ)}\n\n(The note continues: ${note.content.length - MAX_NOTE_READ} more characters not shown.)` : note.content;
    return `=== Note ${note.name} ===\n${text || "(empty)"}`;
  } catch (err) {
    if (err instanceof NoteError) return `${err.message} ${err.status === 404 ? "list_notes shows the existing notes." : ""}`.trim();
    throw err;
  }
}

export async function writeNoteTool(scope: NotesScope, args: { name?: unknown; content?: unknown; mode?: unknown; summary?: unknown }): Promise<{ text: string; error: boolean }> {
  if (!scope.api || !scope.token) return { text: "Writing notes is not available in this conversation.", error: true };
  const res = await fetch(`${scope.api}/api/internal/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: scope.token,
      target: args.name,
      mode: args.mode,
      content: args.content,
      summary: args.summary,
      readVersion: typeof args.name === "string" ? readVersions.get(args.name) : undefined,
    }),
  }).catch((err: Error) => ({ ok: false, status: 0, json: async () => ({ error: `ydust is not reachable (${err.message}).` }) }));
  const body = (await res.json().catch(() => ({}))) as { error?: string; target?: string; mode?: string; revision?: number };
  if (!res.ok) return { text: `The draft was not saved: ${body.error ?? `error ${res.status}`}`, error: true };
  const what = body.mode === "create" ? `a new note "${body.target}"` : body.mode === "append" ? `an addition to "${body.target}"` : `a new version of "${body.target}"`;
  return {
    text:
      `Saved as a draft for review: ${what}${body.revision && body.revision > 1 ? ` (version ${body.revision})` : ""}. Nothing is written yet: ` +
      `the user sees the draft as a diff under your answer and accepts it, asks for changes, or discards it. ` +
      `Don't repeat the draft's text in your answer; say in a sentence or two what you drafted.`,
    error: false,
  };
}

const NOTE_TOOLS = [
  {
    name: "list_notes",
    description: "List the user's notes for this chat (Markdown files): name, size, last edit and first heading of each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_note",
    description: "Read the full text of one of the user's notes.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The note's file name, e.g. summary.md (from list_notes)." } },
      required: ["name"],
    },
  },
];

const WRITE_TOOL = {
  name: "write_note",
  description:
    "Propose text for one of the user's notes (Markdown with $…$ math and page links like [p. 12](#page=12)). It is saved as a draft that the user " +
    "reviews as a diff and accepts or rejects; nothing changes until they accept. Call list_notes first and pick the note that fits; create a new " +
    "note only if none does. mode: create (a new note), append (add to the end of an existing note), replace (the whole new text of an existing " +
    "note: only after read_note, and keep what the user wrote unless asked otherwise).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "File name: short and descriptive, letters/digits/spaces/._- only, ending in .md, e.g. \"Exercises chapter 3.md\"." },
      content: { type: "string", description: "The Markdown text: the whole note (create, replace) or the part to add (append)." },
      mode: { type: "string", enum: ["create", "append", "replace"] },
      summary: { type: "string", description: "One line for the user: what this draft is." },
    },
    required: ["name", "content", "mode", "summary"],
  },
};

// --- Web search approval (Claude Code's --permission-prompt-tool) ---

/** POST JSON and wait for the answer: node:http, because fetch gives up after 5 minutes without a reply. */
function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: {} });
        }
      });
    });
    req.on("error", reject);
    // ydust answers within 5 minutes; this only guards against a server that hangs.
    req.setTimeout(6 * 60_000, () => req.destroy(new Error("no answer from ydust")));
    req.end(data);
  });
}

const deny = (message: string) => JSON.stringify({ behavior: "deny", message });

/**
 * Claude Code asks this before any tool that isn't pre-approved. Only a WebSearch can be
 * allowed, and only by the user (in the app, possibly with an edited query); everything else
 * is denied at once.
 */
export async function approveTool(scope: NotesScope, args: { tool_name?: unknown; input?: unknown }): Promise<string> {
  if (args.tool_name !== "WebSearch") return deny(`${typeof args.tool_name === "string" ? args.tool_name : "That tool"} is not available in ydust.`);
  const input = (args.input && typeof args.input === "object" ? args.input : {}) as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return deny("Empty search query.");
  if (!scope.api || !scope.token) return deny("Web search is not available in this conversation.");
  try {
    const r = await postJson(`${scope.api}/api/internal/approvals`, { token: scope.token, kind: "web-search", query });
    if (r.status !== 200) return deny(`ydust couldn't ask the user (status ${r.status}).`);
    const approved = typeof r.json.query === "string" ? r.json.query.trim() : "";
    // Exactly what the user saw and allowed: the query, nothing else the model put into the input.
    if (r.json.decision === "allow" && approved) return JSON.stringify({ behavior: "allow", updatedInput: { query: approved } });
    return deny(
      r.json.reason === "timeout"
        ? "The user didn't answer the request to search the web. Answer from the documents, and say what a search could have added."
        : "The user declined this web search. Answer from the documents (say so if they don't cover it), or ask the user before searching for something else.",
    );
  } catch (err) {
    return deny(`ydust is not reachable (${(err as Error).message}).`);
  }
}

const APPROVE_TOOL = {
  name: "approve",
  description: "Permission prompt for ydust (used by the CLI, not by you).",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
};

/** The tools available with these documents and notes (and web search, for a web turn). */
export function toolsFor(docs: ScopeDoc[], notes: NotesScope | null, opts: { web?: boolean; highlightLabels?: Record<string, string> } = {}) {
  const reach = !!(notes?.api && notes.token);
  const hlEntries = Object.entries(opts.highlightLabels ?? {}).filter(([k, v]) => COLORS.includes(k) && v);
  const docTools = docs.length
    ? DOC_TOOLS.map((t) =>
        t.name === "list_highlights" && hlEntries.length
          ? { ...t, description: `${t.description} User's colour labels: ${hlEntries.map(([c, l]) => `${c} = ${l}`).join(", ")}.` }
          : t,
      )
    : [];
  return [
    ...docTools,
    ...(notes ? NOTE_TOOLS : []),
    ...(reach && notes!.write !== false ? [WRITE_TOOL] : []),
    ...(reach && opts.web ? [APPROVE_TOOL] : []),
  ];
}

// --- JSON-RPC over stdio ---

function serve(docs: ScopeDoc[], notes: NotesScope | null, web: boolean, highlightLabels: Record<string, string>) {
  const tools = toolsFor(docs, notes, { web, highlightLabels });
  const has = (name: string) => tools.some((t) => t.name === name);
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
        return reply({ tools });
      case "tools/call": {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};
        try {
          if (typeof name !== "string" || !has(name)) return reply({ content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true });
          if (name === "approve") return reply({ content: [{ type: "text", text: await approveTool(notes!, args) }] });
          if (name === "write_note") {
            const r = await writeNoteTool(notes!, args);
            return reply({ content: [{ type: "text", text: r.text }], ...(r.error ? { isError: true } : {}) });
          }
          const text =
            name === "search"
              ? await search(docs, args)
              : name === "read_pages"
                ? await readPages(docs, args)
                : name === "list_highlights"
                  ? await listHighlightsTool(docs, args, highlightLabels)
                : name === "list_notes"
                  ? await listNotesTool(notes!)
                  : await readNoteTool(notes!, args);
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
      ? raw.filter((d) => d && typeof d.alias === "string" && typeof d.name === "string" && typeof d.textFile === "string" && (d.highlightsFile === undefined || typeof d.highlightsFile === "string") && (d.metaFile === undefined || typeof d.metaFile === "string"))
      : [];
  } catch {
    return [];
  }
}

function notesFromEnv(): NotesScope | null {
  const dir = process.env.YDUST_NOTES_DIR;
  if (!dir) return null;
  return { dir, api: process.env.YDUST_API || undefined, token: process.env.YDUST_TURN_TOKEN || undefined, write: process.env.YDUST_NOTES_WRITE !== "0" };
}

function highlightLabelsFromEnv(): Record<string, string> {
  try {
    const raw = JSON.parse(process.env.YDUST_HL_LABELS ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (COLORS.includes(k) && typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

if (process.env.YDUST_DOCS !== undefined || process.env.YDUST_NOTES_DIR !== undefined) {
  serve(scopeFromEnv(), notesFromEnv(), process.env.YDUST_WEB === "1", highlightLabelsFromEnv());
}
