/**
 * Notes: plain Markdown files in a chat's notes/ folder (library/<doc-id>/notes/summary.md,
 * library/folders/<folder-id>/notes/…), so they open in any other editor too.
 *
 * Every save names the version it started from (a hash of the content it loaded). If the
 * file changed meanwhile — another tab, another editor, later an accepted AI draft — the
 * save is refused with the current content instead of silently overwriting it.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isValidNoteName, noteNameProblem, sameNoteName } from "../src/lib/noteNames.ts";
import { chatDir, withLock, writeAtomic, type ChatKind } from "./store.ts";

export const MAX_NOTE_BYTES = 1_000_000;
export const MAX_NOTES = 200;
const TITLE_SCAN = 4_000;

export type NoteInfo = {
  name: string;
  size: number;
  updatedAt: string;
  /** The first Markdown heading, if any. */
  title: string | null;
};
export type Note = NoteInfo & { content: string; version: string };

/** A refused note operation, with the HTTP status it maps to. */
export class NoteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
    /** 409: what the note holds now (null: it no longer exists). */
    readonly current?: { content: string; version: string } | null,
  ) {
    super(message);
  }
}

export const notesDir = (kind: ChatKind, id: string) => path.join(chatDir(kind, id), "notes");

/** Version of a note's content: changes whenever the content does. */
export const versionOf = (content: string) => createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/** The note's path; only a valid plain name, directly inside the notes folder. */
function notePath(dir: string, name: string) {
  const problem = noteNameProblem(name);
  if (problem) throw new NoteError(problem, 400);
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) throw new NoteError("Invalid note name.", 400);
  return file;
}

/** Is the notes folder there? Refuses anything but a plain folder (e.g. a link to elsewhere). */
async function hasDir(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch((err) => (isMissing(err) ? null : Promise.reject(err)));
  if (!info) return false;
  if (!info.isDirectory()) throw new NoteError("The notes folder is not a plain folder.", 400);
  return true;
}

/** Content of a note file, or null if there is none. Links are not followed. */
async function readPlain(file: string): Promise<{ content: string; mtime: Date } | null> {
  const info = await lstat(file).catch((err) => (isMissing(err) ? null : Promise.reject(err)));
  if (!info) return null;
  if (!info.isFile()) throw new NoteError("That note is not a plain file.", 400);
  return { content: await readFile(file, "utf8"), mtime: info.mtime };
}

function titleOf(text: string): string | null {
  const m = text.slice(0, TITLE_SCAN).match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  return m ? m[1].trim().slice(0, 120) : null;
}

