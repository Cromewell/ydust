/**
 * Highlights: passages the user marked in a colour, one file per document
 * (library/<doc-id>/highlights.json), apart from meta.json so marking and chatting don't
 * compete for the same file. A highlight is anchored by page and text (and which occurrence
 * of that text on the page), like the passages discussed in the chat: it survives zooming,
 * dark pages and a new text extraction.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { docDir, readMeta, withLock, writeAtomic } from "./store.ts";

export const COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type Color = (typeof COLORS)[number];

export type Highlight = {
  id: string;
  page: number;
  text: string;
  /** Which match of `text` on the page (0 = first), when it occurs more than once. */
  occurrence: number;
  color: Color;
  comment?: string;
  createdAt: string;
};

export const MAX_HIGHLIGHTS = 2000;
const MAX_TEXT = 4000;
const MAX_COMMENT = 2000;

export class HighlightError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

export const highlightsPath = (docId: string) => path.join(docDir(docId), "highlights.json");

/**
 * Highlights of a document file. No file: none yet. A file that can't be read is an error,
 * never "none": the next change would otherwise overwrite every highlight in it.
 */
export async function readHighlightsFile(file: string): Promise<Highlight[]> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let raw: { highlights?: Highlight[] };
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`${path.basename(path.dirname(file))}/highlights.json is not valid JSON; fix or remove it (it was left unchanged).`);
  }
  return (Array.isArray(raw.highlights) ? raw.highlights : []).filter((h) => h && typeof h.id === "string" && Number.isInteger(h.page) && typeof h.text === "string");
}

const sorted = (list: Highlight[]) => [...list].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt));

export const listHighlights = async (docId: string) => sorted(await readHighlightsFile(highlightsPath(docId)));

/** Read-modify-write of a document's highlights, one at a time. */
function update<T>(docId: string, fn: (list: Highlight[]) => T): Promise<T> {
  return withLock(`highlights:${docId}`, async () => {
    if (!(await readMeta(docId))) throw new HighlightError("not found", 404);
    const list = await readHighlightsFile(highlightsPath(docId));
    const result = fn(list);
    await writeAtomic(highlightsPath(docId), JSON.stringify({ highlights: sorted(list) }, null, 2));
    return result;
  });
}

const isColor = (c: unknown): c is Color => typeof c === "string" && (COLORS as readonly string[]).includes(c);
const cleanComment = (c: unknown) => {
  if (c === undefined || c === null) return undefined;
  if (typeof c !== "string") throw new HighlightError("`comment` must be text.", 400);
  return c.trim().slice(0, MAX_COMMENT) || undefined;
};

export function addHighlight(docId: string, body: Record<string, unknown>): Promise<Highlight> {
  const { page, text, occurrence = 0, color } = body;
  if (!Number.isInteger(page) || (page as number) < 1) throw new HighlightError("`page` must be a page number.", 400);
  if (typeof text !== "string" || !text.trim()) throw new HighlightError("`text` must be the marked passage.", 400);
  if (text.length > MAX_TEXT) throw new HighlightError("That passage is too long to highlight.", 400);
  if (!Number.isInteger(occurrence) || (occurrence as number) < 0) throw new HighlightError("`occurrence` must be 0 or more.", 400);
  if (!isColor(color)) throw new HighlightError(`\`color\` must be one of ${COLORS.join(", ")}.`, 400);
  const comment = cleanComment(body.comment);
  return update(docId, (list) => {
    if (list.length >= MAX_HIGHLIGHTS) throw new HighlightError(`A document can have at most ${MAX_HIGHLIGHTS} highlights.`, 400);
    const h: Highlight = {
      id: randomUUID(),
      page: page as number,
      text: text.trim().replace(/\s+/g, " "),
      occurrence: occurrence as number,
      color,
      ...(comment ? { comment } : {}),
      createdAt: new Date().toISOString(),
    };
    list.push(h);
    return h;
  });
}

export function patchHighlight(docId: string, hid: string, body: Record<string, unknown>): Promise<Highlight> {
  if (body.color !== undefined && !isColor(body.color)) throw new HighlightError(`\`color\` must be one of ${COLORS.join(", ")}.`, 400);
  const comment = cleanComment(body.comment);
  return update(docId, (list) => {
    const h = list.find((x) => x.id === hid);
    if (!h) throw new HighlightError("Highlight not found.", 404);
    if (isColor(body.color)) h.color = body.color;
    if (body.comment !== undefined) {
      if (comment) h.comment = comment;
      else delete h.comment;
    }
    return h;
  });
}

export function deleteHighlight(docId: string, hid: string): Promise<void> {
  return update(docId, (list) => {
    const i = list.findIndex((x) => x.id === hid);
    if (i === -1) throw new HighlightError("Highlight not found.", 404);
    list.splice(i, 1);
  });
}
