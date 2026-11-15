import { api, NoteConflict, type NoteOwner } from "./api";
import { appendBlock } from "./noteText";

export { appendBlock, blockInsertion } from "./noteText";

/** The note open in the editor, so text can go straight to its cursor (and its autosave). */
export type OpenEditor = { owner: NoteOwner; name: string; insert: (block: string) => void };
let openEditor: OpenEditor | null = null;
export const noteEditor = {
  get: () => openEditor,
  set: (e: OpenEditor) => void (openEditor = e),
  clear: (e: OpenEditor) => void (openEditor === e && (openEditor = null)),
};

export const sameOwner = (a: NoteOwner, b: NoteOwner) => a.kind === b.kind && a.id === b.id;

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
