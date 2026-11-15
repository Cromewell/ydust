/** A selected passage; `doc` = the document it is from (set in folder chats). */
export type Quote = { text: string; page: number; doc?: string };

/** A note draft the assistant proposed in an answer (see DraftCard). */
export type MessageDraft = {
  id: string;
  target: string;
  mode: "create" | "append" | "replace";
  summary: string;
  revision: number;
  replaces?: string;
  status?: "accepted" | "discarded" | "superseded";
  acceptedAs?: string;
};
/** A draft with its text, and the note as it is now (null: it doesn't exist). */
export type Draft = MessageDraft & {
  content: string;
  baseVersion: string | null;
  status: "open" | "superseded";
  createdAt: string;
  current: { content: string; version: string } | null;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  quote?: Quote;
  images?: string[];
  provider?: string;
  /** Full id of the model that answered, and its display name. */
  model?: string;
  modelLabel?: string;
  effort?: string;
  /** User messages: "check" = my own explanation, to be checked. */
  mode?: "check";
  /** User messages: a second opinion on that assistant message. */
  secondOpinionOf?: string;
  /** User messages: changes requested to this draft. */
  draftRef?: { id: string; target: string; revision: number };
  /** Assistant messages: note drafts proposed in this answer. */
  drafts?: MessageDraft[];
  /** Assistant messages: pinned to the notes, with an optional own note. */
  pinned?: boolean;
  note?: string;
  error?: boolean;
  stopped?: boolean;
  createdAt: string;
};

