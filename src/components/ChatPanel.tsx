import clsx from "clsx";
import {
  ArrowUp,
  Camera,
  Check,
  Copy,
  Download,
  FileSearch,
  FileText,
  Folder,
  GraduationCap,
  Loader2,
  MessageSquarePlus,
  NotebookPen,
  Pin,
  PinOff,
  Quote as QuoteIcon,
  SearchCheck,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, type Chat, type Message, type MessageDraft, type NoteOwner, type ProviderInfo, type Quote, type ToolEvent } from "../lib/api";
import { chatMarkdown, downloadText, notesMarkdown, questionOf, safeFilename } from "../lib/export";
import { SIZE_CLASSES, type TextSize } from "../lib/settings";
import { ChatSettings } from "./ChatSettings";
import { DraftCard } from "./DraftCard";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import type { Anchor } from "./NotePicker";
import { NotesPanel, type OpenNote } from "./NotesPanel";
import { PROVIDER_ICON, ProviderSwitch } from "./ProviderSwitch";

export type Streaming = { text: string; tools: ToolEvent[]; drafts: MessageDraft[] };

/** An image waiting in the composer (a snip of the PDF or a pasted picture). */
export type Attachment = { key: string; blob: Blob; url: string; label: string };

export type ChatPanelHandle = { focus: () => void; showMessage: (id: string) => void };

/** Chat, the note files, and pinned answers. */
export type PanelTab = "chat" | "notes" | "pinned";

type Props = {
  chat: Chat;
  /** The folder of the open PDF (if any): then you can chat about the whole folder. */
  folder: { name: string; count: number } | null;
  scope: "doc" | "folder";
  onScope: (scope: "doc" | "folder") => void;
  streaming: Streaming | null;
  quote: Quote | null;
  attachments: Attachment[];
  onRemoveAttachment: (key: string) => void;
  onStartSnip: () => void;
  providers: ProviderInfo[];
  provider: string;
  onProvider: (id: string) => void;
  model: string;
  onModel: (id: string) => void;
  effort: string;
  onEffort: (effort: string) => void;
  onClearQuote: () => void;
  onSend: (question: string) => void;
  onStop: () => void;
  onReset: () => void;
  /** Open a page (of another document, if `doc` = its alias, else of the open PDF). */
  onJump: (page: number, doc?: string) => void;
  hasDoc: (alias: string) => boolean;
  /** Name of a document by id (quotes in folder chats). */
  docName: (id: string) => string | undefined;
  /** Jump to a quoted passage and flash it. */
  onJumpQuote: (q: Quote) => void;
  language: string;
  textSize: TextSize;
  level: string;
  onLanguage: (code: string) => void;
  onTextSize: (size: TextSize) => void;
  onLevel: (level: string) => void;
  /** "Check my understanding" mode for the next message. */
  checkMode: boolean;
  onCheckMode: (on: boolean) => void;
  onSecondOpinion: (messageId: string, providerId: string) => void;
  onPin: (messageId: string, pinned: boolean) => void;
  onNote: (messageId: string, note: string) => void;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** Whose notes the Notes tab shows: the open PDF, then its folder. */
  noteOwners: NoteOwner[];
  openNote: OpenNote | null;
  onOpenNote: (note: OpenNote | null) => void;
  notesRefresh: number;
  /** Choose a note to put this answer into (the picker opens at `at`). */
  onInsertAnswer: (messageId: string, at: Anchor) => void;
  /** A draft was accepted (into `accepted`) or discarded; `removed`: it and its earlier versions. */
  onDraftDecided: (d: MessageDraft, outcome: { accepted?: string; removed: string[] }) => void;
  onRequestChanges: (d: MessageDraft, feedback: string) => void;
  /** Open one of this chat's notes in the Notes tab (at a line). */
  onOpenChatNote: (name: string, line?: number) => void;
  onReviewNote: (owner: NoteOwner, name: string, mode: "review-note" | "challenge-note", lines?: [number, number]) => void;
  /** Under a review: ask for the fixes as a draft. */
  onProposeFixes: (noteName: string) => void;
};

