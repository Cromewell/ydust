import clsx from "clsx";
import {
  Camera,
  Check,
  FileUp,
  Highlighter,
  ListTree,
  Loader2,
  Maximize2,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppearanceMenu } from "./components/AppearanceMenu";
import { ChatPanel, type Attachment, type ChatPanelHandle, type PanelTab, type Streaming } from "./components/ChatPanel";
import { NotePicker, type Anchor } from "./components/NotePicker";
import type { OpenNote } from "./components/NotesPanel";
import { OutlinePanel } from "./components/OutlinePanel";
import { PdfViewer, type Flash, type Mark, type PdfSelection, type SearchState, type Zoom } from "./components/PdfViewer";
import { SearchBar, type SearchHit } from "./components/SearchBar";
import { SelectionMenu } from "./components/SelectionMenu";
import { Sidebar } from "./components/Sidebar";
import { api, ask, type Chat, type ChatTarget, type DocMeta, type DocSummary, type FolderSummary, type Message, type MessageDraft, type NoteOwner, type ProviderInfo, type Quote } from "./lib/api";
import { questionOf } from "./lib/export";
import { citationsFor, insertIntoNote, noteEditor, pageLink, quoteForNote, sameOwner } from "./lib/notes";
import { pageFilter, parseAppearance, tintColor, type PdfAppearance } from "./lib/appearance";
import type { TextSize } from "./lib/settings";
import { findInString, snippet } from "./lib/textMatch";
import { TEXT_VERSION, extractAllText, loadPdf, renderRegion, type PageRect, type PDFDocumentProxy } from "./lib/pdf";

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(`ydust:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`ydust:${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MAX_ATTACHMENTS = 10;
const SIDEBAR_WIDTH = 256;
const CHAT_DEFAULT = 420;
const CHAT_MIN = 300;
const VIEWER_MIN = 320;

/** Text not extracted yet, or by an older extraction. */
const needsText = (d: { hasText: boolean | null; textVersion?: number }) => d.hasText === null || (d.textVersion ?? 1) < TEXT_VERSION;
const byName = (a: FolderSummary, b: FolderSummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => store.get("active"));
  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Text extraction in progress, per document. */
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  /** Open this page (and flash this text) once that document has loaded. */
  const pendingOpen = useRef<{ doc: string; page: number; text?: string } | null>(null);

  // The chat: the open PDF's own, or (scope "folder") the one of its folder.
  const [scope, setScope] = useState<"doc" | "folder">(() => (store.get("scope") === "folder" ? "folder" : "doc"));
  const [chat, setChat] = useState<Chat | null>(null);
  const activeFolder = folders.find((f) => f.id === docs.find((d) => d.id === activeId)?.folderId) ?? null;
  const targetKey = scope === "folder" && activeFolder ? `folder:${activeFolder.id}` : activeId ? `doc:${activeId}` : "";
  const target = useMemo<ChatTarget | null>(() => {
    if (!targetKey) return null;
    const [kind, id] = targetKey.split(":");
    return { kind: kind as ChatTarget["kind"], id };
  }, [targetKey]);
  const [uploading, setUploading] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [scale, setScale] = useState(1);
  const [jump, setJump] = useState<{ page: number; nonce: number } | null>(null);
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);

  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState(() => store.get("provider") ?? "agy");
  // One remembered model per CLI ("model" was the agy model before Claude was added).
  const [models, setModels] = useState<Record<string, string>>(() => ({
    agy: store.get("model:agy") ?? store.get("model") ?? "",
    claude: store.get("model:claude") ?? "",
  }));
  const model = models[provider] ?? "";
  // Reasoning effort per CLI ("" = the CLI's own default).
  const [efforts, setEfforts] = useState<Record<string, string>>(() => ({ claude: store.get("effort:claude") ?? "" }));
  const effort = providers.find((p) => p.id === provider)?.efforts.includes(efforts[provider] ?? "") ? efforts[provider] : "";
  const [language, setLanguage] = useState(() => store.get("lang") ?? "auto");
  const [level, setLevel] = useState(() => store.get("level") ?? "auto");
  const [checkMode, setCheckMode] = useState(false);

  const [showOutline, setShowOutline] = useState(() => store.get("outline") === "1");
  const [showMarks, setShowMarks] = useState(() => store.get("marks") !== "0");
  const [appearance, setAppearance] = useState<PdfAppearance>(() => parseAppearance(store.get("appearance")));
  const pagesFilter = pageFilter(appearance);
  const pagesTint = tintColor(appearance.kelvin);
  const [flashTarget, setFlashTarget] = useState<Flash | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [pagesVersion, setPagesVersion] = useState(0);
  const pageTexts = useRef<{ id: string; pages: string[] } | null>(null);
  const [textSize, setTextSize] = useState<TextSize>(() => (store.get("textSize") as TextSize | null) ?? "s");

  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  // Mirror in a ref so quick successive pastes/snips see the latest list.
  const attachmentsRef = useRef<Attachment[]>([]);
  const setAttachments = useCallback((next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  }, []);
  const [snipping, setSnipping] = useState(false);
  const [snipped, setSnipped] = useState<Attachment | null>(null); // "take another or done?" card

  const [chatWidth, setChatWidth] = useState(() => Number(store.get("chatWidth")) || CHAT_DEFAULT);
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);

  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [dragging, setDragging] = useState(false);
  const chatRef = useRef<ChatPanelHandle>(null);

  // --- Notes: the Notes tab, the note open in it, and the "which note?" picker ---
  const [panelTab, setPanelTabState] = useState<PanelTab>(() => (store.get("panelTab") === "notes" ? "notes" : "chat"));
  const setPanelTab = useCallback((t: PanelTab) => {
    setPanelTabState(t);
    store.set("panelTab", t);
  }, []);
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  const [notesRefresh, setNotesRefresh] = useState(0);
  const [picker, setPicker] = useState<{ anchor: Anchor; title: string; block: (owner: NoteOwner) => string } | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  // Library + models on startup.
  useEffect(() => {
    api
      .listDocs()
      .then((list) => {
        setDocs(list);
        setActiveId((id) => (id && list.some((d) => d.id === id) ? id : (list[0]?.id ?? null)));
      })
      .catch((e) => flash(`Can't reach the server: ${e.message}`));
    api
      .listFolders()
      .then(setFolders)
      .catch(() => {});
    api
      .providers()
      .then((list) => {
        setProviders(list);
        // Fall back to an installed CLI if the remembered one is missing.
        setProvider((cur) => (list.find((p) => p.id === cur)?.available ? cur : (list.find((p) => p.available)?.id ?? cur)));
      })
      .catch(() => {});
  }, [flash]);

  // --- Text extraction: document.txt + outline.txt, so the agent can read every document ---
  const indexJobs = useRef(new Map<string, Promise<void>>());
  const failedIndex = useRef(new Set<string>());
  const [indexTick, setIndexTick] = useState(0);
  const indexDoc = useCallback((id: string, loaded?: PDFDocumentProxy) => {
    const jobs = indexJobs.current;
    const running = jobs.get(id);
    if (running) return running;
    const job = (async () => {
      const task = loaded ? null : loadPdf(api.fileUrl(id));
      try {
        const p = loaded ?? (await task!.promise);
        setProgress((x) => ({ ...x, [id]: { done: 0, total: p.numPages } }));
        const { pages, outline } = await extractAllText(p, (done, total) => setProgress((x) => ({ ...x, [id]: { done, total } })));
        const s = await api.putText(id, pages, TEXT_VERSION, outline);
        if (pageTexts.current?.id === id) pageTexts.current = null;
        setDocs((list) => list.map((x) => (x.id === id ? s : x)));
        setDoc((d) => (d && d.id === id ? { ...d, pages: s.pages, hasText: s.hasText, textVersion: s.textVersion } : d));
        setChat((c) => (c && c.kind === "doc" && c.id === id ? { ...c, hasText: s.hasText } : c));
      } catch {
        // An open document's PDF is destroyed when you switch away: retried in the background.
        if (!loaded) failedIndex.current.add(id);
      } finally {
        void task?.destroy();
        setProgress(({ [id]: _, ...rest }) => rest);
        jobs.delete(id);
        setIndexTick((t) => t + 1);
      }
    })();
    jobs.set(id, job);
    return job;
  }, []);

  // In the background, one at a time: every document that isn't extracted (or is outdated).
  useEffect(() => {
    if (indexJobs.current.size) return;
    const next = docs.find((d) => d.id !== activeId && needsText(d) && !failedIndex.current.has(d.id));
    if (next) void indexDoc(next.id);
  }, [docs, activeId, indexTick, indexDoc]);

  // Load the active document and its PDF.
  useEffect(() => {
    setDoc(null);
    setPdf(null);
    setLoadError(null);
    setSelection(null);
    setJump(null);
    setFlashTarget(null);
    setSearchHits([]);
    setSnipping(false);
    setSnipped(null);
    if (!activeId) return;
    store.set("active", activeId);

    let cancelled = false;
    const task = loadPdf(api.fileUrl(activeId));
    (async () => {
      try {
        const [meta, p] = await Promise.all([api.getDoc(activeId), task.promise]);
        if (cancelled) return;
        const pending = pendingOpen.current?.doc === activeId ? pendingOpen.current : null;
        pendingOpen.current = null;
        const start = pending && pending.page >= 1 && pending.page <= p.numPages ? pending.page : meta.lastPage;
        setDoc({ ...meta, lastPage: start });
        setPage(start);
        setPdf(p);
        if (pending?.text) setFlashTarget({ page: start, text: pending.text, nonce: Date.now() });
        // First open (or outdated extraction): extract the text so the agent can read the whole document.
        if (needsText(meta)) void indexDoc(activeId, p);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      void task.destroy(); // also destroys the loaded document
    };
  }, [activeId, indexDoc]);

  // Load the chat (the document's or the folder's). Switching chats stops a running answer.
  useEffect(() => {
    setChat(null);
    setStreaming(null);
    abortRef.current?.abort();
    abortRef.current = null; // so you can ask in the new chat right away
    setQuote(null);
    setCheckMode(false);
    setSnipped(null);
    attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    setAttachments([]);
    if (!target) return;
    let cancelled = false;
    api
      .getChat(target)
      .then((c) => !cancelled && setChat(c))
      .catch((e) => !cancelled && flash(`Could not load the chat: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [target, flash, setAttachments]);

  // Remember the reading position.
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => void api.patch(doc.id, { lastPage: page }).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [page, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useCallback(
    async (files: File[], folderId: string | null = null) => {
      const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (!pdfs.length) return flash("Only PDF files can be added.");
      setUploading((n) => n + pdfs.length);
      for (const f of pdfs) {
        try {
          const s = await api.upload(f, folderId);
          setDocs((list) => [s, ...list]);
          if (folderId) setFolders((list) => list.map((x) => (x.id === folderId ? { ...x, docIds: [...x.docIds, s.id] } : x)));
          setActiveId(s.id);
        } catch (e) {
          flash(`${f.name}: ${(e as Error).message}`);
        } finally {
          setUploading((n) => n - 1);
        }
      }
    },
    [flash],
  );

  const remove = async (id: string) => {
    await api.remove(id).catch((e) => flash(e.message));
    setFolders((list) => list.map((f) => (f.docIds.includes(id) ? { ...f, docIds: f.docIds.filter((d) => d !== id) } : f)));
    setDocs((list) => {
      const next = list.filter((d) => d.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const rename = async (id: string, name: string) => {
    try {
      const s = await api.patch(id, { name });
      setDocs((list) => list.map((d) => (d.id === id ? s : d)));
      setDoc((d) => (d && d.id === id ? { ...d, name: s.name } : d));
      setChat((c) => (c && c.kind === "doc" && c.id === id ? { ...c, name: s.name } : c));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  // --- Folders ---
  const createFolder = async () => {
    try {
      const f = await api.createFolder("New folder");
      setFolders((list) => [...list, f].sort(byName));
      return f.id;
    } catch (e) {
      flash((e as Error).message);
      return null;
    }
  };

  const renameFolder = async (id: string, name: string) => {
    try {
      const f = await api.patchFolder(id, { name });
      setFolders((list) => list.map((x) => (x.id === id ? f : x)).sort(byName));
      setChat((c) => (c && c.kind === "folder" && c.id === id ? { ...c, name: f.name } : c));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const removeFolder = async (id: string) => {
    try {
      await api.removeFolder(id);
      setFolders((list) => list.filter((f) => f.id !== id));
      setDocs((list) => list.map((d) => (d.folderId === id ? { ...d, folderId: null } : d)));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const moveDoc = async (docId: string, folderId: string | null) => {
    try {
      const s = await api.patch(docId, { folderId });
      setDocs((list) => list.map((d) => (d.id === docId ? s : d)));
      setFolders((list) =>
        list.map((f) => {
          const docIds = f.docIds.filter((d) => d !== docId);
          return { ...f, docIds: f.id === folderId ? [...docIds, docId] : docIds };
        }),
      );
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const jumpTo = useCallback((p: number) => setJump({ page: p, nonce: Date.now() }), []);

  /** Show a page of any document (opening it first if needed), optionally flashing a passage. */
  const openAt = useCallback(
    (docId: string, p: number, text?: string) => {
      if (docId === activeId) {
        if (text) setFlashTarget({ page: p, text, nonce: Date.now() });
        else jumpTo(p);
        return;
      }
      if (!docs.some((d) => d.id === docId)) return flash("That document is no longer in your library.");
      pendingOpen.current = { doc: docId, page: p, text };
      setActiveId(docId);
    },
    [activeId, docs, jumpTo, flash],
  );
  /**
   * A page link in an answer: "#page=N" (the open PDF) or "#doc=<alias>&page=N".
   * Models sometimes mix up the short ids ("d1"/"d2") but name the document right in the
   * link text ("[Script, p. 3]"): if the text names another document, trust the text.
   */
  const onCite = useCallback(
    (p: number, alias?: string, label?: string) => {
      let target = alias ? docs.find((d) => d.alias === alias) : undefined;
      const said = label?.replace(/(?:[,;(]\s*|\s+)(?:pp?|s|page|seite)\.?\s*\d.*$/i, "").trim().toLowerCase();
      if (alias && said && said.length >= 3) {
        const names = (d: DocSummary) => d.name.toLowerCase();
        const fits = (d: DocSummary) => names(d).startsWith(said) || said.startsWith(names(d));
        if (!target || !fits(target)) {
          const scoped = chat?.kind === "folder" ? docs.filter((d) => d.folderId === chat.id) : docs;
          const named = scoped.filter(fits);
          if (named.length === 1) target = named[0];
        }
      }
      if (target) openAt(target.id, p);
      else jumpTo(p);
    },
    [docs, chat, openAt, jumpTo],
  );
  const hasDoc = useCallback((alias: string) => docs.some((d) => d.alias === alias), [docs]);
  const docName = useCallback((id: string) => docs.find((d) => d.id === id)?.name, [docs]);

  /** Whose notes the Notes tab shows: the open PDF's, then its folder's. */
  const noteOwners = useMemo<NoteOwner[]>(() => {
    const own = doc ? docs.find((d) => d.id === doc.id) : null;
    const list: NoteOwner[] = [];
    if (doc) list.push({ kind: "doc", id: doc.id, name: own?.name ?? doc.name, alias: own?.alias ?? doc.alias });
    if (activeFolder) list.push({ kind: "folder", id: activeFolder.id, name: activeFolder.name });
    return list;
  }, [doc, docs, activeFolder]);

  /** Put a block into a note; the note that is open in the editor gets it at its cursor. */
  const addToNote = useCallback(
    async (owner: NoteOwner, name: string, block: string, isNew = false) => {
      await insertIntoNote(owner, name, block, { create: isNew });
      setNotesRefresh((n) => n + 1);
      const open = noteEditor.get();
      if (!open || !sameOwner(open.owner, owner) || open.name !== name) flash(`Added to ${name}`);
    },
    [flash],
  );
  /** Straight into the open note if there is one (and it belongs here), otherwise ask which. */
  const toNote = useCallback(
    (anchor: Anchor, title: string, block: (owner: NoteOwner) => string) => {
      const open = noteEditor.get();
      if (open && panelTab === "notes" && showChat && noteOwners.some((o) => sameOwner(o, open.owner))) {
        void addToNote(open.owner, open.name, block(open.owner)).catch((e) => flash(`Could not add it: ${(e as Error).message}`));
      } else {
        setPicker({ anchor, title, block });
      }
    },
    [addToNote, panelTab, showChat, noteOwners, flash],
  );

  const chatKeyOf = (c: Chat | ChatTarget) => `${c.kind}:${c.id}`;
  /** Append a message, but only if that chat is still the one on screen. */
  const pushMessage = (key: string, m: Message) =>
    setChat((c) => (c && chatKeyOf(c) === key ? { ...c, messages: [...c.messages.filter((x) => x.id !== "pending"), m] } : c));
  const countMessages = (t: ChatTarget, delta: number | null) => {
    const next = (n: number) => (delta === null ? 0 : n + delta);
    if (t.kind === "doc") setDocs((list) => list.map((d) => (d.id === t.id ? { ...d, messageCount: next(d.messageCount) } : d)));
    else setFolders((list) => list.map((f) => (f.id === t.id ? { ...f, messageCount: next(f.messageCount) } : f)));
  };

  const addAttachment = useCallback(
    (blob: Blob, label: string) => {
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
        flash(`You can attach up to ${MAX_ATTACHMENTS} pictures per question.`);
        return null;
      }
      const a: Attachment = { key: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), label };
      setAttachments([...attachmentsRef.current, a]);
      return a;
    },
    [flash, setAttachments],
  );

  const removeAttachment = useCallback(
    (key: string) => {
      const gone = attachmentsRef.current.find((a) => a.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
      setAttachments(attachmentsRef.current.filter((a) => a.key !== key));
      setSnipped((s) => (s?.key === key ? null : s));
    },
    [setAttachments],
  );

  const send = useCallback(
    async (
      question: string,
      withQuote: Quote | null,
      withImages: Attachment[] = [],
      opts: { mode?: "check"; secondOpinionOf?: string; via?: string; draft?: MessageDraft } = {},
    ) => {
      if (!target || abortRef.current) return;
      const t = target;
      const key = chatKeyOf(t);
      // In a document's own chat the quote is always from that document.
      if (withQuote && t.kind === "doc") withQuote = { text: withQuote.text, page: withQuote.page };
      const via = opts.via ?? provider; // a second opinion goes to the other CLI, just this once
      const controller = new AbortController();
      abortRef.current = controller;

      // Upload pictures first (local, fast); keep them in the composer if that fails.
      let imageIds: string[] = [];
      if (withImages.length) {
        try {
          imageIds = await Promise.all(withImages.map((a) => api.uploadImage(t, a.blob).then((r) => r.id)));
        } catch (e) {
          abortRef.current = null;
          flash(`Could not attach the picture: ${(e as Error).message}`);
          return;
        }
        const sent = new Set(withImages.map((a) => a.key));
        withImages.forEach((a) => URL.revokeObjectURL(a.url));
        setAttachments(attachmentsRef.current.filter((a) => !sent.has(a.key)));
        setSnipped(null);
      }

      setQuote(null);
      if (opts.mode) setCheckMode(false);
      setShowChat(true);
      setPanelTab("chat"); // the answer is in the chat, even when asked from the Notes tab
      setStreaming({ text: "", tools: [], drafts: [] });
      pushMessage(key, {
        id: "pending",
        role: "user",
        content: question,
        quote: withQuote ?? undefined,
        images: imageIds.length ? imageIds : undefined,
        mode: opts.mode,
        secondOpinionOf: opts.secondOpinionOf,
        draftRef: opts.draft ? { id: opts.draft.id, target: opts.draft.target, revision: opts.draft.revision } : undefined,
        createdAt: new Date().toISOString(),
      });
      let partial = "";
      try {
        await ask(
          t,
          {
            question,
            quote: withQuote ?? undefined,
            model: models[via] || undefined,
            effort: efforts[via] || undefined,
            provider: via,
            images: imageIds,
            language: language === "auto" ? undefined : language,
            level: level === "auto" ? undefined : level,
            mode: opts.mode,
            secondOpinionOf: opts.secondOpinionOf,
            draftId: opts.draft?.id,
          },
          {
            onUser: (m) => pushMessage(key, m),
            onDelta: (t) => {
              partial += t;
              setStreaming((s) => (s ? { ...s, text: s.text + t } : s));
            },
            onTool: (t) => setStreaming((s) => (s ? { ...s, tools: [...s.tools, t] } : s)),
            onDraft: (d) => {
              setStreaming((s) => (s ? { ...s, drafts: [...s.drafts.filter((x) => x.id !== d.replaces), d] } : s));
              if (d.replaces) markDrafts(key, { [d.replaces]: { status: "superseded" } });
            },
            onDone: (m) => pushMessage(key, m),
          },
          controller.signal,
        );
      } catch (e) {
        if (controller.signal.aborted) {
          if (partial.trim()) {
            pushMessage(key, { id: crypto.randomUUID(), role: "assistant", content: partial, stopped: true, createdAt: new Date().toISOString() });
          }
        } else {
          pushMessage(key, { id: crypto.randomUUID(), role: "assistant", content: (e as Error).message, error: true, createdAt: new Date().toISOString() });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setStreaming(null);
        countMessages(t, 2);
      }
    },
    [target, models, efforts, provider, language, level, flash, setAttachments, setPanelTab], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Set the status of drafts on the answers of that chat (if it is still on screen). */
  const markDrafts = (key: string, update: Record<string, Pick<MessageDraft, "status" | "acceptedAs">>) =>
    setChat((c) =>
      c && chatKeyOf(c) === key
        ? { ...c, messages: c.messages.map((m) => (m.drafts?.some((d) => update[d.id]) ? { ...m, drafts: m.drafts.map((d) => (update[d.id] ? { ...d, ...update[d.id] } : d)) } : m)) }
        : c,
    );

  const secondOpinion = useCallback(
    (messageId: string, via: string) => void send("Second opinion", null, [], { secondOpinionOf: messageId, via }),
    [send],
  );

  /** "Insert into note" on an answer: its question as a heading, the passage it was about, the answer. */
  const insertAnswer = useCallback(
    (messageId: string, anchor: Anchor) => {
      if (!chat) return;
      const a = chat.messages.find((m) => m.id === messageId);
      if (!a) return;
      let q = questionOf(chat.messages, a);
      // A second opinion repeats the question it is about.
      if (q?.secondOpinionOf) q = questionOf(chat.messages, chat.messages.find((m) => m.id === q!.secondOpinionOf) ?? a) ?? q;
      const from = { kind: chat.kind, id: chat.id, alias: chat.kind === "doc" ? docs.find((d) => d.id === chat.id)?.alias : undefined };
      const heading = q && !q.secondOpinionOf ? q.content.split("\n")[0].trim().slice(0, 100) : "";
      const block = (owner: NoteOwner) => {
        const parts: string[] = [];
        if (heading) parts.push(`### ${q?.mode === "check" ? "My explanation: " : ""}${heading}`);
        const quoteDoc = q?.quote ? docs.find((d) => d.id === (q!.quote!.doc ?? chat.id)) : undefined;
        if (q?.quote && quoteDoc) parts.push(quoteForNote(q.quote.text, pageLink(owner, q.quote.page, quoteDoc)));
        parts.push(citationsFor(a.content.trim(), from, owner));
        return parts.join("\n\n");
      };
      setPicker({ anchor, title: "Insert this answer into…", block });
    },
    [chat, docs],
  );

  /** One of the chat's notes, in the Notes tab. */
  const openChatNote = useCallback(
    (name: string) => {
      const owner = chat && noteOwners.find((o) => o.kind === chat.kind && o.id === chat.id);
      if (!owner) return;
      setOpenNote({ owner, name });
      setPanelTab("notes");
      setShowChat(true);
    },
    [chat, noteOwners, setPanelTab],
  );

  /** Accepted or discarded: mark it (and its earlier versions); an accepted draft opens in the Notes tab. */
  const draftDecided = useCallback(
    (d: MessageDraft, outcome: { accepted?: string; removed: string[] }) => {
      if (!chat) return;
      const status = (id: string) => (id !== d.id ? "superseded" : outcome.accepted ? "accepted" : "discarded");
      markDrafts(chatKeyOf(chat), Object.fromEntries(outcome.removed.map((id) => [id, { status: status(id), ...(id === d.id && outcome.accepted ? { acceptedAs: outcome.accepted } : {}) }])));
      setNotesRefresh((n) => n + 1);
      if (outcome.accepted) openChatNote(outcome.accepted);
    },
    [chat, openChatNote], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const updateMessage = useCallback(
    async (messageId: string, patch: { pinned?: boolean; note?: string }) => {
      if (!target) return;
      const t = target;
      setChat((c) => (c && chatKeyOf(c) === chatKeyOf(t) ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) } : c));
      try {
        await api.patchMessage(t, messageId, patch);
      } catch (e) {
        flash(`Could not save: ${(e as Error).message}`);
      }
    },
    [target, flash], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // --- Discussed passages (quotes of earlier questions) + jumping to a quoted passage ---
  const marks = useMemo<Mark[]>(
    () =>
      showMarks && chat
        ? chat.messages
            .filter((m) => m.role === "user" && m.quote && !m.secondOpinionOf && m.id !== "pending")
            .filter((m) => (chat.kind === "doc" ? chat.id === activeId : m.quote!.doc === activeId))
            .map((m) => ({ id: m.id, page: m.quote!.page, text: m.quote!.text }))
        : [],
    [chat, showMarks, activeId],
  );
  const jumpToQuote = useCallback(
    (q: Quote) => {
      const from = q.doc ?? (chat?.kind === "doc" ? chat.id : activeId);
      if (from) openAt(from, q.page, q.text);
    },
    [chat, activeId, openAt],
  );
  const showMessage = useCallback((messageId: string) => {
    setShowChat(true);
    requestAnimationFrame(() => chatRef.current?.showMessage(messageId));
  }, []);

  // --- Search in the document (page texts come from document.txt) ---
  useEffect(() => {
    if (!searchOpen || !doc || pageTexts.current?.id === doc.id || !doc.hasText) return;
    let cancelled = false;
    setSearchLoading(true);
    api
      .pages(doc.id)
      .then((r) => {
        if (cancelled) return;
        pageTexts.current = { id: doc.id, pages: r.pages };
        setPagesVersion((v) => v + 1);
      })
      .catch(() => {})
      .finally(() => !cancelled && setSearchLoading(false));
    return () => {
      cancelled = true;
    };
  }, [searchOpen, doc?.id, doc?.hasText]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = searchQuery.trim();
    const texts = pageTexts.current?.id === doc?.id ? pageTexts.current?.pages : null;
    if (!searchOpen || q.length < 2 || !texts) {
      setSearchHits([]);
      return;
    }
    const t = setTimeout(() => {
      const hits: SearchHit[] = [];
      texts.forEach((text, i) => {
        findInString(text, q, 1000 - hits.length).forEach(([a, b], n) => hits.push({ page: i + 1, n, ...snippet(text, a, b) }));
      });
      setSearchHits(hits);
      // Start at the first hit at or after the page you're reading.
      const from = hits.findIndex((h) => h.page >= page);
      setSearchIndex(from === -1 ? 0 : from);
      setSearchNonce(Date.now());
    }, 180);
    return () => clearTimeout(t);
  }, [searchQuery, searchOpen, pagesVersion, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchState = useMemo<SearchState | null>(() => {
    if (!searchOpen || searchQuery.trim().length < 2) return null;
    const h = searchHits[searchIndex];
    return { query: searchQuery.trim(), current: h ? { page: h.page, n: h.n } : null, nonce: searchNonce };
  }, [searchOpen, searchQuery, searchHits, searchIndex, searchNonce]);

  const stop = () => {
    abortRef.current?.abort();
    if (target) void api.stop(target).catch(() => {});
  };

  const reset = async () => {
    if (!target) return;
    const t = target;
    stop();
    try {
      const { messages } = await api.reset(t);
      setChat((c) => (c && chatKeyOf(c) === chatKeyOf(t) ? { ...c, messages } : c));
      countMessages(t, null);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const takeSelection = useCallback(() => {
    if (!selection) return null;
    const q: Quote = { text: selection.text, page: selection.page, doc: activeId ?? undefined };
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    return q;
  }, [selection, activeId]);

  const askAboutSelection = useCallback(() => {
    const q = takeSelection();
    if (q) setQuote(q);
    setShowChat(true);
    requestAnimationFrame(() => chatRef.current?.focus());
  }, [takeSelection]);

  // --- Snipping: drag a box on the page, attach it as a picture ---
  const startSnip = useCallback(() => {
    if (!pdf) return;
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setSnipped(null);
    setSnipping(true);
  }, [pdf]);

  const finishSnipping = useCallback(() => {
    setSnipping(false);
    setSnipped(null);
    setShowChat(true);
    requestAnimationFrame(() => chatRef.current?.focus());
  }, []);

  const handleSnip = useCallback(
    async (pageNum: number, rect: PageRect) => {
      if (!pdf) return;
      setSnipping(false);
      try {
        const blob = await renderRegion(pdf, pageNum, rect);
        const a = addAttachment(blob, `p. ${pageNum}`);
        if (a) setSnipped(a);
      } catch (e) {
        flash(`Snapshot failed: ${(e as Error).message}`);
      }
    },
    [pdf, addAttachment, flash],
  );

  // Paste pictures from the clipboard straight into the chat.
  useEffect(() => {
    if (!chat) return;
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const images = Array.from(data.items)
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (!images.length) return;
      const hasText = data.types.includes("text/plain");
      // Rich text from Word & co. carries a picture of itself too: in a text field, paste just the text.
      if (hasText && isTyping(e.target)) return;
      if (!hasText) e.preventDefault();
      images.forEach((f) => addAttachment(f, "Pasted"));
      setShowChat(true);
      requestAnimationFrame(() => chatRef.current?.focus());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [chat, addAttachment]);

  // Shortcuts: Ctrl/Cmd+K asks about the selection, S snips, Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        askAboutSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && pdf) {
        // Our search knows every page (the browser's only sees the rendered ones).
        e.preventDefault();
        const sel = window.getSelection()?.toString().trim();
        if (sel && sel.length < 80) setSearchQuery(sel.replace(/\s+/g, " "));
        setSearchOpen(true);
        setSearchFocus(Date.now());
      } else if (e.key === "Escape" && (snipping || snipped)) {
        if (snipped) finishSnipping();
        else setSnipping(false);
      } else if (e.key === "Escape" && selection) {
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        if (snipping) setSnipping(false);
        else startSnip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askAboutSelection, selection, snipping, snipped, startSnip, finishSnipping, pdf]);

  // --- Resizable chat panel ---
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const maxChat = Math.max(CHAT_MIN, winWidth - (showSidebar ? SIDEBAR_WIDTH : 0) - VIEWER_MIN);
  const effectiveChatWidth = Math.min(Math.max(chatWidth, CHAT_MIN), maxChat);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let width = effectiveChatWidth;
    const onMove = (ev: PointerEvent) => {
      width = Math.min(Math.max(window.innerWidth - ev.clientX, CHAT_MIN), maxChat);
      setChatWidth(width);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      setResizing(false);
      store.set("chatWidth", String(Math.round(width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    handle.addEventListener("lostpointercapture", onUp, { once: true });
  };

  const zoomBy = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= scale - 0.001);
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > scale + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001);
    setZoom(next ?? ZOOM_STEPS[Math.max(0, i)]);
  };

  // Drag & drop PDFs anywhere.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setDragging(true));
    const leave = (e: DragEvent) => hasFiles(e) && --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // Dropped onto a folder in the sidebar: already uploaded into it.
      if ((e as DragEvent & { ydustHandled?: boolean }).ydustHandled) return;
      void upload(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [upload]);

  return (
    <div
      className={clsx(
        "flex h-dvh overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100",
        resizing && "cursor-col-resize select-none",
      )}
    >
      {showSidebar && (
        <div className="w-64 shrink-0 border-r border-zinc-200 dark:border-zinc-800">
          <Sidebar
            docs={docs}
            folders={folders}
            activeId={activeId}
            uploading={uploading}
            indexing={new Set(Object.keys(progress))}
            onSelect={setActiveId}
            onUpload={(files, folderId) => void upload(files, folderId)}
            onDelete={remove}
            onRename={rename}
            onCreateFolder={createFolder}
            onRenameFolder={renameFolder}
            onDeleteFolder={removeFolder}
            onMove={moveDoc}
          />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
          <button onClick={() => setShowSidebar((v) => !v)} className="icon-btn" title="Toggle library">
            <PanelLeft className="size-4" />
          </button>
          {pdf && (
            <button
              onClick={() => {
                setShowOutline((v) => !v);
                store.set("outline", showOutline ? "0" : "1");
              }}
              className={clsx("icon-btn", showOutline && "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100")}
              title="Table of contents"
            >
              <ListTree className="size-4" />
            </button>
          )}
          <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{doc?.name ?? ""}</div>
          {activeId && progress[activeId] && (
            <span className="mr-2 flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
              <Loader2 className="size-3 animate-spin" />
              Reading pages {progress[activeId].done}/{progress[activeId].total}
            </span>
          )}
          {pdf && (
            <>
              <PageInput page={page} total={pdf.numPages} onGo={jumpTo} />
              <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
              <button onClick={() => zoomBy(-1)} className="icon-btn" title="Zoom out">
                <Minus className="size-4" />
              </button>
              <span className="w-11 text-center text-xs text-zinc-500 tabular-nums">{Math.round(scale * 100)}%</span>
              <button onClick={() => zoomBy(1)} className="icon-btn" title="Zoom in">
                <Plus className="size-4" />
              </button>
              <button
                onClick={() => setZoom("fit")}
                className={clsx("icon-btn", zoom === "fit" && "text-violet-600 dark:text-violet-400")}
                title="Fit width"
              >
                <Maximize2 className="size-4" />
              </button>
              <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
              <button
                onClick={() => {
                  setSearchOpen((o) => !o);
                  setSearchFocus(Date.now());
                }}
                className={clsx("icon-btn", searchOpen && "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100")}
                title="Search in document (Ctrl+F)"
              >
                <Search className="size-4" />
              </button>
              <button
                onClick={() => {
                  setShowMarks((v) => !v);
                  store.set("marks", showMarks ? "0" : "1");
                }}
                className={clsx("icon-btn", showMarks && "text-amber-600 dark:text-amber-400")}
                title={showMarks ? "Hide passages you asked about" : "Highlight passages you asked about"}
              >
                <Highlighter className="size-4" />
              </button>
              <AppearanceMenu
                value={appearance}
                onChange={(a) => {
                  setAppearance(a);
                  store.set("appearance", JSON.stringify(a));
                }}
              />
              <button
                onClick={() => (snipping ? setSnipping(false) : startSnip())}
                className={clsx("icon-btn", snipping && "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300")}
                title="Take a picture of part of the page (S)"
              >
                <Camera className="size-4" />
              </button>
            </>
          )}
          <button onClick={() => setShowChat((v) => !v)} className="icon-btn" title="Toggle chat">
            <PanelRight className="size-4" />
          </button>
        </div>

        <div className={clsx("flex min-h-0 flex-1", resizing && "pointer-events-none")}>
        {showOutline && pdf && doc && (
          <div className="w-64 shrink-0 border-r border-zinc-200 dark:border-zinc-800">
            <OutlinePanel
              pdf={pdf}
              page={page}
              onJump={jumpTo}
              onClose={() => {
                setShowOutline(false);
                store.set("outline", "0");
              }}
            />
          </div>
        )}
        <div className="relative min-h-0 min-w-0 flex-1">
          {searchOpen && pdf && doc && (
            <SearchBar
              query={searchQuery}
              onQuery={setSearchQuery}
              hits={searchHits}
              current={searchIndex}
              loading={searchLoading}
              unavailable={doc.hasText === false}
              focusNonce={searchFocus}
              onGo={(i) => {
                setSearchIndex(i);
                setSearchNonce(Date.now());
              }}
              onClose={() => setSearchOpen(false)}
            />
          )}
          {snipping && (
            <div className="animate-pop absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 py-1.5 pr-1.5 pl-4 text-xs text-white shadow-xl dark:bg-zinc-100 dark:text-zinc-900">
              <Camera className="size-3.5 text-violet-400 dark:text-violet-600" />
              <span>Drag a box around what you want to capture</span>
              <button
                onClick={() => setSnipping(false)}
                className="rounded-full bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20 dark:bg-zinc-900/10 dark:hover:bg-zinc-900/20"
              >
                Cancel <span className="opacity-60">Esc</span>
              </button>
            </div>
          )}
          {snipped && (
            <div className="animate-pop absolute bottom-5 left-1/2 z-30 flex w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-2xl shadow-zinc-900/20 dark:border-zinc-700 dark:bg-zinc-900">
              <img
                src={snipped.url}
                alt="Snapshot"
                className="h-14 w-20 shrink-0 rounded-lg border border-zinc-200 bg-white object-contain dark:border-zinc-700"
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-sm font-medium">
                  <Check className="size-4 text-emerald-500" /> Added to chat
                </p>
                <p className="text-xs text-zinc-500">
                  {attachments.length} picture{attachments.length === 1 ? "" : "s"} attached. Take another?
                </p>
              </div>
              <button
                onClick={startSnip}
                disabled={attachments.length >= MAX_ATTACHMENTS}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium transition hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <Camera className="size-3.5" /> Another
              </button>
              <button
                onClick={finishSnipping}
                className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-500"
              >
                Done
              </button>
            </div>
          )}
          {!activeId ? (
            <EmptyState onPick={upload} />
          ) : loadError ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-red-600">Could not open this PDF: {loadError}</div>
          ) : !pdf || !doc ? (
            <div className="flex h-full items-center justify-center text-zinc-400">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <PdfViewer
              key={doc.id}
              pdf={pdf}
              zoom={zoom}
              initialPage={doc.lastPage}
              jump={jump}
              onPageChange={setPage}
              onSelection={setSelection}
              onScale={setScale}
              snipping={snipping}
              onSnip={handleSnip}
              search={searchState}
              marks={marks}
              flash={flashTarget}
              onMarkClick={showMessage}
              pageFilter={pagesFilter}
              tint={pagesTint}
              darkPages={appearance.mode === "dark"}
            />
          )}
        </div>
        </div>
      </main>

      {showChat && chat && (
        <div className="relative shrink-0 border-l border-zinc-200 dark:border-zinc-800" style={{ width: effectiveChatWidth }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat"
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => {
              setChatWidth(CHAT_DEFAULT);
              store.set("chatWidth", String(CHAT_DEFAULT));
            }}
            className="group absolute inset-y-0 -left-1.5 z-30 w-3 cursor-col-resize"
          >
            <div
              className={clsx(
                "mx-auto h-full w-0.5 transition-colors group-hover:bg-violet-400",
                resizing && "bg-violet-500 group-hover:bg-violet-500",
              )}
            />
          </div>
          <ChatPanel
            ref={chatRef}
            chat={chat}
            folder={activeFolder ? { name: activeFolder.name, count: activeFolder.docIds.length } : null}
            scope={scope}
            onScope={(s) => {
              setScope(s);
              store.set("scope", s);
            }}
            hasDoc={hasDoc}
            docName={docName}
            streaming={streaming}
            quote={quote}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onStartSnip={startSnip}
            providers={providers}
            provider={provider}
            onProvider={(p) => {
              setProvider(p);
              store.set("provider", p);
            }}
            model={model}
            onModel={(m) => {
              setModels((all) => ({ ...all, [provider]: m }));
              store.set(`model:${provider}`, m);
            }}
            effort={effort}
            onEffort={(e) => {
              setEfforts((all) => ({ ...all, [provider]: e }));
              store.set(`effort:${provider}`, e);
            }}
            onClearQuote={() => setQuote(null)}
            onSend={(q) => void send(q, quote, attachments, { mode: checkMode ? "check" : undefined })}
            onStop={stop}
            onReset={reset}
            onJump={onCite}
            onJumpQuote={jumpToQuote}
            language={language}
            textSize={textSize}
            level={level}
            onLevel={(l) => {
              setLevel(l);
              store.set("level", l);
            }}
            checkMode={checkMode}
            onCheckMode={setCheckMode}
            onSecondOpinion={secondOpinion}
            tab={panelTab}
            onTab={setPanelTab}
            noteOwners={noteOwners}
            openNote={openNote}
            onOpenNote={setOpenNote}
            notesRefresh={notesRefresh}
            onInsertAnswer={insertAnswer}
            onDraftDecided={draftDecided}
            onRequestChanges={(d, feedback) => void send(feedback, null, [], { draft: d })}
            onOpenChatNote={openChatNote}
            onPin={(mid, pinned) => void updateMessage(mid, { pinned })}
            onNote={(mid, note) => void updateMessage(mid, { note })}
            onLanguage={(l) => {
              setLanguage(l);
              store.set("lang", l);
            }}
            onTextSize={(t) => {
              setTextSize(t);
              store.set("textSize", t);
            }}
          />
        </div>
      )}

      {selection && (
        <SelectionMenu
          selection={selection}
          onAsk={askAboutSelection}
          onAction={(prompt) => {
            const q = takeSelection();
            if (q) void send(prompt, q);
          }}
          onCheck={() => {
            setCheckMode(true);
            askAboutSelection();
          }}
          openNote={(() => {
            const open = noteEditor.get();
            return open && panelTab === "notes" && showChat && noteOwners.some((o) => sameOwner(o, open.owner)) ? open.name : null;
          })()}
          onAddToNote={(anchor) => {
            const q = takeSelection();
            const from = doc && docs.find((d) => d.id === doc.id);
            if (!q || !from) return;
            toNote(anchor, "Quote this passage in…", (owner) => quoteForNote(q.text, pageLink(owner, q.page, from)));
          }}
        />
      )}

      {picker && noteOwners.length > 0 && (
        <NotePicker
          owners={noteOwners}
          anchor={picker.anchor}
          title={picker.title}
          onClose={() => setPicker(null)}
          onPick={(owner, name, isNew) => addToNote(owner, name, picker.block(owner), isNew)}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-violet-600/10 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-violet-500 bg-white/90 px-10 py-8 text-center shadow-2xl dark:bg-zinc-900/90">
            <FileUp className="mx-auto mb-2 size-8 text-violet-500" />
            <p className="font-medium">Drop PDFs to add them to your library</p>
            <p className="mt-1 text-xs text-zinc-500">…or onto a folder in the sidebar</p>
          </div>
        </div>
      )}

      {toast && (
        <div className="animate-pop fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-xl dark:bg-zinc-100 dark:text-zinc-900">
          {toast}
        </div>
      )}
    </div>
  );
}

function PageInput({ page, total, onGo }: { page: number; total: number; onGo: (p: number) => void }) {
  const [value, setValue] = useState(String(page));
  useEffect(() => setValue(String(page)), [page]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const n = Math.min(total, Math.max(1, Number(value) || 1));
        onGo(n);
        setValue(String(n));
      }}
      className="flex items-center gap-1 text-xs text-zinc-500"
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
        onFocus={(e) => e.target.select()}
        className="w-9 rounded-md border border-zinc-200 bg-transparent py-0.5 text-center text-zinc-800 tabular-nums outline-none focus:border-violet-400 dark:border-zinc-800 dark:text-zinc-200"
        aria-label="Page"
      />
      <span className="tabular-nums">/ {total}</span>
    </form>
  );
}

function EmptyState({ onPick }: { onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <button
        onClick={() => input.current?.click()}
        className="group flex w-full max-w-lg flex-col items-center rounded-3xl border-2 border-dashed border-zinc-200 px-10 py-16 text-center transition hover:border-violet-400 hover:bg-violet-50/40 dark:border-zinc-800 dark:hover:border-violet-500/50 dark:hover:bg-violet-500/5"
      >
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/25 transition group-hover:scale-105">
          <FileUp className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">Drop a PDF to start studying</h1>
        <p className="mt-1.5 max-w-sm text-sm text-zinc-500">
          Select any passage and ask Antigravity or Claude about it: explanations, summaries, quizzes. No copy-pasting needed.
        </p>
        <span className="mt-5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">Choose files</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onPick(files);
        }}
      />
    </div>
  );
}
