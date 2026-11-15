/**
 * Drafts: what the assistant wants to write into a note, waiting for the user's review.
 * The assistant never writes a note itself: write_note (ydust's MCP tool) ends up here, as
 * notes/.drafts/<id>.json. Only accepting a draft (a click in the app) changes the note.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { noteNameProblem, sameNoteName } from "../src/lib/noteNames.ts";
import { appendBlock } from "../src/lib/noteText.ts";
import { MAX_NOTES, NoteError, listNotesIn, notesDir, readNoteIn, saveNote, type Note } from "./notes.ts";
import { withLock, writeAtomic, type ChatKind } from "./store.ts";

export const MAX_DRAFT_BYTES = 200_000;
export const MAX_DRAFTS = 20;
const MAX_AGE_MS = 30 * 24 * 3600_000;
const MAX_SUMMARY = 300;

export const DRAFT_MODES = ["create", "append", "replace"] as const;
export type DraftMode = (typeof DRAFT_MODES)[number];

export type Draft = {
  id: string;
  /** The note it is for. */
  target: string;
  mode: DraftMode;
  content: string;
  /** One line from the assistant: what it drafted. */
  summary: string;
  provider?: string;
  /** Version of the note the draft was made against (null: a new note). */
  baseVersion: string | null;
  /** 1, or one more than the draft it revises ("Request changes"). */
  revision: number;
  replaces?: string;
  /** "superseded": a newer revision exists (kept so the card can show it). */
  status: "open" | "superseded";
  createdAt: string;
};
export type DraftInfo = Omit<Draft, "content">;

const ID_RE = /^[0-9a-f-]{36}$/;
export const draftsDir = (kind: ChatKind, id: string) => path.join(notesDir(kind, id), ".drafts");
const fileOf = (dir: string, did: string) => {
  if (!ID_RE.test(did)) throw new NoteError("Draft not found.", 404);
  return path.join(dir, `${did}.json`);
};
const info = ({ content: _, ...rest }: Draft): DraftInfo => rest;
const lockKey = (dir: string) => `drafts:${dir}`;

async function readDraft(dir: string, did: string): Promise<Draft | null> {
  try {
    return JSON.parse(await readFile(fileOf(dir, did), "utf8")) as Draft;
  } catch (err) {
    if (err instanceof NoteError) throw err;
    return null;
  }
}