/**
 * Folder chats: a bare "[p. 3](#page=3)" refers to the document cited just before it in the
 * same answer ("[Script, pp. 2–5](#doc=d2&page=2) … [p. 3](#page=3)"), not to the open PDF.
 */
function resolveBarePages(md: string) {
  let last: string | null = null;
  return md.replace(/\]\(#(?:doc=([\w-]+)&)?page=(\d+)\)/g, (m, doc: string | undefined, page: string) => {
    if (doc) {
      last = doc;
      return m;
    }
    return last ? `](#doc=${last}&page=${page})` : m;
  });
}
const keep = (md: string) => md;

const STARTERS = {
  doc: [
    "Give me an overview of this document.",
    "What are the key concepts I should learn here?",
    "Make me a short study plan for this document.",
  ],
  folder: [
    "Give me an overview of these documents and how they fit together.",
    "What are the key concepts across these documents?",
    "Make me a study plan for this folder.",
  ],
};

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(props, ref) {
  const {
    chat,
    folder,
    scope,
    onScope,
    hasDoc,
    docName,
    streaming,
    quote,
    attachments,
    onRemoveAttachment,
    onStartSnip,
    providers,
    provider,
    onProvider,
    model,
    onModel,
    effort,
    onEffort,
    onClearQuote,
    onSend,
    onStop,
    onReset,
    onJump,
    onJumpQuote,
    language,
    textSize,
    level,
    onLanguage,
    onTextSize,
    onLevel,
    checkMode,
    onCheckMode,
    tab,
    onTab: setTab,
  } = props;
  const [input, setInput] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        setTab("chat");
        requestAnimationFrame(() => textarea.current?.focus());
      },
      showMessage: (id: string) => {
        setTab("chat");
        stick.current = false;
        requestAnimationFrame(() => {
          // Show the answer to that question (the message after it), if there is one.
          const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          setFlashId(id);
          setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1800);
        });
      },
    }),
    [],
  );

  // Auto-scroll while the answer streams in, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && tab === "chat") el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, streaming?.text, streaming?.tools.length, tab]);

  useEffect(() => {
    stick.current = true;
    setConfirmReset(false);
  }, [chat.kind, chat.id]);

  // Grow the textarea with its content.
  useEffect(() => {
    const t = textarea.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }, [input]);

  const canSend = !!input.trim() || (attachments.length > 0 && !checkMode);
  const submit = (text = input) => {
    let q = text.trim();
    if (!q && attachments.length && !checkMode) q = attachments.length > 1 ? "Explain what these images show." : "Explain what this image shows.";
    if (!q || streaming) return;
    onSend(q);
    setInput("");
    stick.current = true;
  };

  const empty = chat.messages.length === 0 && !streaming;
  const pinnedCount = chat.messages.filter((m) => m.pinned).length;
  const isFolder = chat.kind === "folder";
  const prep = isFolder ? resolveBarePages : keep;
  const label = (id?: string) => providers.find((p) => p.id === (id ?? "agy"))?.label;

  const exportCurrent = () => {
    const md = tab === "pinned" ? notesMarkdown(chat, providers, docName) : chatMarkdown(chat, providers, docName);
    downloadText(`${safeFilename(chat.name)} - ${tab === "pinned" ? "pinned" : "chat"}.md`, md);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <ProviderSwitch providers={providers} value={provider} disabled={!!streaming} onChange={onProvider} />
        <ModelPicker provider={providers.find((p) => p.id === provider)} value={model} onChange={onModel} effort={effort} onEffort={onEffort} />
        <ChatSettings
          language={language}
          textSize={textSize}
          level={level}
          onLanguage={onLanguage}
          onTextSize={onTextSize}
          onLevel={onLevel}
        />
        {confirmReset ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                onReset();
                setConfirmReset(false);
              }}
              className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
            >
              Clear chat
            </button>
            <button onClick={() => setConfirmReset(false)} className="icon-btn" title="Cancel">
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmReset(true)} disabled={empty} className="icon-btn" title="New chat (forgets this conversation)">
            <MessageSquarePlus className="size-4" />
          </button>
        )}
      </header>

      {folder && (
        <div className="flex shrink-0 items-center gap-1 border-b border-zinc-100 px-3 py-1.5 dark:border-zinc-900" role="radiogroup" aria-label="Chat about">
          {(["doc", "folder"] as const).map((s) => {
            const Icon = s === "doc" ? FileText : Folder;
            return (
              <button
                key={s}
                role="radio"
                aria-checked={scope === s}
                disabled={!!streaming}
                onClick={() => onScope(s)}
                className={clsx(
                  "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-50",
                  scope === s
                    ? "bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/30"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200",
                )}
                title={s === "doc" ? "Chat about this PDF (the assistant may look into the folder's other documents)" : "One chat about all documents of the folder"}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{s === "doc" ? "This PDF" : `Folder “${folder.name}” · ${folder.count}`}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-100 px-3 dark:border-zinc-900">
        {(["chat", "notes", "pinned"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition",
              tab === t
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
            title={t === "notes" ? "Your notes: Markdown files next to the PDF" : t === "pinned" ? "Answers you pinned" : undefined}
          >
            {t === "notes" && <NotebookPen className="size-3.5" />}
            {t === "pinned" && <Pin className="size-3.5" />}
            {t === "chat" ? "Chat" : t === "notes" ? "Notes" : "Pinned"}
            {t === "pinned" && pinnedCount > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                {pinnedCount}
              </span>
            )}
          </button>
        ))}
        {tab !== "notes" && (
          <button
            onClick={exportCurrent}
            disabled={tab === "chat" ? empty : pinnedCount === 0}
            className="icon-btn ml-auto size-7"
            title={tab === "pinned" ? "Export pinned answers as Markdown" : "Export chat as Markdown"}
          >
            <Download className="size-3.5" />
          </button>
        )}
      </div>

      {tab === "notes" && (
        <div className="min-h-0 flex-1">
          <NotesPanel
            owners={props.noteOwners}
            open={props.openNote}
            onOpen={props.onOpenNote}
            refresh={props.notesRefresh}
            onJump={onJump}
            hasDoc={hasDoc}
            textSize={textSize}
            onReview={props.onReviewNote}
          />
        </div>
      )}

      <div
        ref={scroller}
        hidden={tab === "notes"}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {tab === "pinned" ? (
          <PinnedView {...props} label={label} onPreview={setPreview} prep={prep} />
        ) : (
          <>
            {!isFolder && chat.hasText === false && (
              <div className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <TriangleAlert className="size-4 shrink-0" />
                <p>
                  This PDF has no text layer (it's probably scanned), so you can't select text in it and the agent can't read it
                  directly. Use the camera button to send pictures of the parts you're asking about.
                </p>
              </div>
            )}
            {empty ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">
                  <QuoteIcon className="size-5" />
                </div>
                <p className="text-sm font-medium">{isFolder ? `Chat about all of “${chat.name}”` : "Select text in the PDF to ask about it"}</p>
                <p className="mt-1 max-w-64 text-xs text-zinc-500">
                  {isFolder
                    ? "Ask about anything in the folder's documents, or select a passage in any of them. Answers cite pages you can click."
                    : "Or just ask a question about the whole document. Answers cite pages you can click."}
                </p>
                {(isFolder || chat.hasText) && (
                  <div className="mt-5 flex w-full max-w-72 flex-col gap-1.5">
                    {STARTERS[chat.kind].map((s) => (
                      <button
                        key={s}
                        onClick={() => submit(s)}
                        className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-xs text-zinc-600 transition hover:border-violet-300 hover:bg-violet-50/50 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-violet-500/40 dark:hover:bg-violet-500/5 dark:hover:text-zinc-100"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {chat.messages.map((m, i) => (
                  <MessageView
                    key={m.id}
                    {...props}
                    prep={prep}
                    m={m}
                    next={chat.messages[i + 1]}
                    flashing={flashId === m.id}
                    busy={!!streaming}
                    label={label}
                    onPreview={setPreview}
                  />
                ))}
                {streaming && <StreamingView s={streaming} size={textSize} onJump={onJump} hasDoc={hasDoc} prep={prep} drafts={<Drafts {...props} list={streaming.drafts} busy />} />}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <div
          className={clsx(
            "rounded-2xl border bg-zinc-50 shadow-sm transition focus-within:bg-white focus-within:ring-4 dark:bg-zinc-900 dark:focus-within:bg-zinc-900",
            checkMode
              ? "border-emerald-300 focus-within:border-emerald-400 focus-within:ring-emerald-500/10 dark:border-emerald-500/40"
              : "border-zinc-200 focus-within:border-violet-400 focus-within:ring-violet-500/10 dark:border-zinc-800",
          )}
        >
          {checkMode && (
            <div className="flex items-center gap-2 border-b border-emerald-100 px-3 py-1.5 text-xs text-emerald-700 dark:border-emerald-500/20 dark:text-emerald-300">
              <GraduationCap className="size-3.5" />
              <span className="flex-1">
                <b>Check my understanding</b> — explain it in your own words; you'll get feedback and hints, not the solution.
              </span>
              <button onClick={() => onCheckMode(false)} className="text-emerald-500 hover:text-emerald-800 dark:hover:text-emerald-100" title="Turn off">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {quote && (
            <div className="flex items-start gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
              <p className="line-clamp-3 flex-1 text-xs text-zinc-600 dark:text-zinc-400">
                <button onClick={() => onJumpQuote(quote)} className="mr-1 font-semibold text-violet-600 dark:text-violet-400">
                  {isFolder && quote.doc && docName(quote.doc) ? `${docName(quote.doc)}, ` : ""}p. {quote.page}
                </button>
                {quote.text}
              </p>
              <button onClick={onClearQuote} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Remove">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
              {attachments.map((a) => (
                <div key={a.key} className="group/att relative">
                  <button
                    type="button"
                    onClick={() => setPreview(a.url)}
                    className="block overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700"
                    title={a.label}
                  >
                    <img src={a.url} alt={a.label} className="h-16 w-24 bg-white object-contain" />
                  </button>
                  <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-zinc-900/70 px-1 text-[9px] font-medium text-white">
                    {a.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.key)}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-zinc-900 text-white opacity-0 shadow transition group-hover/att:opacity-100 focus:opacity-100 dark:bg-zinc-100 dark:text-zinc-900"
                    title="Remove"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-0.5 p-2">
            <button
              type="button"
              onClick={onStartSnip}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              title="Take a picture of part of the page (S)"
            >
              <Camera className="size-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => {
                onCheckMode(!checkMode);
                textarea.current?.focus();
              }}
              aria-pressed={checkMode}
              className={clsx(
                "flex size-9 shrink-0 items-center justify-center rounded-xl transition",
                checkMode
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                  : "text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
              )}
              title="Check my understanding: explain it in your own words"
            >
              <GraduationCap className="size-[18px]" />
            </button>
            <textarea
              ref={textarea}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape" && quote) onClearQuote();
              }}
              placeholder={
                checkMode
                  ? quote
                    ? "Explain the passage in your own words…"
                    : "Explain it in your own words…"
                  : attachments.length
                    ? "Ask about the picture…"
                    : quote
                      ? "Ask about the selected passage…"
                      : isFolder
                      ? "Ask anything about this folder…"
                      : "Ask anything about this document…"
              }
              className={clsx(
                "max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 outline-none placeholder:text-zinc-400",
                SIZE_CLASSES[textSize].text,
              )}
            />
            {streaming ? (
              <button onClick={onStop} className="send-btn bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900" title="Stop">
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={() => submit()}
                disabled={!canSend}
                className={clsx("send-btn", checkMode ? "bg-emerald-600 hover:bg-emerald-500" : "bg-violet-600 hover:bg-violet-500")}
                title="Send (Enter)"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-zinc-400">
          Enter send · Ctrl+K ask selection · Ctrl+F search · S snip · Ctrl+V paste picture
        </p>
      </div>

      {preview && (
        <div
          className="animate-pop fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-zinc-950/70 p-8 backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <img src={preview} alt="" className="max-h-full max-w-full rounded-lg bg-white shadow-2xl" />
        </div>
      )}
    </aside>
  );
});

type ViewProps = Props & {
  label: (providerId?: string) => string | undefined;
  onPreview: (url: string) => void;
  /** Prepares an answer's Markdown for display (see resolveBarePages). */
  prep: (md: string) => string;
};

function QuoteChip({ q, size, onJumpQuote, docName }: { q: Quote; size: TextSize; onJumpQuote: Props["onJumpQuote"]; docName: Props["docName"] }) {
  const from = q.doc ? docName(q.doc) : undefined;
  return (
    <button
      onClick={() => onJumpQuote(q)}
      title="Show this passage in the PDF"
      className={clsx(
        "max-w-full rounded-xl border-l-2 border-violet-400 bg-violet-50/70 px-3 py-1.5 text-left text-zinc-600 transition hover:bg-violet-50 dark:bg-violet-500/10 dark:text-zinc-400",
        SIZE_CLASSES[size].small,
      )}
    >
      <span className="mr-1 font-semibold text-violet-600 dark:text-violet-400">
        {from ? `${from}, ` : ""}p. {q.page}
      </span>
      <span className="line-clamp-3">{q.text}</span>
    </button>
  );
}

function MessageView(
  props: ViewProps & { m: Message; next?: Message; flashing: boolean; busy: boolean },
) {
  const { m, next, flashing, textSize: size, chat, providers, busy, label, onJump, hasDoc, docName, onJumpQuote, onPreview, onPin, onSecondOpinion, prep, onCheckMode } = props;

  if (m.role === "user") {
    if (m.secondOpinionOf) {
      const by = label(next?.role === "assistant" ? next.provider : undefined);
      return (
        <div data-mid={m.id} className="flex items-center gap-3 text-[11px] font-medium text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          Second opinion{by ? ` from ${by}` : ""}
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    }
    return (
      <div
        data-mid={m.id}
        className={clsx("ml-8 flex scroll-mt-4 flex-col items-end gap-1.5 rounded-2xl transition", flashing && "ring-4 ring-amber-300/60 ring-offset-4 dark:ring-offset-zinc-950")}
      >
        {m.images && m.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {m.images.map((img) => {
              const url = api.imageUrl(chat, img);
              return (
                <button
                  key={img}
                  type="button"
                  onClick={() => onPreview(url)}
                  className="overflow-hidden rounded-xl border border-zinc-200 bg-white transition hover:opacity-90 dark:border-zinc-700"
                >
                  <img src={url} alt="Attached" className="max-h-40 max-w-56 object-contain" loading="lazy" />
                </button>
              );
            })}
          </div>
        )}
        {m.quote && <QuoteChip q={m.quote} size={size} onJumpQuote={onJumpQuote} docName={docName} />}
        {m.draftRef && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-violet-600 dark:text-violet-400">
            <NotebookPen className="size-3.5" /> Changes to the draft for {m.draftRef.target}
            {m.draftRef.revision > 1 ? ` (version ${m.draftRef.revision})` : ""}
          </span>
        )}
        {m.mode === "check" && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <GraduationCap className="size-3.5" /> My explanation — please check
          </span>
        )}
        {m.noteRef && <NoteChip noteRef={m.noteRef} mode={m.mode} onOpen={(line) => props.onOpenChatNote(m.noteRef!.name, line)} />}
        {(!m.noteRef || m.noteRef.instructions) && <div
          className={clsx(
            "rounded-2xl rounded-br-md px-3.5 py-2 whitespace-pre-wrap",
            m.mode === "check"
              ? "bg-emerald-700 text-white dark:bg-emerald-600"
              : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
            SIZE_CLASSES[size].text,
          )}
        >
          {m.noteRef ? m.noteRef.instructions : m.content}
        </div>}
      </div>
    );
  }
  if (m.error) {
    return (
      <div>
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs whitespace-pre-wrap text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <TriangleAlert className="size-4 shrink-0" />
          <p className="min-w-0 break-words">{m.content}</p>
        </div>
        {m.drafts?.length ? <Drafts {...props} list={m.drafts} busy={busy} /> : null}
      </div>
    );
  }
  if (!m.content.trim()) {
    return (
      <div>
        <p className="text-xs text-zinc-400 italic">{m.drafts?.length ? "" : "Stopped before answering."}</p>
        {m.drafts?.length ? <Drafts {...props} list={m.drafts} busy={busy} /> : null}
      </div>
    );
  }
  const other = providers.find((p) => p.available && p.id !== (m.provider ?? "agy"));
  // An answer to a review or challenge of a note: its "[L12]" links show lines of that note.
  const asked = questionOf(chat.messages, m);
  const reviewed = asked?.noteRef && (asked.mode === "review-note" || asked.mode === "challenge-note") ? asked : undefined;
  return (
    <div className="group">
      <Markdown onJump={onJump} hasDoc={hasDoc} size={size} onNoteLine={reviewed ? (line) => props.onOpenChatNote(reviewed.noteRef!.name, line) : undefined}>
        {prep(m.content)}
      </Markdown>
      {reviewed && !busy && !m.stopped && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reviewed.mode === "review-note" ? (
            <button
              onClick={() => props.onProposeFixes(reviewed.noteRef!.name)}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
              title="The assistant drafts the corrections; you review them as a diff"
            >
              <NotebookPen className="size-3.5" /> Propose fixes
            </button>
          ) : (
            <button
              onClick={() => onCheckMode(true)}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
              title="Answer in your own words: you get feedback and hints, not the solution"
            >
              <GraduationCap className="size-3.5" /> Answer these
            </button>
          )}
        </div>
      )}
      {m.drafts?.length ? <Drafts {...props} list={m.drafts} busy={busy} /> : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
        <ProviderTag id={m.provider ?? "agy"} label={label(m.provider)} model={m.model} modelLabel={m.modelLabel} effort={m.effort} />
        {m.stopped && <span>Stopped</span>}
        <button
          onClick={() => onPin(m.id, !m.pinned)}
          className={clsx(
            "flex items-center gap-1 transition hover:text-amber-600",
            m.pinned ? "text-amber-600 dark:text-amber-400" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
          )}
          title={m.pinned ? "Unpin" : "Pin this answer (see the Pinned tab)"}
        >
          {m.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          {m.pinned ? "Pinned" : "Pin"}
        </button>
        <CopyButton text={m.content} />
        <InsertButton onClick={(at) => props.onInsertAnswer(m.id, at)} />
        {other && !busy && (
          <button
            onClick={() => onSecondOpinion(m.id, other.id)}
            className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 hover:text-zinc-700 focus:opacity-100 dark:hover:text-zinc-200"
            title={`Ask ${other.label} the same question and let it check this answer`}
          >
            {(() => {
              const { icon: Icon, color } = PROVIDER_ICON[other.id] ?? PROVIDER_ICON.agy;
              return <Icon className={clsx("size-3", color)} />;
            })()}
            Ask {other.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Pinned answers with the question they belong to, and an own note each. */
function PinnedView(props: ViewProps) {
  const { chat, textSize: size, label, onJump, hasDoc, docName, onJumpQuote, onPin, onNote, prep } = props;
  const pinned = chat.messages.filter((m) => m.role === "assistant" && m.pinned);
  if (!pinned.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
          <Pin className="size-5" />
        </div>
        <p className="text-sm font-medium">Nothing pinned yet</p>
        <p className="mt-1 max-w-64 text-xs text-zinc-500">
          Hover an answer in the chat and click <b>Pin</b> to keep it here — you can add a comment to every pinned answer, or put it into one of
          your notes.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pinned.map((a) => {
        const q = questionOf(chat.messages, a);
        return (
          <article key={a.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-start gap-2">
              <p className="min-w-0 flex-1 text-xs font-medium text-zinc-500">{q?.content.split("\n")[0].slice(0, 140)}</p>
              <InsertButton compact onClick={(at) => props.onInsertAnswer(a.id, at)} />
              <button onClick={() => onPin(a.id, false)} className="text-zinc-400 hover:text-amber-600" title="Unpin">
                <PinOff className="size-3.5" />
              </button>
            </div>
            {q?.quote && (
              <div className="mb-2">
                <QuoteChip q={q.quote} size="s" onJumpQuote={onJumpQuote} docName={docName} />
              </div>
            )}
            <NoteField value={a.note ?? ""} onSave={(v) => onNote(a.id, v)} />
            <details className="group/ans mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-zinc-400 select-none hover:text-zinc-600 dark:hover:text-zinc-300">
                Answer by {label(a.provider)}
                {a.modelLabel ? ` · ${a.modelLabel}` : ""}
              </summary>
              <div className="mt-2">
                <Markdown onJump={onJump} hasDoc={hasDoc} size={size}>
                  {prep(a.content)}
                </Markdown>
              </div>
            </details>
          </article>
        );
      })}
    </div>
  );
}

/** Own note, saved when you leave the field. */
function NoteField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.max(t.scrollHeight, 36)}px`;
  }, [draft]);
  return (
    <textarea
      ref={area}
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      placeholder="Your note… (e.g. the key idea in one sentence)"
      className="w-full resize-none rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-1.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-amber-400 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-zinc-100"
    />
  );
}

function StreamingView({
  s,
  size,
  onJump,
  hasDoc,
  prep,
  drafts,
}: {
  s: Streaming;
  size: TextSize;
  onJump: Props["onJump"];
  hasDoc: Props["hasDoc"];
  prep: ViewProps["prep"];
  drafts: React.ReactNode;
}) {
  const active = s.tools.at(-1);
  const status = active?.state === "active" ? toolLabel(active) : s.text ? null : "Thinking…";
  return (
    <div>
      {s.text && (
        <Markdown onJump={onJump} hasDoc={hasDoc} size={size}>
          {prep(s.text)}
        </Markdown>
      )}
      {status && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
          {active?.state === "active" ? <FileSearch className="size-3.5 animate-pulse text-violet-500" /> : <Loader2 className="size-3.5 animate-spin" />}
          <span className="shimmer">{status}</span>
        </div>
      )}
      {!status && <span className="caret" />}
      {drafts}
    </div>
  );
}

/** The note drafts of an answer. */
function Drafts(props: Props & { list: MessageDraft[]; busy: boolean }) {
  const { chat, list, busy, onJump, hasDoc, textSize, onDraftDecided, onRequestChanges, onOpenChatNote } = props;
  return (
    <div className="flex flex-col">
      {list.map((d) => (
        <DraftCard
          key={d.id}
          chat={chat}
          d={d}
          busy={busy}
          onJump={onJump}
          hasDoc={hasDoc}
          textSize={textSize}
          onDecided={onDraftDecided}
          onRequestChanges={onRequestChanges}
          onOpenNote={onOpenChatNote}
        />
      ))}
    </div>
  );
}

/** Who answered; hover (or focus) shows the model that was used. */
function ProviderTag({
  id,
  label,
  model,
  modelLabel,
  effort,
}: {
  id: string;
  label?: string;
  model?: string;
  modelLabel?: string;
  effort?: string;
}) {
  const { icon: Icon, color } = PROVIDER_ICON[id] ?? PROVIDER_ICON.agy;
  return (
    <span
      tabIndex={0}
      className="tip-host relative flex cursor-default items-center gap-1 rounded outline-none hover:text-zinc-600 focus-visible:ring-2 focus-visible:ring-violet-400 dark:hover:text-zinc-300"
    >
      <Icon className={clsx("size-3", color)} />
      {label ?? id}
      <span
        role="tooltip"
        className="tip pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 w-max max-w-64 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
      >
        {model || modelLabel ? (
          <>
            <span className="block font-semibold">{modelLabel ?? model}</span>
            {model && model !== modelLabel && <span className="block font-mono text-[10px] opacity-70">{model}</span>}
            {effort && <span className="mt-0.5 block text-[10px] opacity-80">Effort: {effort}</span>}
          </>
        ) : (
          <span className="opacity-80">Model not recorded (answered before ydust stored it)</span>
        )}
      </span>
    </span>
  );
}

function toolLabel(t: ToolEvent) {
  // ydust's own tools: "ydust/search" (Antigravity) or "mcp__ydust__search" (Claude).
  const own = t.name.match(/^(?:ydust\/|mcp__ydust__)(\w+)$/)?.[1];
  if (own === "search") return t.detail ? `Searching for “${t.detail}”…` : "Searching the documents…";
  if (own === "read_pages") return t.detail ? `Reading ${t.detail}…` : "Reading pages…";
  if (own === "list_notes") return "Looking at your notes…";
  if (own === "read_note") return t.detail ? `Reading your note ${t.detail}…` : "Reading your note…";
  if (own === "write_note") return t.detail ? `Drafting ${t.detail}…` : "Drafting a note…";
  if (["read_file", "view_file", "Read"].includes(t.name)) return "Reading the document…";
  if (["grep_search", "Grep", "Glob"].includes(t.name)) return "Searching the document…";
  return `Using ${t.name.replace(/_/g, " ")}…`;
}

/** "Review of summary.md (lines 3–8)" on a question about a note. */
function NoteChip({ noteRef, mode, onOpen }: { noteRef: NonNullable<Message["noteRef"]>; mode?: Message["mode"]; onOpen: (line?: number) => void }) {
  const Icon = mode === "challenge-note" ? GraduationCap : mode === "fix-note" ? NotebookPen : SearchCheck;
  const lines = noteRef.lines ? ` (${noteRef.lines[0] === noteRef.lines[1] ? `line ${noteRef.lines[0]}` : `lines ${noteRef.lines[0]}–${noteRef.lines[1]}`})` : "";
  return (
    <button
      onClick={() => onOpen(noteRef.lines?.[0])}
      className="flex max-w-full items-center gap-1.5 rounded-xl border-l-2 border-emerald-400 bg-emerald-50/70 px-3 py-1.5 text-left text-xs font-medium text-emerald-800 transition hover:bg-emerald-50 dark:bg-emerald-500/10 dark:text-emerald-300"
      title="Open the note"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">
        {mode === "challenge-note" ? "Challenge me on" : mode === "fix-note" ? "Fixes for" : "Review of"} {noteRef.name}
        {lines}
      </span>
    </button>
  );
}

/** "Insert into note": opens the note picker below the button. */
function InsertButton({ onClick, compact }: { onClick: (at: Anchor) => void; compact?: boolean }) {
  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onClick({ left: r.left, top: r.bottom + 4 });
  };
  if (compact) {
    return (
      <button onClick={open} className="text-zinc-400 hover:text-violet-600" title="Insert into a note">
        <NotebookPen className="size-3.5" />
      </button>
    );
  }
  return (
    <button
      onClick={open}
      className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 hover:text-zinc-700 focus:opacity-100 dark:hover:text-zinc-200"
      title="Insert this answer into one of your notes"
    >
      <NotebookPen className="size-3" />
      Insert into note
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className={clsx(
        "flex items-center gap-1 opacity-0 transition group-hover:opacity-100 hover:text-zinc-700 focus:opacity-100 dark:hover:text-zinc-200",
        done && "opacity-100",
      )}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}
