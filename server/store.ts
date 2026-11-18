import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Where apps keep per-user data on this OS. */
function dataHome() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
}

/** Where ydust kept its data before 0.2: inside the app's folder (used as long as it exists). */
export const LEGACY_LIBRARY_DIR = path.resolve("library");
/**
 * The library lives outside the app's folder: there, a `git clean` can't delete it, and the
 * CLIs, started inside it, don't pick up the repository's CLAUDE.md or git status.
 */
export const DEFAULT_LIBRARY_DIR = path.join(dataHome(), "ydust");
export const LIBRARY_DIR = path.resolve(process.env.YDUST_LIBRARY ?? (existsSync(LEGACY_LIBRARY_DIR) ? LEGACY_LIBRARY_DIR : DEFAULT_LIBRARY_DIR));
/** Still using the old library inside the app's folder (index.ts explains how to move it). */
export const LIBRARY_IN_APP_FOLDER = !process.env.YDUST_LIBRARY && LIBRARY_DIR === LEGACY_LIBRARY_DIR;
const FOLDERS_DIR = path.join(LIBRARY_DIR, "folders");
const STATE_PATH = path.join(LIBRARY_DIR, "state.json");

/** A selected passage. `doc` = the document it is from (always set in folder chats). */
export type Quote = { text: string; page: number; doc?: string };

export const ASK_MODES = ["check", "review-note", "challenge-note", "fix-note"] as const;
export type AskMode = (typeof ASK_MODES)[number];
export type NoteRef = { name: string; lines?: [number, number]; instructions?: string };

/** A draft the assistant proposed in an answer (the content lives in notes/.drafts/ until decided). */
export type MessageDraft = {
  id: string;
  target: string;
  mode: "create" | "append" | "replace";
  summary: string;
  revision: number;
  replaces?: string;
  /** Unset while open. */
  status?: "accepted" | "discarded" | "superseded";
  /** The note it went into (accepted). */
  acceptedAs?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  quote?: Quote;
  /** Image ids (files in the chat's images/ folder) attached to a user message. */
  images?: string[];
  /** Assistant messages: which CLI (and model) answered. */
  provider?: string;
  /** Full model id that answered, and its display name. */
  model?: string;
  modelLabel?: string;
  /** Reasoning effort used (chosen, or the CLI's configured default). */
  effort?: string;
  /**
   * User messages: "check" = I explain it in my own words, the assistant checks it;
   * "review-note" / "challenge-note" = check my note against the documents / quiz me on it;
   * "fix-note" = draft the fixes the review found (as a replace draft).
   */
  mode?: AskMode;
  /** User messages (review-note, challenge-note): which note, which lines, and my extra instructions. */
  noteRef?: NoteRef;
  /** User messages: asks for a second opinion on this assistant message. */
  secondOpinionOf?: string;
  /** User messages: asks for changes to this draft ("Request changes"). */
  draftRef?: { id: string; target: string; revision: number };
  /** Assistant messages: note drafts proposed in this answer. */
  drafts?: MessageDraft[];
  /** User messages: web search was on for this question. */
  web?: boolean;
  /** User messages: one of the app's built-in English prompts (Explain, a starter, …), not typed. */
  preset?: boolean;
  /** Assistant messages: the CLI's earlier session was gone, so this answer started a new one. */
  newSession?: boolean;
  /** Assistant messages: the web searches the user allowed (with the query as it was run). */
  webQueries?: string[];
  /** Assistant messages: pinned to the notes, with an optional own note. */
  pinned?: boolean;
  note?: string;
  error?: boolean;
  stopped?: boolean;
  createdAt: string;
};

/** What a chat (of one document, or of a whole folder) keeps. */
export type ChatData = {
  messages: Message[];
  /** CLI session id per provider ("agy" → conversation id, "claude" → session id). */
  conversations: Record<string, string>;
  /** Provider.sessionTag each session was started with (a session with another tag isn't resumed). */
  sessionTags?: Record<string, string>;
  /** Per provider: signature of the folder context that session was last told about. */
  contextSigs?: Record<string, string>;
  /** Per provider: version of ydust's document tools that session was told about. */
  toolsVersion?: Record<string, number>;
};

