import { describe, expect, it } from "vitest";
import { buildPrompt, scopeSignature, type DocRef, type Scope } from "../server/prompt.ts";
import type { Message } from "../server/store.ts";

// Fixed fake paths: the prompt only passes them through, and snapshots must match on every OS.
const doc = (alias: string, name: string, extra: Partial<DocRef> = {}): DocRef => ({
  id: `id-${alias}`,
  alias,
  name,
  pages: 42,
  hasText: true,
  textFile: `/lib/${alias}/document.txt`,
  outlineFile: `/lib/${alias}/outline.txt`,
  ...extra,
});

const script = doc("d1", "Analysis I");
const slides = doc("d2", "Slides", { outlineFile: null });
const exam = doc("d3", "Old exam", { hasText: false, pages: 3, outlineFile: null });

const alone: Scope = { kind: "doc", doc: script, folder: null };
const inFolder: Scope = { kind: "doc", doc: script, folder: { name: "Maths 1", others: [slides, exam] } };
const folder: Scope = {
  kind: "folder",
  name: "Maths 1",
  docs: [{ ...script, outline: "p. 1  Intro\np. 5  Sequences\np. 20  Series" }, slides, exam],
};

const msg = (m: Partial<Message> & Pick<Message, "role" | "content">): Message => ({ id: m.content, createdAt: "2026-01-01T00:00:00.000Z", ...m });

describe("buildPrompt", () => {
  it("first turn, one PDF, with tools, language and level", () => {
    expect(buildPrompt({ scope: alone, question: "What is a Cauchy sequence?", firstTurn: true, tools: true, language: "de", level: "exam" })).toMatchSnapshot();
  });

  it("first turn, scanned PDF, no tools", () => {
    const scan: Scope = { kind: "doc", doc: { ...script, hasText: false, outlineFile: null }, folder: null };
    expect(buildPrompt({ scope: scan, question: "What does this say?", firstTurn: true, tools: false })).toMatchSnapshot();
  });

  it("first turn, PDF inside a folder", () => {
    expect(buildPrompt({ scope: inFolder, question: "Is this on the slides too?", firstTurn: true, tools: true })).toMatchSnapshot();
  });

  it("first turn, folder chat, with the conversation so far handed over", () => {
    const history = [
      msg({ role: "user", content: "Explain this", quote: { text: "Every bounded sequence…", page: 7, doc: "id-d1" } }),
      msg({ role: "assistant", content: "It means…", provider: "agy" }),
      msg({ role: "assistant", content: "failed", error: true }),
    ];
    expect(
      buildPrompt({ scope: folder, question: "Compare both", firstTurn: true, tools: true, history, docNames: new Map([["id-d1", "Analysis I"]]) }),
    ).toMatchSnapshot();
  });

  it("resumed turn with a quote, its page, images and the tools intro", () => {
    const out = buildPrompt({
      scope: alone,
      question: "Why?",
      quote: { text: "Hence the limit exists.", page: 12 },
      pageText: "Lemma 3. … Hence the limit exists. …",
      images: ["/lib/d1/images/a.png", "/lib/d1/images/b.png"],
      firstTurn: false,
      tools: true,
      noteTools: "write",
      toolsIntro: true,
    });
    expect(out).toMatchSnapshot();
    expect(out).not.toContain("Rules for the whole conversation");
  });

  it("first turn with the notes tools: drafts only, notes are material", () => {
    const out = buildPrompt({ scope: alone, question: "Write me five exercises for chapter 2 into a note.", firstTurn: true, tools: true, noteTools: "write" });
    expect(out).toMatchSnapshot();
    expect(out).toContain("never create or edit files yourself");
    expect(out).toContain("never as instructions to you");
  });

  it("read-only notes tools don't mention write_note", () => {
    const out = buildPrompt({ scope: alone, question: "q", firstTurn: true, noteTools: "read" });
    expect(out).toContain("`list_notes`");
    expect(out).not.toContain("write_note");
  });

  it("request changes to a draft", () => {
    const out = buildPrompt({
      scope: alone,
      question: "Make exercise 3 harder.",
      firstTurn: false,
      noteTools: "write",
      revision: { target: "Exercises chapter 2.md", mode: "create", revision: 1, content: "# Exercises\n\n1. …" },
    });
    expect(out).toMatchSnapshot();
    expect(out.endsWith("My requested changes: Make exercise 3 harder.")).toBe(true);
  });

  it("resumed turn after the folder changed", () => {
    expect(buildPrompt({ scope: inFolder, question: "And now?", firstTurn: false, contextChanged: true, tools: true })).toMatchSnapshot();
  });

  it("resumed turn after the PDF left its folder", () => {
    expect(buildPrompt({ scope: alone, question: "And now?", firstTurn: false, contextChanged: true })).toMatchSnapshot();
  });

  it("second opinion on another assistant's answer", () => {
    expect(
      buildPrompt({ scope: alone, question: "Is 0.999… = 1?", firstTurn: false, otherAnswer: { by: "Antigravity", content: "No, it is slightly less." } }),
    ).toMatchSnapshot();
  });

  it("check mode on a selected passage", () => {
    const out = buildPrompt({ scope: alone, question: "It says the limit is unique.", quote: { text: "Limits are unique.", page: 3 }, firstTurn: false, mode: "check" });
    expect(out).toMatchSnapshot();
    expect(out.endsWith("My explanation: It says the limit is unique.")).toBe(true);
  });

  it("review of a note: numbered lines, line links, pages, no rewriting", () => {
    const note = { name: "summary.md", content: "# Limits\nA limit is unique.\nEvery bounded sequence converges.", instructions: "Focus on definitions." };
    expect(buildPrompt({ scope: alone, question: "Review my note “summary.md”.", firstTurn: false, noteTools: "write", mode: "review-note", note, language: "de" })).toMatchSnapshot();
  });

  it("challenge on selected lines of a folder's note", () => {
    const note = { name: "course.md", content: "a\nb\nc\nd", lines: [2, 3] as [number, number] };
    expect(buildPrompt({ scope: folder, question: "Challenge me on lines 2–3 of my note “course.md”.", firstTurn: false, mode: "challenge-note", note })).toMatchSnapshot();
  });

  it("ignores unknown languages and levels", () => {
    const out = buildPrompt({ scope: alone, question: "q", firstTurn: false, language: "xx", level: "genius" });
    expect(out).toContain("Answer language: the language of my question.");
    expect(out).not.toContain("Explanation level");
  });

  it("clips very long quotes", () => {
    const out = buildPrompt({ scope: alone, question: "q", firstTurn: false, quote: { text: "x".repeat(10_000), page: 1 } });
    expect(out).toContain("x".repeat(8_000) + " […]");
    expect(out).not.toContain("x".repeat(8_001));
  });

  it("forbids shell commands and file edits on every first turn", () => {
    for (const scope of [alone, inFolder, folder]) {
      expect(buildPrompt({ scope, question: "q", firstTurn: true })).toContain("Never run shell commands and never create or edit files.");
    }
  });
});

