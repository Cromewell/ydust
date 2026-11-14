import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const LIBRARY_DIR = path.resolve(process.env.YDUST_LIBRARY ?? "library");
const FOLDERS_DIR = path.join(LIBRARY_DIR, "folders");
const STATE_PATH = path.join(LIBRARY_DIR, "state.json");

/** A selected passage. `doc` = the document it is from (always set in folder chats). */
export type Quote = { text: string; page: number; doc?: string };

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
  /** User messages: "check" = I explain it in my own words, the assistant checks it. */
  mode?: "check";
  /** User messages: asks for a second opinion on this assistant message. */
  secondOpinionOf?: string;
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

export type DocMeta = ChatData & {
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
  /** @deprecated pre-multi-provider field (an agy conversation id); migrated on read. */
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChatKeys = keyof ChatData | "conversationId";
export type DocSummary = Omit<DocMeta, ChatKeys> & { messageCount: number; folderId: string | null };

export type FolderMeta = ChatData & {
  id: string;
  name: string;
  /** Member documents, in the order they were added. */
  docIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type FolderSummary = Omit<FolderMeta, keyof ChatData> & { messageCount: number };

export type ChatKind = "doc" | "folder";

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
async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  // On Windows, a virus scanner or the search indexer may hold the target open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw err;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// --- Documents ---

export function summarize(meta: DocMeta, folderId: string | null = null): DocSummary {
  const { messages, conversations: _c, conversationId: _o, sessionTags: _s, contextSigs: _x, toolsVersion: _t, ...rest } = meta;
  return { ...rest, messageCount: messages.length, folderId };
}

export async function readMeta(id: string): Promise<DocMeta | null> {
  const meta = await readJson<DocMeta>(metaPath(id));
  if (!meta) return null;
  if (!meta.conversations) {
    meta.conversations = meta.conversationId ? { agy: meta.conversationId } : {};
    delete meta.conversationId;
  }
  return meta;
}

export async function writeMeta(meta: DocMeta) {
  meta.updatedAt = new Date().toISOString();
  await writeJson(metaPath(meta.id), meta);
}

/** Serialize read-modify-write cycles per document. */
export function updateMeta(id: string, fn: (meta: DocMeta) => void | Promise<void>) {
  return withLock(`doc:${id}`, async () => {
    const meta = await readMeta(id);
    if (!meta) throw new Error("document not found");
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
    conversations: {},
    messages: [],
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
  await writeFile(textPath(id), body);
  if (outline?.trim()) await writeFile(outlinePath(id), outline.trim() + "\n");
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
  const { messages, conversations: _c, sessionTags: _s, contextSigs: _x, toolsVersion: _t, ...rest } = f;
  return { ...rest, messageCount: messages.length };
}

export async function readFolder(id: string): Promise<FolderMeta | null> {
  const f = await readJson<FolderMeta>(folderMetaPath(id));
  if (!f) return null;
  f.docIds ??= [];
  f.messages ??= [];
  f.conversations ??= {};
  return f;
}

export function updateFolder(id: string, fn: (f: FolderMeta) => void | Promise<void>) {
  return withLock(`folder:${id}`, async () => {
    const f = await readFolder(id);
    if (!f) throw new Error("folder not found");
    await fn(f);
    f.updatedAt = new Date().toISOString();
    await writeJson(folderMetaPath(id), f);
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
  const f: FolderMeta = { id, name, docIds: [], messages: [], conversations: {}, createdAt: now, updatedAt: now };
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

export function readChat(kind: ChatKind, id: string): Promise<(ChatData & { id: string; name: string }) | null> {
  return kind === "doc" ? readMeta(id) : readFolder(id);
}

export function updateChat(kind: ChatKind, id: string, fn: (c: ChatData) => void | Promise<void>): Promise<ChatData> {
  return kind === "doc" ? updateMeta(id, fn) : updateFolder(id, fn);
}

export function newMessage(m: Omit<Message, "id" | "createdAt">): Message {
  return { id: randomUUID(), createdAt: new Date().toISOString(), ...m };
}