/** A chat's messages and CLI sessions, in chat.json next to meta.json / folder.json. */
export const CHAT_KEYS = ["messages", "conversations", "sessionTags", "contextSigs", "toolsVersion"] as const;

export type DocMeta = {
  id: string;
  name: string;
  /** Short, stable, never reused id the agent uses in citations ("d7"). */
  alias?: string;
  size: number;
  pages: number | null;
  /** null = text not extracted yet, false = PDF has (almost) no text layer, e.g. a scan */
  hasText: boolean | null;
  /** Version of the client's text extraction that produced document.txt (re-extract when outdated). */
  textVersion?: number;
  lastPage: number;
  /** Number of messages in its chat (kept here, so listing the library doesn't read every chat). */
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type DocSummary = Omit<DocMeta, "messageCount"> & { messageCount: number; folderId: string | null };

export type FolderMeta = {
  id: string;
  name: string;
  /** Member documents, in the order they were added. */
  docIds: string[];
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
};
export type FolderSummary = Omit<FolderMeta, "messageCount"> & { messageCount: number };

export type ChatKind = "doc" | "folder";

/** The document or folder doesn't exist (any more): a 404 for the API. */
export class NotFoundError extends Error {}

const ID_RE = /^[0-9a-f-]{36}$/;

export function isValidId(id: string) {
  return ID_RE.test(id);
}

export function docDir(id: string) {
  if (!isValidId(id)) throw new Error("invalid document id");
  return path.join(LIBRARY_DIR, id);
}

export function folderDir(id: string) {
  if (!isValidId(id)) throw new Error("invalid folder id");
  return path.join(FOLDERS_DIR, id);
}

/** Folder the chat's files (meta, images) live in; also the agent's working directory. */
export const chatDir = (kind: ChatKind, id: string) => (kind === "doc" ? docDir(id) : folderDir(id));

export const pdfPath = (id: string) => path.join(docDir(id), "document.pdf");
export const textPath = (id: string) => path.join(docDir(id), "document.txt");
export const outlinePath = (id: string) => path.join(docDir(id), "outline.txt");
const metaPath = (id: string) => path.join(docDir(id), "meta.json");
const folderMetaPath = (id: string) => path.join(folderDir(id), "folder.json");
const chatPath = (kind: ChatKind, id: string) => path.join(chatDir(kind, id), "chat.json");

// --- Images (per chat) ---

export const imagesDir = (dir: string) => path.join(dir, "images");

const IMAGE_ID_RE = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
export const isValidImageId = (img: string) => IMAGE_ID_RE.test(img);
export function imagePath(dir: string, img: string) {
  if (!isValidImageId(img)) throw new Error("invalid image id");
  return path.join(imagesDir(dir), img);
}

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Detect the image type from its first bytes (don't trust the client's MIME type). */
export function sniffImage(b: Uint8Array): keyof typeof IMAGE_TYPES | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "webp";
  return null;
}

export async function saveImage(dir: string, data: Uint8Array): Promise<string | null> {
  const ext = sniffImage(data);
  if (!ext) return null;
  const img = `${randomUUID()}.${ext}`;
  await mkdir(imagesDir(dir), { recursive: true });
  await writeFile(path.join(imagesDir(dir), img), data);
  return img;
}

/** Remove all attached pictures of a chat (after it was cleared). */
export async function clearImages(dir: string) {
  await rm(imagesDir(dir), { recursive: true, force: true });
}

// --- JSON files: atomic writes, serialized read-modify-write ---

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write atomically so a crash mid-write never leaves a half-written file. */
export async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, data);
  // On Windows, a virus scanner or the search indexer may hold the target open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

const writeJson = (file: string, value: unknown) => writeAtomic(file, JSON.stringify(value, null, 2));

const locks = new Map<string, Promise<unknown>>();
/** Run `fn` after every earlier call with the same key has finished. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// --- Documents ---

export function summarize(meta: DocMeta, folderId: string | null = null): DocSummary {
  return { ...meta, messageCount: meta.messageCount ?? 0, folderId };
}

/** What a meta.json / folder.json from before chat.json still holds of its chat. */
type Legacy = Partial<ChatData> & { conversationId?: string | null };

