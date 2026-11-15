import { describe, expect, it } from "vitest";
import type { NoteOwner } from "../src/lib/api.ts";
import { appendBlock, blockInsertion, citationsFor, pageLink, quoteForNote } from "../src/lib/notes.ts";

const docNote: NoteOwner = { kind: "doc", id: "doc-1", name: "Script", alias: "d1" };
const folderNote: NoteOwner = { kind: "folder", id: "folder-1", name: "Maths" };
const script = { id: "doc-1", alias: "d1", name: "Script" };
const slides = { id: "doc-2", alias: "d2", name: "Slides [v2]" };

const apply = (doc: string, pos: number, block: string) => {
  const r = blockInsertion(doc, pos, block);
  return { text: doc.slice(0, r.at) + r.text + doc.slice(r.at), cursor: r.cursor };
};

describe("blockInsertion", () => {
  it("makes the block its own paragraph in an empty note", () => {
    expect(apply("", 0, "> quote")).toEqual({ text: "> quote\n", cursor: 7 });
  });

  it("goes after the line the cursor is in, with blank lines around", () => {
    const doc = "# Title\nsome text\nmore";
    const { text } = apply(doc, doc.indexOf("text"), "> q");
    expect(text).toBe("# Title\nsome text\n\n> q\n\nmore");
  });

  it("goes at the cursor on an empty line, without doubling blank lines", () => {
    const doc = "a\n\n\n\nb";
    const { text, cursor } = apply(doc, 3, "> q");
    expect(text).toBe("a\n\n> q\n\nb");
    expect(text.slice(cursor - 3, cursor)).toBe("> q");
  });

  it("trims the block", () => {
    expect(apply("x", 1, "\n\n> q\n\n").text).toBe("x\n\n> q\n");
  });
});

describe("appendBlock", () => {
  it("adds at the end with one blank line between", () => {
    expect(appendBlock("# Notes\n", "### Q\n\nA")).toBe("# Notes\n\n### Q\n\nA\n");
    expect(appendBlock("# Notes", "B")).toBe("# Notes\n\nB\n");
    expect(appendBlock("", "B")).toBe("B\n");
  });
});

describe("page links in notes", () => {
  it("are bare in the document's own notes", () => {
    expect(pageLink(docNote, 12, script)).toBe("[p. 12](#page=12)");
  });

  it("name the document in a folder's notes, or another document's", () => {
    expect(pageLink(folderNote, 12, script)).toBe("[Script, p. 12](#doc=d1&page=12)");
    expect(pageLink(docNote, 3, slides)).toBe("[Slides v2, p. 3](#doc=d2&page=3)");
  });

  it("quote a passage on one line", () => {
    expect(quoteForNote("Every bounded\nsequence  has", "[p. 2](#page=2)")).toBe("> Every bounded sequence has ([p. 2](#page=2))");
  });
});

describe("citationsFor", () => {
  const answer = "See [p. 3](#page=3) and [Slides, p. 4](#doc=d2&page=4).";

  it("keeps an answer's links in its own document's note", () => {
    expect(citationsFor(answer, { kind: "doc", id: "doc-1", alias: "d1" }, docNote)).toBe(answer);
  });

  it("names the document in bare links when the answer goes into the folder's note", () => {
    expect(citationsFor(answer, { kind: "doc", id: "doc-1", alias: "d1" }, folderNote)).toBe(
      "See [p. 3](#doc=d1&page=3) and [Slides, p. 4](#doc=d2&page=4).",
    );
  });

  it("leaves folder answers alone (they already name documents)", () => {
    expect(citationsFor(answer, { kind: "folder", id: "folder-1" }, docNote)).toBe(answer);
  });
});
