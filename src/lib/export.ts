import type { Chat, Highlight, Message, Note, NoteOwner, ProviderInfo, Quote } from "./api";
import { pageLabel, type PageLabels } from "./pageLabels";

/** Resolves a document id to its name (quotes in folder chats). */
type DocName = (id: string) => string | undefined;

/** In-app links "[p. 3](#page=3)", "[Script, p. 3](#doc=d2&page=3)" mean nothing outside ydust: keep them as text. */
export const plainCitations = (md: string) => md.replace(/\[([^\]]+)\]\(#(?:(?:doc=[\w-]+&)?page|note-line)=\d+\)/g, "($1)");

const quoteBlock = (m: Message, docName: DocName | undefined, pages: PageNames) => {
  if (!m.quote) return "";
  const from = m.quote.doc && docName?.(m.quote.doc);
  return `> **${from ? `${from}, ` : ""}p. ${pages.label(m.quote)}:** ${m.quote.text.replace(/\s+/g, " ")}\n\n`;
};

/** Page numbers as printed: in an answer's links, and of a quote's page. */
export type PageNames = { text: (md: string) => string; label: (q: Quote) => string };
const PDF_PAGES: PageNames = { text: (md) => md, label: (q) => String(q.page) };

function who(m: Message, providers: ProviderInfo[]) {
  const p = providers.find((x) => x.id === (m.provider ?? "agy"))?.label ?? m.provider ?? "Assistant";
  const details = [m.modelLabel ?? m.model, m.effort && `effort ${m.effort}`].filter(Boolean).join(", ");
  return details ? `${p} (${details})` : p;
}

/** The question an answer belongs to (the user message right before it). */
export function questionOf(messages: Message[], answer: Message): Message | undefined {
  const i = messages.findIndex((m) => m.id === answer.id);
  if (i <= 0) return undefined;
  return messages.slice(0, i).reverse().find((m) => m.role === "user");
}

const header = (chat: Chat, kind: string) =>
  `# ${chat.name}${chat.kind === "folder" ? " (folder)" : ""} — ${kind}\n\n_Exported from ydust on ${new Date().toLocaleString()}_\n\n`;

export function chatMarkdown(chat: Chat, providers: ProviderInfo[], docName?: DocName, pages = PDF_PAGES) {
  let out = header(chat, "Chat");
  for (const m of chat.messages) {
    if (m.role === "user") {
      if (m.secondOpinionOf) {
        out += `---\n\n_Second opinion:_\n\n`;
        continue;
      }
      const heading = m.noteRef
        ? `${m.mode === "challenge-note" ? "Challenge on" : m.mode === "fix-note" ? "Fixes for" : "Review of"} ${m.noteRef.name}`
        : m.mode === "check"
          ? "My explanation"
          : "Question";
      out += `---\n\n### ${heading}\n\n${quoteBlock(m, docName, pages)}${m.noteRef ? (m.noteRef.instructions ?? "") : m.content}\n\n`;
      if (m.images?.length) out += `_(${m.images.length} picture${m.images.length > 1 ? "s" : ""} attached)_\n\n`;
    } else if (!m.error && m.content.trim()) {
      out += `**${who(m, providers)}:**\n\n${plainCitations(pages.text(m.content))}\n\n`;
      if (m.webQueries?.length) out += `_Web searches: ${m.webQueries.map((q) => `“${q}”`).join(", ")}_\n\n`;
      if (m.note) out += `> 📝 **My note:** ${m.note.replace(/\n/g, "\n> ")}\n\n`;
    }
  }
  return out;
}

export function notesMarkdown(chat: Chat, providers: ProviderInfo[], docName?: DocName, pages = PDF_PAGES) {
  let out = header(chat, "Notes");
  const pinned = chat.messages.filter((m) => m.role === "assistant" && m.pinned);
  for (const a of pinned) {
    const q = questionOf(chat.messages, a);
    const title = q?.quote ? `p. ${pages.label(q.quote)} — ` : "";
    out += `## ${title}${(q?.content ?? "Answer").split("\n")[0].slice(0, 100)}\n\n`;
    if (q) out += quoteBlock(q, docName, pages);
    if (a.note) out += `**My note:** ${a.note}\n\n`;
    out += `${plainCitations(pages.text(a.content))}\n\n_— ${who(a, providers)}_\n\n`;
  }
  if (!pinned.length) out += "_No pinned answers yet._\n";
  return out;
}

/** All note files of a document and its folder, as one Markdown file. */
export function noteFilesMarkdown(groups: { owner: NoteOwner; notes: Note[] }[], relabel: (md: string, owner: NoteOwner) => string = (md) => md) {
  let out = `# Notes\n\n_Exported from ydust on ${new Date().toLocaleString()}_\n\n`;
  for (const { owner, notes } of groups) {
    if (!notes.length) continue;
    for (const n of notes) {
      out += `---\n\n_${owner.kind === "folder" ? `Folder “${owner.name}”` : owner.name} · ${n.name}_\n\n${plainCitations(relabel(n.content, owner)).trim()}\n\n`;
    }
  }
  return out;
}

const COLOR_NAME: Record<Highlight["color"], string> = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", orange: "Orange" };

/** A document's highlights as Markdown, by page. */
export function highlightsMarkdown(docName: string, list: Highlight[], labels?: PageLabels) {
  let out = `# ${docName} — Highlights\n\n_Exported from ydust on ${new Date().toLocaleString()}_\n`;
  let page = 0;
  for (const h of [...list].sort((a, b) => a.page - b.page)) {
    if (h.page !== page) {
      page = h.page;
      out += `\n## Page ${pageLabel(labels, page)}\n\n`;
    }
    out += `- **${COLOR_NAME[h.color]}:** ${h.text}\n`;
    if (h.comment) out += `  _${h.comment.replace(/\s+/g, " ")}_\n`;
  }
  if (!list.length) out += "\n_No highlights._\n";
  return out;
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = (s: string) => s.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "ydust";