/** The chat fields of an old meta file (migrated to chat.json by migrateChats or the next chat write). */
function legacyChat(raw: Legacy): ChatData {
  return {
    messages: raw.messages ?? [],
    conversations: raw.conversations ?? (raw.conversationId ? { agy: raw.conversationId } : {}),
    ...(raw.sessionTags ? { sessionTags: raw.sessionTags } : {}),
    ...(raw.contextSigs ? { contextSigs: raw.contextSigs } : {}),
    ...(raw.toolsVersion ? { toolsVersion: raw.toolsVersion } : {}),
  };
}
const hasLegacyChat = (raw: object) => [...CHAT_KEYS, "conversationId"].some((k) => k in raw);

/** Metadata without the chat fields an old file may still carry. */
function withoutChat<T extends object>(raw: T & Legacy): T {
  const out = { ...raw } as Record<string, unknown>;
  for (const k of [...CHAT_KEYS, "conversationId"]) delete out[k];
  if (out.messageCount === undefined && Array.isArray(raw.messages)) out.messageCount = raw.messages.length;
  return out as T;
}

/** A document's metadata (small: name, pages, …). Its chat is in readChat. */
export async function readMeta(id: string): Promise<DocMeta | null> {
  const raw = await readJson<DocMeta & Legacy>(metaPath(id));
  return raw && withoutChat<DocMeta>(raw);
}

export async function writeMeta(meta: DocMeta) {
  meta.updatedAt = new Date().toISOString();
  await writeJson(metaPath(meta.id), withoutChat<DocMeta>(meta));
}

/** Serialize read-modify-write cycles per document (its chat shares the lock). */
export function updateMeta(id: string, fn: (meta: DocMeta) => void | Promise<void>) {
  return withLock(`doc:${id}`, async () => {
    const meta = await readMeta(id);
    if (!meta) throw new NotFoundError("document not found");
    await fn(meta);
    await writeMeta(meta);
    return meta;
  });
}

async function allMetas(): Promise<DocMeta[]> {
  await mkdir(LIBRARY_DIR, { recursive: true });
  const entries = await readdir(LIBRARY_DIR, { withFileTypes: true });
  const metas = await Promise.all(entries.filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => readMeta(e.name)));
  return metas.filter((m): m is DocMeta => m !== null);
}

export async function listDocs(): Promise<DocSummary[]> {
  const [metas, folders] = await Promise.all([allMetas(), allFolders()]);
  const folderOf = new Map(folders.flatMap((f) => f.docIds.map((d) => [d, f.id] as const)));
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((m) => summarize(m, folderOf.get(m.id) ?? null));
}

/** Next short alias ("d1", "d2", …). Never reused, so old citations can't point at another document. */
function nextAlias(): Promise<string> {
  return withLock("state", async () => {
    const state = (await readJson<{ nextAlias?: number }>(STATE_PATH)) ?? {};
    const n = state.nextAlias ?? 1;
    await writeJson(STATE_PATH, { ...state, nextAlias: n + 1 });
    return `d${n}`;
  });
}

/** Give documents from before aliases existed one (oldest first). Run once at startup. */
export async function ensureAliases() {
  const metas = await allMetas();
  const highest = Math.max(0, ...metas.map((m) => Number(m.alias?.slice(1)) || 0));
  await withLock("state", async () => {
    const state = (await readJson<{ nextAlias?: number }>(STATE_PATH)) ?? {};
    if ((state.nextAlias ?? 1) <= highest) await writeJson(STATE_PATH, { ...state, nextAlias: highest + 1 });
  });
  for (const m of metas.filter((m) => !m.alias).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const alias = await nextAlias();
    await updateMeta(m.id, (x) => void (x.alias ??= alias));
  }
}

