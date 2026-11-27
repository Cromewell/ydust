/** A selected passage; `doc` = the document it is from (set in folder chats). */
export type Quote = { text: string; page: number; doc?: string };

export const HL_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type HlColor = (typeof HL_COLORS)[number];
/** A passage marked in a colour; `occurrence`: which match of `text` on the page. */
export type Highlight = { id: string; page: number; text: string; occurrence: number; color: HlColor; comment?: string; createdAt: string };

export type AskMode = "check" | "review-note" | "challenge-note" | "fix-note";

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
  /** User messages: "check" = my own explanation, to be checked; review/challenge one of my notes. */
  mode?: AskMode;
  /** User messages (review-note, challenge-note): the note, lines, and extra instructions. */
  noteRef?: { name: string; lines?: [number, number]; instructions?: string };
  /** User messages: a second opinion on that assistant message. */
  secondOpinionOf?: string;
  /** User messages: changes requested to this draft. */
  draftRef?: { id: string; target: string; revision: number };
  /** Assistant messages: note drafts proposed in this answer. */
  drafts?: MessageDraft[];
  /** User messages: web search was on. */
  web?: boolean;
  /** User messages: one of the app's built-in prompts (Explain, a starter, …). */
  preset?: boolean;
  /** Assistant messages: the CLI's earlier session was gone, so this answer started a new one. */
  newSession?: boolean;
  /** Assistant messages: the web searches the user allowed. */
  webQueries?: string[];
  /** Assistant messages: pinned to the notes, with an optional own note. */
  pinned?: boolean;
  note?: string;
  error?: boolean;
  stopped?: boolean;
  /** Assistant messages: the answer broke off with this error. */
  brokeOff?: string;
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
  /** Page numbers as the document prints them (index 0 = PDF page 1), if they differ from the PDF's. */
  pageLabels?: string[];
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

/** Hits of a search in a folder, per document (`total` may be more than `hits`); `unread`: documents without text. */
export type FolderHits = {
  docs: { id: string; total: number; hits: { page: number; n: number; before: string; match: string; after: string }[] }[];
  unread: number;
};

export type FolderMeta = Omit<FolderSummary, "messageCount"> & { messages: Message[]; busy?: boolean };

/** A chat: the one of a document, or the one of a whole folder. */
export type ChatTarget = { kind: "doc" | "folder"; id: string };
export type Chat = ChatTarget & { name: string; messages: Message[]; hasText: boolean | null };

const chatBase = (t: ChatTarget) => (t.kind === "doc" ? `/api/docs/${t.id}` : `/api/folders/${t.id}`);

/** `id` is what is sent with a question; people see `label` and `description`. */
export type Model = { id: string; label: string; description?: string; efforts?: string[]; defaultEffort?: string | null };

/** A CLI that can answer: Gemini (the Antigravity CLI, agy) or Claude Code (claude). */
export type ProviderInfo = {
  id: string;
  label: string;
  /** The program behind it. */
  cli: string;
  available: boolean;
  models: Model[];
  /** What the CLI uses when no model is chosen. */
  defaultModel: Model | null;
  /** Every reasoning effort it knows (a model may have fewer). */
  efforts: string[];
  /** Can search the web with an approval per query; if not, why (for a tooltip). */
  webSearch: boolean;
  webSearchNote: string | null;
};

/** The assistant wants to run a web search: the user allows (maybe with an edited query) or denies. */
export type Approval = { id: string; kind: "web-search"; query: string; n: number };

export type ToolEvent = { name: string; state: "active" | "done"; detail?: string };

/** Whose notes: a document's or a folder's (notes/ in its folder). `alias` = the document's citation id. */
export type NoteOwner = ChatTarget & { name: string; alias?: string };
export type NoteInfo = { name: string; size: number; updatedAt: string; title: string | null };
export type Note = NoteInfo & { content: string; version: string };
export type SavedNote = NoteInfo & { version: string };

/** Handwritten scratchpads (vector sheets synced with an optional paired iPad). */
export type PaperStyle = "grid" | "dots" | "blank";
export type StrokePoint = [number, number, number];
export type Stroke = { id: string; color: string; width: number; tool?: "pen" | "eraser"; points: StrokePoint[] };
export type SketchPage = { id: string; strokes: Stroke[] };
export type Sketch = { id: string; title: string; paper: PaperStyle; pages: SketchPage[]; createdAt: string; updatedAt: string };
export type SketchInfo = { id: string; title: string; paper: PaperStyle; pageCount: number; strokeCount: number; createdAt: string; updatedAt: string };
export type SketchOp =
  | { type: "add-strokes"; pageId: string; strokes: Stroke[] }
  | { type: "remove-strokes"; pageId: string; strokeIds: string[] }
  | { type: "add-page"; pageId?: string; page?: SketchPage }
  | { type: "clear-page"; pageId: string }
  | { type: "set-paper"; paper: PaperStyle };