async function head(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(TITLE_SCAN);
    const { bytesRead } = await fh.read(buf, 0, TITLE_SCAN, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

const info = (name: string, content: string, mtime: Date): NoteInfo => ({
  name,
  size: Buffer.byteLength(content, "utf8"),
  updatedAt: mtime.toISOString(),
  title: titleOf(content),
});

/** Names of the note files in a folder (plain files with a valid name only). */
async function names(dir: string): Promise<string[]> {
  if (!(await hasDir(dir))) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && isValidNoteName(e.name)).map((e) => e.name);
}

export async function listNotes(kind: ChatKind, id: string): Promise<NoteInfo[]> {
  const dir = notesDir(kind, id);
  const out = await Promise.all(
    (await names(dir)).map(async (name) => {
      const file = path.join(dir, name);
      const st = await lstat(file).catch(() => null);
      if (!st?.isFile()) return null;
      return { name, size: st.size, updatedAt: st.mtime.toISOString(), title: titleOf(await head(file).catch(() => "")) };
    }),
  );
  return out
    .filter((n): n is NoteInfo => n !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

export async function readNote(kind: ChatKind, id: string, name: string): Promise<Note> {
  const dir = notesDir(kind, id);
  const file = notePath(dir, name);
  if (!(await hasDir(dir))) throw new NoteError("Note not found.", 404);
  const got = await readPlain(file);
  if (!got) throw new NoteError("Note not found.", 404);
  return { ...info(name, got.content, got.mtime), content: got.content, version: versionOf(got.content) };
}

/** One change at a time per notes folder (count limit, name clashes, versions). */
const locked = <T>(dir: string, fn: () => Promise<T>) => withLock(`notes:${dir}`, fn);

/**
 * Create (`baseVersion` null) or update a note. Refused with 409 if the note changed since
 * `baseVersion`, or was created meanwhile.
 */
export async function saveNote(kind: ChatKind, id: string, name: string, content: unknown, baseVersion: unknown): Promise<Note> {
  const dir = notesDir(kind, id);
  const file = notePath(dir, name);
  if (typeof content !== "string") throw new NoteError("`content` must be a string.", 400);
  if (baseVersion !== null && typeof baseVersion !== "string") throw new NoteError("`baseVersion` must be a string or null.", 400);
  if (Buffer.byteLength(content, "utf8") > MAX_NOTE_BYTES) throw new NoteError("A note can be at most 1 MB.", 413);

  return locked(dir, async () => {
    if (!(await hasDir(dir))) {
      // Not recursive: if the chat's folder is gone (document deleted), don't bring it back.
      await mkdir(dir).catch((err) => {
        if (isMissing(err)) throw new NoteError("Not found.", 404);
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      });
    }
    const existing = await readPlain(file);
    if (existing === null) {
      if (baseVersion !== null) throw new NoteError("This note was deleted or renamed meanwhile.", 409, null);
      const all = await names(dir);
      if (all.some((n) => sameNoteName(n, name))) throw new NoteError(`A note named "${all.find((n) => sameNoteName(n, name))}" already exists.`, 409);
      if (all.length >= MAX_NOTES) throw new NoteError(`A chat can have at most ${MAX_NOTES} notes.`, 400);
    } else {
      const version = versionOf(existing.content);
      if (baseVersion !== version) {
        throw new NoteError(
          baseVersion === null ? `A note named "${name}" already exists.` : "This note was changed elsewhere meanwhile.",
          409,
          { content: existing.content, version },
        );
      }
      if (existing.content === content) return { ...info(name, content, existing.mtime), content, version };
    }
    await writeAtomic(file, content).catch((err) => {
      throw isMissing(err) ? new NoteError("Not found.", 404) : err;
    });
    return { ...info(name, content, new Date()), content, version: versionOf(content) };
  });
}

export async function renameNote(kind: ChatKind, id: string, from: string, to: unknown): Promise<NoteInfo> {
  const dir = notesDir(kind, id);
  const src = notePath(dir, from);
  if (typeof to !== "string") throw new NoteError("`name` must be a string.", 400);
  const dst = notePath(dir, to);
  return locked(dir, async () => {
    const got = (await hasDir(dir)) ? await readPlain(src) : null;
    if (!got) throw new NoteError("Note not found.", 404);
    if (from !== to) {
      // On Windows and macOS "Summary.md" and "summary.md" are the same file: only a change of case may "clash".
      const clash = (await names(dir)).find((n) => n !== from && sameNoteName(n, to));
      if (clash) throw new NoteError(`A note named "${clash}" already exists.`, 409);
      await rename(src, dst);
    }
    return info(to, got.content, got.mtime);
  });
}

export async function deleteNote(kind: ChatKind, id: string, name: string): Promise<void> {
  const dir = notesDir(kind, id);
  const file = notePath(dir, name);
  return locked(dir, async () => {
    const st = (await hasDir(dir)) ? await lstat(file).catch(() => null) : null;
    if (!st) throw new NoteError("Note not found.", 404);
    if (!st.isFile()) throw new NoteError("That note is not a plain file.", 400);
    await rm(file);
  });
}

/** How many notes a chat has (for delete confirmations). */
export const countNotes = async (kind: ChatKind, id: string) => (await names(notesDir(kind, id)).catch(() => [])).length;