export async function createDoc(name: string, data: Uint8Array): Promise<DocMeta> {
  const id = randomUUID();
  await mkdir(docDir(id), { recursive: true });
  await writeFile(pdfPath(id), data);
  const now = new Date().toISOString();
  const meta: DocMeta = {
    id,
    name,
    alias: await nextAlias(),
    size: data.byteLength,
    pages: null,
    hasText: null,
    lastPage: 1,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(meta);
  return meta;
}

export async function deleteDoc(id: string) {
  await setDocFolder(id, null);
  await withLock(`doc:${id}`, () => rm(docDir(id), { recursive: true, force: true }));
  locks.delete(`doc:${id}`);
}

// --- Document text and outline ---

const PAGE_MARKER = (n: number) => `=== Page ${n} ===`;

/** Save the extracted text (and the outline, a few lines like "p. 12  Chapter 2 …"). */
export async function writeText(id: string, pages: string[], outline?: string) {
  const body = pages.map((t, i) => `${PAGE_MARKER(i + 1)}\n${t.trim()}\n`).join("\n");
  // Atomically: ydust's MCP server may be reading it for a running answer.
  await writeAtomic(textPath(id), body);
  if (outline?.trim()) await writeAtomic(outlinePath(id), outline.trim() + "\n");
  else await rm(outlinePath(id), { force: true });
}

export async function readOutline(id: string): Promise<string | null> {
  return readFile(outlinePath(id), "utf8").catch(() => null);
}

/** All pages of document.txt (index 0 = page 1). */
export async function readAllPages(id: string): Promise<string[] | null> {
  let body: string;
  try {
    body = await readFile(textPath(id), "utf8");
  } catch {
    return null;
  }
  return body
    .split(/^=== Page \d+ ===$/m)
    .slice(1)
    .map((p) => p.trim());
}

export async function readPageText(id: string, page: number): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(textPath(id), "utf8");
  } catch {
    return null;
  }
  const start = body.indexOf(PAGE_MARKER(page));
  if (start === -1) return null;
  const from = start + PAGE_MARKER(page).length;
  const end = body.indexOf(PAGE_MARKER(page + 1), from);
  return body.slice(from, end === -1 ? undefined : end).trim();
}

// --- Folders ---

export function summarizeFolder(f: FolderMeta): FolderSummary {
  return { ...f, messageCount: f.messageCount ?? 0 };
}

/** A folder's metadata (name, documents). Its chat is in readChat. */
export async function readFolder(id: string): Promise<FolderMeta | null> {
  const raw = await readJson<FolderMeta & Legacy>(folderMetaPath(id));
  if (!raw) return null;
  const f = withoutChat<FolderMeta>(raw);
  f.docIds ??= [];
  return f;
}

async function writeFolder(f: FolderMeta) {
  f.updatedAt = new Date().toISOString();
  await writeJson(folderMetaPath(f.id), withoutChat<FolderMeta>(f));
}

export function updateFolder(id: string, fn: (f: FolderMeta) => void | Promise<void>) {
  return withLock(`folder:${id}`, async () => {
    const f = await readFolder(id);
    if (!f) throw new NotFoundError("folder not found");
    await fn(f);
    await writeFolder(f);
    return f;
  });
}

async function allFolders(): Promise<FolderMeta[]> {
  const entries = await readdir(FOLDERS_DIR, { withFileTypes: true }).catch(() => []);
  const folders = await Promise.all(entries.filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => readFolder(e.name)));
  return folders.filter((f): f is FolderMeta => f !== null);
}