export type LanInterface = { ip: string; label: string };
export type LanAddress = { ip: string; label: string; url: string };
export type PadPairingStatus =
  | { active: false; interfaces: LanInterface[] }
  | {
      active: true;
      port: number;
      bindHost: string;
      token: string;
      kind: "doc" | "folder";
      chatId: string;
      sketchId: string;
      chatName: string;
      clients: number;
      url: string;
      interfaces: LanInterface[];
      urls: LanAddress[];
    };
export type PadActionEvent = {
  actionId: string;
  kind: "doc" | "folder";
  chatId: string;
  sketchId: string;
  action: "attach" | "check" | "latex";
  pageId: string;
  pageIndex: number;
  imageId: string;
  label: string;
};
export type LatexStatus = { available: boolean; compiler: string | null };

export class LatexCompileError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message);
  }
}

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
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
  putText: (id: string, pages: string[], version: number, outline: string, labels: string[] | null) =>
    fetch(`/api/docs/${id}/text`, send("PUT", { pages, version, outline, labels })).then(json<DocSummary>),
  remove: (id: string) => fetch(`/api/docs/${id}`, send("DELETE")).then(json<{ ok: true }>),
  pages: (id: string) => fetch(`/api/docs/${id}/pages`).then(json<{ pages: string[] }>),
  providers: () => fetch("/api/providers").then(json<ProviderInfo[]>),

  listFolders: () => fetch("/api/folders").then(json<FolderSummary[]>),
  getFolder: (id: string) => fetch(`/api/folders/${id}`).then(json<FolderMeta>),
  searchFolder: (id: string, q: string, signal?: AbortSignal) => fetch(`/api/folders/${id}/search?q=${encodeURIComponent(q)}`, { signal }).then(json<FolderHits>),
  createFolder: (name: string) => fetch("/api/folders", send("POST", { name })).then(json<FolderSummary>),
  patchFolder: (id: string, body: { name?: string; docIds?: string[] }) => fetch(`/api/folders/${id}`, send("PATCH", body)).then(json<FolderSummary>),
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

  listHighlights: (docId: string) => fetch(`/api/docs/${docId}/highlights`).then(json<Highlight[]>),
  addHighlight: (docId: string, body: { page: number; text: string; occurrence: number; color: HlColor; comment?: string }) =>
    fetch(`/api/docs/${docId}/highlights`, send("POST", body)).then(json<Highlight>),
  patchHighlight: (docId: string, hid: string, body: { color?: HlColor; comment?: string }) =>
    fetch(`/api/docs/${docId}/highlights/${hid}`, send("PATCH", body)).then(json<Highlight>),
  removeHighlight: (docId: string, hid: string) => fetch(`/api/docs/${docId}/highlights/${hid}`, send("DELETE")).then(json<{ ok: true }>),
  getHighlightLabels: () => fetch("/api/highlight-labels").then(json<Record<string, string>>),
  saveHighlightLabels: (labels: Record<string, string>) => fetch("/api/highlight-labels", send("PUT", labels)).then(json<Record<string, string>>),

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
  async acceptDraft(o: ChatTarget, did: string, body: { target?: string; base: string | null; content?: string }) {
    const res = await fetch(`${chatBase(o)}/drafts/${did}/accept`, send("POST", body));
    if (res.status === 409) {
      const b = await res.json().catch(() => ({}));
      throw new NoteConflict(b.error ?? "The note changed meanwhile.", b.current ?? null);
    }
    return json<{ target: string; mode: string; version: string; removed: string[] }>(res);
  },
  decideApproval: (o: ChatTarget, aid: string, body: { decision: "allow" | "deny"; query?: string }) =>
    fetch(`${chatBase(o)}/approvals/${aid}`, send("POST", body)).then(json<{ ok: true }>),
  discardDraft: (o: ChatTarget, did: string) => fetch(`${chatBase(o)}/drafts/${did}`, send("DELETE")).then(json<{ ok: true; removed: string[] }>),
  renameNote: (o: ChatTarget, name: string, to: string) => fetch(noteUrl(o, name), send("PATCH", { name: to })).then(json<NoteInfo>),
  removeNote: (o: ChatTarget, name: string) => fetch(noteUrl(o, name), send("DELETE")).then(json<{ ok: true }>),

  listSketches: (t: ChatTarget, opts: { ensure?: boolean } = {}) =>
    fetch(`${chatBase(t)}/sketches${opts.ensure ? "?ensure=1" : ""}`).then(json<SketchInfo[]>),
  createSketch: (t: ChatTarget, body: { title?: string; paper?: PaperStyle } = {}) =>
    fetch(`${chatBase(t)}/sketches`, send("POST", body)).then(json<Sketch>),
  getSketch: (t: ChatTarget, sid: string) => fetch(`${chatBase(t)}/sketches/${sid}`).then(json<Sketch>),
  applySketchOp: (t: ChatTarget, sid: string, op: SketchOp, clientId?: string) =>
    fetch(`${chatBase(t)}/sketches/${sid}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(clientId ? { "x-ydust-client": clientId } : {}) },
      body: JSON.stringify(op),
    }).then(json<{ ok: true; op: SketchOp }>),
  deleteSketch: (t: ChatTarget, sid: string) => fetch(`${chatBase(t)}/sketches/${sid}`, send("DELETE")).then(json<{ ok: true }>),
  sketchesEventsUrl: (t: ChatTarget, clientId?: string) =>
    `${chatBase(t)}/sketches-events${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`,

  padStatus: () => fetch("/api/pad").then(json<PadPairingStatus>),
  startPad: (body: { kind: "doc" | "folder"; chatId: string; sketchId: string; host?: string }) =>
    fetch("/api/pad/start", send("POST", body)).then(json<PadPairingStatus>),
  stopPad: () => fetch("/api/pad/stop", send("POST")).then(json<PadPairingStatus>),

  latexStatus: () => fetch("/api/latex/status").then(json<LatexStatus>),
  convertLatex: (
    body: { provider?: string; model?: string; effort?: string; language?: string; title?: string; images: string[] },
    signal?: AbortSignal,
  ) => fetch("/api/latex/convert", { ...send("POST", body), signal }).then(json<{ tex: string }>),
  fixLatex: (body: { provider?: string; model?: string; effort?: string; tex: string; errorLog: string }, signal?: AbortSignal) =>
    fetch("/api/latex/convert", { ...send("POST", body), signal }).then(json<{ tex: string }>),
  async compileLatexPdf(tex: string, filename?: string): Promise<Blob> {
    const res = await fetch("/api/latex/compile", send("POST", { tex, filename }));
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      if (res.status === 422 && b) throw new LatexCompileError(b.error ?? "LaTeX compilation failed.", b.log ?? "");
      throw new Error(b?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.blob();
  },
  async importLatexPdf(tex: string, filename: string, folderId: string | null): Promise<DocSummary> {
    const res = await fetch("/api/latex/compile", send("POST", { tex, filename, importTo: { folderId } }));
    if (!res.ok) {
      const b = await res.json().catch(() => null);
      if (res.status === 422 && b) throw new LatexCompileError(b.error ?? "LaTeX compilation failed.", b.log ?? "");
      throw new Error(b?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<DocSummary>;
  },
};

export type AskHandlers = {
  onUser: (m: Message) => void;
  onDelta: (text: string) => void;
  onTool: (t: ToolEvent) => void;
  onDraft: (d: MessageDraft) => void;
  onApproval: (a: Approval) => void;
  /** Answered, timed out, or the answer stopped. */
  onApprovalDone: (id: string) => void;
  onDone: (m: Message) => void;
};

/** POST a question and consume the server-sent event stream. */
export async function ask(
  target: ChatTarget,
  body: {
    question: string;
    level?: string;
    mode?: AskMode;
    /** review-note / challenge-note: which of the chat's notes, optionally which lines. */
    note?: { name: string; lines?: [number, number] };
    /** Web search for this question, each query approved by the user. */
    web?: boolean;
    /** One of the app's built-in English prompts: the answer follows the document's language. */
    preset?: boolean;
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
      else if (event === "approval") handlers.onApproval(payload);
      else if (event === "approval-done") handlers.onApprovalDone(payload.id);
      else if (event === "done") handlers.onDone(payload);
    }
  }
}
