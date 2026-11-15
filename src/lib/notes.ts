import { api, NoteConflict, type NoteOwner } from "./api";

/** The note open in the editor, so text can go straight to its cursor (and its autosave). */
export type OpenEditor = { owner: NoteOwner; name: string; insert: (block: string) => void };
let openEditor: OpenEditor | null = null;
export const noteEditor = {
  get: () => openEditor,
  set: (e: OpenEditor) => void (openEditor = e),
  clear: (e: OpenEditor) => void (openEditor === e && (openEditor = null)),
};

export const sameOwner = (a: NoteOwner, b: NoteOwner) => a.kind === b.kind && a.id === b.id;

/**
 * Where to put `block` so it stands as its own paragraph: at `pos`, or at the end of that
 * line if it has text. Returns the text to insert there and where the cursor goes after it.
 */
export function blockInsertion(doc: string, pos: number, block: string) {
  let at = pos;
  const lineEnd = doc.indexOf("\n", pos);
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  if (doc.slice(lineStart, lineEnd === -1 ? doc.length : lineEnd).trim()) at = lineEnd === -1 ? doc.length : lineEnd;
  const before = doc.slice(0, at);
  const after = doc.slice(at);
  const prefix = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after === "" ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const text = prefix + block.trim() + suffix;
  return { at, text, cursor: at + prefix.length + block.trim().length };
}

/** A note's content with `block` added at the end. */
export function appendBlock(doc: string, block: string) {
  const { at, text } = blockInsertion(doc, doc.length, block);
  return doc.slice(0, at) + text;
}

/** A page link that works in that owner's notes: bare in the document's own notes, with its id anywhere else. */
export function pageLink(owner: NoteOwner, page: number, doc: { id: string; alias?: string; name: string }) {
  if ((owner.kind === "doc" && owner.id === doc.id) || !doc.alias) return `[p. ${page}](#page=${page})`;
  return `[${doc.name.replace(/[[\]]/g, "")}, p. ${page}](#doc=${doc.alias}&page=${page})`;
}

/** A selected passage as a Markdown quote, with its page link. */
export function quoteForNote(text: string, link: string) {
  return `> ${text.replace(/\s+/g, " ").trim()} (${link})`;
}

/**
 * An answer from a document's chat cites "[p. 3](#page=3)", meaning that document. In any
 * other note (e.g. the folder's) that would be ambiguous: name the document in each link.
 */
export function citationsFor(md: string, from: { kind: "doc" | "folder"; id: string; alias?: string }, to: NoteOwner) {
  if (from.kind !== "doc" || !from.alias || (to.kind === "doc" && to.id === from.id)) return md;
  return md.replace(/\]\(#page=(\d+)\)/g, `](#doc=${from.alias}&page=$1)`);
}

/**
 * Add a block to a note: into the open editor if it is that note (it saves it itself),
 * otherwise straight to the file, retrying once if it changed in between.
 */
export async function insertIntoNote(owner: NoteOwner, name: string, block: string, opts: { create?: boolean } = {}) {
  const open = noteEditor.get();
  if (open && sameOwner(open.owner, owner) && open.name === name) {
    open.insert(block);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    const note = opts.create ? null : await api.getNote(owner, name);
    try {
      await api.saveNote(owner, name, appendBlock(note?.content ?? "", block), note?.version ?? null);
      return;
    } catch (err) {
      if (!(err instanceof NoteConflict) || attempt >= 1) throw err;
      opts = { create: false }; // it exists now: append to it
    }
  }
}