async function allDrafts(dir: string): Promise<Draft[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const drafts = await Promise.all(files.filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => readDraft(dir, f.slice(0, -5))));
  return drafts.filter((d): d is Draft => d !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const currentNote = (notes: string, name: string): Promise<Note | null> =>
  readNoteIn(notes, name).catch((err) => {
    if (err instanceof NoteError && err.status === 404) return null;
    throw err;
  });

export type DraftInput = {
  target: unknown;
  mode: unknown;
  content: unknown;
  summary: unknown;
  /** replace: version of the note the assistant read (it must still be the current one). */
  readVersion?: unknown;
  provider?: string;
  /** The draft this one revises (a "Request changes" turn). */
  replaces?: string | null;
};

/** Check and store a draft. Refusals are messages for the assistant (it can fix and retry). */
export async function createDraft(kind: ChatKind, id: string, input: DraftInput): Promise<Draft> {
  const notes = notesDir(kind, id);
  const dir = draftsDir(kind, id);
  const { target, mode, content } = input;
  const problem = noteNameProblem(target);
  if (problem) throw new NoteError(`Invalid note name: ${problem}`, 400);
  if (typeof mode !== "string" || !DRAFT_MODES.includes(mode as DraftMode)) throw new NoteError("`mode` must be create, append or replace.", 400);
  if (typeof content !== "string" || !content.trim()) throw new NoteError("`content` must be the note text.", 400);
  if (Buffer.byteLength(content, "utf8") > MAX_DRAFT_BYTES) throw new NoteError("A draft can be at most 200 kB: split it, or write a shorter note.", 413);
  const summary = (typeof input.summary === "string" ? input.summary : "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY);
  const name = target as string;

  return withLock(lockKey(dir), async () => {
    const current = await currentNote(notes, name);
    const all = await listNotesIn(notes);
    if (mode === "create") {
      const clash = all.find((n) => sameNoteName(n.name, name));
      if (clash) throw new NoteError(`A note named "${clash.name}" already exists. Use mode "append", or read it and use "replace", or choose another name.`, 409);
      if (all.length >= MAX_NOTES) throw new NoteError(`This chat already has ${MAX_NOTES} notes: add to an existing one instead.`, 400);
    } else {
      if (!current) throw new NoteError(`There is no note named "${name}". Use mode "create" for a new note (list_notes shows the existing ones).`, 404);
      if (mode === "replace" && input.readVersion !== current.version) {
        throw new NoteError(`Read "${name}" with read_note first (it may have changed since): replace needs its current text.`, 409);
      }
    }

    let revision = 1;
    let replaces: string | undefined;
    if (input.replaces) {
      const prev = await readDraft(dir, input.replaces);
      if (prev) {
        revision = prev.revision + 1;
        replaces = prev.id;
        await writeAtomic(fileOf(dir, prev.id), JSON.stringify({ ...prev, status: "superseded" }, null, 2));
      }
    }

    // Room for it: drop drafts nobody looked at for a month, then the oldest beyond the cap.
    await mkdir(notes).catch((err) => {
      if (err.code === "ENOENT") throw new NoteError("Not found.", 404);
      if (err.code !== "EEXIST") throw err;
    });
    await mkdir(dir, { recursive: true });
    const existing = await allDrafts(dir);
    const old = existing.filter((d) => Date.now() - new Date(d.createdAt).getTime() > MAX_AGE_MS);
    const keep = existing.filter((d) => !old.includes(d) && d.id !== replaces);
    const drop = [...old, ...keep.slice(0, Math.max(0, keep.length - (MAX_DRAFTS - 1)))];
    await Promise.all(drop.map((d) => rm(fileOf(dir, d.id), { force: true })));

    const draft: Draft = {
      id: randomUUID(),
      target: name,
      mode: mode as DraftMode,
      content,
      summary,
      provider: input.provider,
      baseVersion: current?.version ?? null,
      revision,
      replaces,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    await writeAtomic(fileOf(dir, draft.id), JSON.stringify(draft, null, 2));
    return draft;
  });
}

export async function listDrafts(kind: ChatKind, id: string): Promise<DraftInfo[]> {
  return (await allDrafts(draftsDir(kind, id))).map(info);
}

/** A draft, with the note as it is now (to show the diff against). */
export async function getDraft(kind: ChatKind, id: string, did: string): Promise<Draft & { current: { content: string; version: string } | null }> {
  const draft = await readDraft(draftsDir(kind, id), did);
  if (!draft) throw new NoteError("This draft no longer exists.", 404);
  const note = await currentNote(notesDir(kind, id), draft.target);
  return { ...draft, current: note && { content: note.content, version: note.version } };
}

/** The draft and the revisions before it. */
async function dropChain(dir: string, draft: Draft) {
  const seen = new Set<string>();
  for (let d: Draft | null = draft; d && !seen.has(d.id); d = d.replaces ? await readDraft(dir, d.replaces) : null) {
    seen.add(d.id);
    await rm(fileOf(dir, d.id), { force: true });
  }
  return [...seen];
}

/** Throw the draft away (and its earlier revisions). Returns the ids removed. */
export async function discardDraft(kind: ChatKind, id: string, did: string): Promise<string[]> {
  const dir = draftsDir(kind, id);
  return withLock(lockKey(dir), async () => {
    const draft = await readDraft(dir, did);
    if (!draft) throw new NoteError("This draft no longer exists.", 404);
    return dropChain(dir, draft);
  });
}

/**
 * Write a draft into its note. `base` is the version of the note the user saw the diff
 * against: if the note changed since, 409 with its current content (the card shows the new
 * diff and asks again). `target` sends a new note under another name, or an addition to
 * another existing note.
 */
export async function acceptDraft(
  kind: ChatKind,
  id: string,
  did: string,
  body: { target?: unknown; base?: unknown },
): Promise<{ target: string; mode: DraftMode; version: string; removed: string[] }> {
  const dir = draftsDir(kind, id);
  const notes = notesDir(kind, id);
  return withLock(lockKey(dir), async () => {
    const draft = await readDraft(dir, did);
    if (!draft) throw new NoteError("This draft no longer exists.", 404);
    if (draft.status !== "open") throw new NoteError("A newer version of this draft exists.", 409);
    const target = body.target === undefined || body.target === null ? draft.target : body.target;
    if (typeof target !== "string") throw new NoteError("`target` must be a note name.", 400);
    if (target !== draft.target) {
      if (draft.mode === "replace") throw new NoteError("A replacement can only go into the note it was written for.", 400);
      const problem = noteNameProblem(target);
      if (problem) throw new NoteError(problem, 400);
    }
    const current = await currentNote(notes, target);
    let saved: Note;
    if (draft.mode === "create") {
      if (current) throw new NoteError(`A note named "${target}" already exists.`, 409, { content: current.content, version: current.version });
      saved = await saveNote(kind, id, target, draft.content, null);
    } else {
      if (!current) throw new NoteError(`There is no note named "${target}" (any more).`, 404);
      const base = typeof body.base === "string" ? body.base : null;
      if (base !== current.version) throw new NoteError("The note changed since this diff was made.", 409, { content: current.content, version: current.version });
      saved = await saveNote(kind, id, target, draft.mode === "append" ? appendBlock(current.content, draft.content) : draft.content, current.version);
    }
    const removed = await dropChain(dir, draft);
    return { target, mode: draft.mode, version: saved.version, removed };
  });
}

/** "Reset chat": open drafts go, notes stay. */
export const clearDrafts = (kind: ChatKind, id: string) => rm(draftsDir(kind, id), { recursive: true, force: true });