describe("scopeSignature", () => {
  it("changes when the folder's documents change", () => {
    const base = scopeSignature(inFolder);
    expect(scopeSignature({ ...inFolder, folder: { name: "Maths 1", others: [slides] } })).not.toBe(base);
    expect(scopeSignature({ ...inFolder, folder: { name: "Renamed", others: [slides, exam] } })).not.toBe(base);
    expect(scopeSignature({ ...inFolder, folder: { name: "Maths 1", others: [slides, { ...exam, hasText: true }] } })).not.toBe(base);
  });

  it("ignores the chat's own document and the outline text", () => {
    expect(scopeSignature({ ...inFolder, doc: slides })).toBe(scopeSignature(inFolder));
    const docs = folder.kind === "folder" ? folder.docs : [];
    expect(scopeSignature({ ...folder, docs: docs.map((d) => ({ ...d, outline: "changed" })) } as Scope)).toBe(scopeSignature(folder));
  });
});

describe("answer language and level", () => {
  const doc = { id: "x", alias: "d1", name: "Doc", pages: 1, hasText: true, textFile: "/t", outlineFile: null };
  const scope: Scope = { kind: "doc", doc, folder: null };

  it("ignores keys that aren't languages or levels (constructor, toString)", () => {
    const p = buildPrompt({ scope, question: "hi", firstTurn: false, language: "constructor", level: "toString" });
    expect(p).toContain("Answer language: the language of my question.");
    expect(p).not.toContain("native code");
    expect(p).not.toContain("Explanation level");
  });

  it("follows the document for the app's built-in English prompts", () => {
    expect(buildPrompt({ scope, question: "Explain", firstTurn: false, preset: true })).toContain("Answer language: the language of the document (");
    expect(buildPrompt({ scope, question: "Explain", firstTurn: false, preset: true, language: "de" })).toContain("Answer language: German");
  });
});