export type DocSummary = {
  id: string;
  name: string;
  /** Short id the agent uses in citations ("d7"). */
  alias?: string;
  folderId: string | null;
  size: number;
  pages: number | null;
  hasText: boolean | null;
  textVersion?: number;
  lastPage: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocMeta = Omit<DocSummary, "messageCount"> & {
  messages: Message[];
  busy?: boolean;
};

export type FolderSummary = {
  id: string;
  name: string;
  docIds: string[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type FolderMeta = Omit<FolderSummary, "messageCount"> & { messages: Message[]; busy?: boolean };

/** A chat: the one of a document, or the one of a whole folder. */
export type ChatTarget = { kind: "doc" | "folder"; id: string };
export type Chat = ChatTarget & { name: string; messages: Message[]; hasText: boolean | null };

const chatBase = (t: ChatTarget) => (t.kind === "doc" ? `/api/docs/${t.id}` : `/api/folders/${t.id}`);

/** `id` is what gets passed to --model; `detail` the full model id it stands for. */
export type Model = { id: string; label: string; detail?: string };

/** A CLI that can answer: Antigravity (agy) or Claude Code (claude). */
export type ProviderInfo = {
  id: string;
  label: string;
  available: boolean;
  models: Model[];
  /** What the CLI uses when no model is chosen. */
  defaultModel: Model | null;
  /** Selectable reasoning efforts (empty if the CLI has none) and the configured default. */
  efforts: string[];
  defaultEffort: string | null;
};

export type ToolEvent = { name: string; state: "active" | "done"; detail?: string };

/** Whose notes: a document's or a folder's (notes/ in its folder). `alias` = the document's citation id. */
export type NoteOwner = ChatTarget & { name: string; alias?: string };
export type NoteInfo = { name: string; size: number; updatedAt: string; title: string | null };
export type Note = NoteInfo & { content: string; version: string };
export type SavedNote = NoteInfo & { version: string };

/** A save refused because the note changed meanwhile; `current` is what it holds now (null: deleted). */
export class NoteConflict extends Error {
  constructor(
    message: string,
    readonly current: { content: string; version: string } | null,
  ) {
    super(message);
  }
}

const noteUrl = (o: ChatTarget, name: string) => `${chatBase(o)}/notes/${encodeURIComponent(name)}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  listDocs: () => fetch("/api/docs").then(json<DocSummary[]>),
  getDoc: (id: string) => fetch(`/api/docs/${id}`).then(json<DocMeta>),
  fileUrl: (id: string) => `/api/docs/${id}/file`,
  upload(file: File, folderId?: string | null) {
    const form = new FormData();
    form.append("file", file);
    if (folderId) form.append("folderId", folderId);
    return fetch("/api/docs", { method: "POST", body: form }).then(json<DocSummary>);
  },
  patch: (id: string, body: { name?: string; lastPage?: number; folderId?: string | null }) =>
    fetch(`/api/docs/${id}`, send("PATCH", body)).then(json<DocSummary>),
  putText: (id: string, pages: string[], version: number, outline: string) =>
    fetch(`/api/docs/${id}/text`, send("PUT", { pages, version, outline })).then(json<DocSummary>),
  remove: (id: string) => fetch(`/api/docs/${id}`, send("DELETE")).then(json<{ ok: true }>),
  pages: (id: string) => fetch(`/api/docs/${id}/pages`).then(json<{ pages: string[] }>),
  providers: () => fetch("/api/providers").then(json<ProviderInfo[]>),

  listFolders: () => fetch("/api/folders").then(json<FolderSummary[]>),
  getFolder: (id: string) => fetch(`/api/folders/${id}`).then(json<FolderMeta>),
  createFolder: (name: string) => fetch("/api/folders", send("POST", { name })).then(json<FolderSummary>),
  patchFolder: (id: string, body: { name?: string }) => fetch(`/api/folders/${id}`, send("PATCH", body)).then(json<FolderSummary>),
  removeFolder: (id: string) => fetch(`/api/folders/${id}`, send("DELETE")).then(json<{ ok: true }>),

  /** The chat's messages (a document's or a folder's). */
  async getChat(t: ChatTarget): Promise<Chat & { busy?: boolean }> {
    if (t.kind === "doc") {
      const d = await api.getDoc(t.id);
      return { ...t, name: d.name, messages: d.messages, hasText: d.hasText, busy: d.busy };
    }
    const f = await api.getFolder(t.id);
    return { ...t, name: f.name, messages: f.messages, hasText: null, busy: f.busy };
  },
  imageUrl: (t: ChatTarget, img: string) => `${chatBase(t)}/images/${img}`,
  uploadImage(t: ChatTarget, image: Blob) {
    const form = new FormData();
    form.append("file", image, "image");
    return fetch(`${chatBase(t)}/images`, { method: "POST", body: form }).then(json<{ id: string }>);
  },
  reset: (t: ChatTarget) => fetch(`${chatBase(t)}/reset`, send("POST")).then(json<{ messages: Message[] }>),
  stop: (t: ChatTarget) => fetch(`${chatBase(t)}/stop`, send("POST")).then(json<{ ok: true }>),
  patchMessage: (t: ChatTarget, mid: string, body: { pinned?: boolean; note?: string }) =>
    fetch(`${chatBase(t)}/messages/${mid}`, send("PATCH", body)).then(json<Message>),

  listNotes: (o: ChatTarget) => fetch(`${chatBase(o)}/notes`).then(json<NoteInfo[]>),
  getNote: (o: ChatTarget, name: string) => fetch(noteUrl(o, name)).then(json<Note>),
  /** Create (`baseVersion` null) or update a note; throws NoteConflict if it changed meanwhile. */
  async saveNote(o: ChatTarget, name: string, content: string, baseVersion: string | null, opts: { keepalive?: boolean } = {}) {
    const init = send("PUT", { content, baseVersion });
    // Browsers refuse keepalive bodies over 64 KB; larger notes go as a normal request.
    const keepalive = !!opts.keepalive && (init.body as string).length < 60_000;
    const res = await fetch(noteUrl(o, name), { ...init, keepalive });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new NoteConflict(body.error ?? "The note changed meanwhile.", body.current ?? null);
    }
    return json<SavedNote>(res);
  },
  getDraft: (o: ChatTarget, did: string) => fetch(`${chatBase(o)}/drafts/${did}`).then(json<Draft>),
  /** Write a draft into its note; `base`: the note version the diff was shown against. Throws NoteConflict if it changed. */
  async acceptDraft(o: ChatTarget, did: string, body: { target?: string; base: string | null }) {
    const res = await fetch(`${chatBase(o)}/drafts/${did}/accept`, send("POST", body));
    if (res.status === 409) {
      const b = await res.json().catch(() => ({}));
      throw new NoteConflict(b.error ?? "The note changed meanwhile.", b.current ?? null);
    }
    return json<{ target: string; mode: string; version: string; removed: string[] }>(res);
  },
  discardDraft: (o: ChatTarget, did: string) => fetch(`${chatBase(o)}/drafts/${did}`, send("DELETE")).then(json<{ ok: true; removed: string[] }>),
  renameNote: (o: ChatTarget, name: string, to: string) => fetch(noteUrl(o, name), send("PATCH", { name: to })).then(json<NoteInfo>),
  removeNote: (o: ChatTarget, name: string) => fetch(noteUrl(o, name), send("DELETE")).then(json<{ ok: true }>),
};

export type AskHandlers = {
  onUser: (m: Message) => void;
  onDelta: (text: string) => void;
  onTool: (t: ToolEvent) => void;
  onDraft: (d: MessageDraft) => void;
  onDone: (m: Message) => void;
};

/** POST a question and consume the server-sent event stream. */
export async function ask(
  target: ChatTarget,
  body: {
    question: string;
    level?: string;
    mode?: "check";
    secondOpinionOf?: string;
    draftId?: string;
    quote?: Quote;
    model?: string;
    effort?: string;
    images?: string[];
    language?: string;
    provider?: string;
  },
  handlers: AskHandlers,
  signal: AbortSignal,
) {
  const res = await fetch(`${chatBase(target)}/ask`, { ...send("POST", body), signal });
  if (!res.ok || !res.body) await json(res);

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join("\n"));
      if (event === "user") handlers.onUser(payload);
      else if (event === "delta") handlers.onDelta(payload);
      else if (event === "tool") handlers.onTool(payload);
      else if (event === "draft") handlers.onDraft(payload);
      else if (event === "done") handlers.onDone(payload);
    }
  }
}
