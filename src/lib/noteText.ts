/** Plain text helpers for notes, shared by the browser and the server. */

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
