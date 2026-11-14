import type { Chat, Message, ProviderInfo } from "./api";

/** Resolves a document id to its name (quotes in folder chats). */
type DocName = (id: string) => string | undefined;

/** In-app links "[p. 3](#page=3)", "[Script, p. 3](#doc=d2&page=3)" mean nothing outside ydust: keep them as text. */
const plainCitations = (md: string) => md.replace(/\[([^\]]+)\]\(#(?:doc=[\w-]+&)?page=\d+\)/g, "($1)");

const quoteBlock = (m: Message, docName?: DocName) => {
  if (!m.quote) return "";
  const from = m.quote.doc && docName?.(m.quote.doc);
  return `> **${from ? `${from}, ` : ""}p. ${m.quote.page}:** ${m.quote.text.replace(/\s+/g, " ")}\n\n`;
};

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

export function chatMarkdown(chat: Chat, providers: ProviderInfo[], docName?: DocName) {
  let out = header(chat, "Chat");
  for (const m of chat.messages) {
    if (m.role === "user") {
      if (m.secondOpinionOf) {
        out += `---\n\n_Second opinion:_\n\n`;
        continue;
      }
      out += `---\n\n### ${m.mode === "check" ? "My explanation" : "Question"}\n\n${quoteBlock(m, docName)}${m.content}\n\n`;
      if (m.images?.length) out += `_(${m.images.length} picture${m.images.length > 1 ? "s" : ""} attached)_\n\n`;
    } else if (!m.error && m.content.trim()) {
      out += `**${who(m, providers)}:**\n\n${plainCitations(m.content)}\n\n`;
      if (m.note) out += `> 📝 **My note:** ${m.note.replace(/\n/g, "\n> ")}\n\n`;
    }
  }
  return out;
}

export function notesMarkdown(chat: Chat, providers: ProviderInfo[], docName?: DocName) {
  let out = header(chat, "Notes");
  const pinned = chat.messages.filter((m) => m.role === "assistant" && m.pinned);
  for (const a of pinned) {
    const q = questionOf(chat.messages, a);
    const title = q?.quote ? `p. ${q.quote.page} — ` : "";
    out += `## ${title}${(q?.content ?? "Answer").split("\n")[0].slice(0, 100)}\n\n`;
    if (q) out += quoteBlock(q, docName);
    if (a.note) out += `**My note:** ${a.note}\n\n`;
    out += `${plainCitations(a.content)}\n\n_— ${who(a, providers)}_\n\n`;
  }
  if (!pinned.length) out += "_No pinned answers yet._\n";
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