export async function listFolders(): Promise<FolderSummary[]> {
  return (await allFolders()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map(summarizeFolder);
}

export async function createFolder(name: string): Promise<FolderMeta> {
  const id = randomUUID();
  await mkdir(folderDir(id), { recursive: true });
  const now = new Date().toISOString();
  const f: FolderMeta = { id, name, docIds: [], messageCount: 0, createdAt: now, updatedAt: now };
  await writeJson(folderMetaPath(id), f);
  return f;
}

/** Delete a folder and its chat. Its documents stay in the library. */
export async function deleteFolder(id: string) {
  await rm(folderDir(id), { recursive: true, force: true });
  locks.delete(`folder:${id}`);
}

export async function folderOfDoc(docId: string): Promise<FolderMeta | null> {
  return (await allFolders()).find((f) => f.docIds.includes(docId)) ?? null;
}

/** Put a document into a folder (or none). A document is in at most one folder. */
export function setDocFolder(docId: string, folderId: string | null) {
  // One membership change at a time, so concurrent moves can't leave a document in two folders.
  return withLock("membership", async () => {
    for (const f of await allFolders()) {
      if (f.id !== folderId && f.docIds.includes(docId)) {
        await updateFolder(f.id, (x) => void (x.docIds = x.docIds.filter((d) => d !== docId)));
      }
    }
    if (folderId) {
      await updateFolder(folderId, (x) => void (x.docIds.includes(docId) || x.docIds.push(docId)));
    }
  });
}

// --- Chats: one per document, one per folder ---

/** Does that chat (its document or folder) exist? Cheaper than reading it. */
export async function chatExists(kind: ChatKind, id: string) {
  if (!isValidId(id)) return false;
  return !!(await stat(kind === "doc" ? metaPath(id) : folderMetaPath(id)).catch(() => null));
}

const metaFileOf = (kind: ChatKind, id: string) => (kind === "doc" ? metaPath(id) : folderMetaPath(id));
/** The same lock as updateMeta / updateFolder: chat and metadata writes of one chat never interleave. */
const lockOf = (kind: ChatKind, id: string) => `${kind}:${id}`;

/** The chat from chat.json, or (not migrated yet) from the old meta file. Null: no such document/folder. */
async function loadChat(kind: ChatKind, id: string): Promise<{ chat: ChatData; raw: (Legacy & { id: string; name: string; messageCount?: number }) } | null> {
  const raw = await readJson<Legacy & { id: string; name: string; messageCount?: number }>(metaFileOf(kind, id));
  if (!raw) return null;
  const stored = await readJson<ChatData>(chatPath(kind, id));
  const chat = stored ? { ...stored, messages: stored.messages ?? [], conversations: stored.conversations ?? {} } : legacyChat(raw);
  return { chat, raw };
}

/** A chat (of a document or a folder), with the name of what it is about. */
export async function readChat(kind: ChatKind, id: string): Promise<(ChatData & { id: string; name: string }) | null> {
  const got = await loadChat(kind, id);
  return got && { ...got.chat, id: got.raw.id, name: got.raw.name };
}

/**
 * Read-modify-write a chat. It goes to chat.json; the meta file only learns the new message
 * count (and loses the chat fields of an old version, once chat.json holds them).
 */
export function updateChat(kind: ChatKind, id: string, fn: (c: ChatData) => void | Promise<void>): Promise<ChatData> {
  return withLock(lockOf(kind, id), async () => {
    const got = await loadChat(kind, id);
    if (!got) throw new NotFoundError(kind === "doc" ? "document not found" : "folder not found");
    const { chat, raw } = got;
    await fn(chat);
    await writeJson(chatPath(kind, id), chat);
    if (raw.messageCount !== chat.messages.length || hasLegacyChat(raw)) {
      const meta = { ...withoutChat<{ id: string }>(raw), messageCount: chat.messages.length };
      if (kind === "doc") await writeMeta(meta as DocMeta);
      else await writeFolder(meta as FolderMeta);
    }
    return chat;
  });
}

/** Move the chats of old meta files into chat.json (once, at startup). */
export async function migrateChats() {
  const docs = (await readdir(LIBRARY_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => ["doc", e.name] as const);
  const folders = (await readdir(FOLDERS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => ["folder", e.name] as const);
  for (const [kind, id] of [...docs, ...folders]) {
    const raw = await readJson<object>(metaFileOf(kind, id));
    if (raw && hasLegacyChat(raw)) await updateChat(kind, id, () => {}).catch(() => {});
  }
}

/** Create the library, readable only by you (it holds your documents, notes and chats). */
export async function ensureLibrary() {
  await mkdir(LIBRARY_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(LIBRARY_DIR, 0o700).catch(() => {});
}

export function newMessage(m: Omit<Message, "id" | "createdAt">): Message {
  return { id: randomUUID(), createdAt: new Date().toISOString(), ...m };
}
