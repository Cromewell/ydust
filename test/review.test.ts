import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunOptions } from "../server/providers/types.ts";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-review-"));
process.env.YDUST_LIBRARY = lib;
const { app, runtime } = await import("../server/app.ts");
runtime.apiBase = "http://127.0.0.1:9"; // turns that may write get write_note (the stand-in CLI never calls it)
const store = await import("../server/store.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { MAX_NOTE_IN_PROMPT, buildPrompt, numberedNote } = await import("../server/prompt.ts");

afterAll(() => rm(lib, { recursive: true, force: true }));

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

// A stand-in CLI that only records what it was asked.
const prompts: string[] = [];
let lastTools: readonly string[] = [];
for (const id of ["claude", "agy"] as const) {
  PROVIDERS[id] = {
    ...PROVIDERS[id],
    available: async () => true,
    describeModel: async (m) => m,
    defaultEffort: async () => null,
    defaultModel: async () => null,
    async run(opts: RunOptions) {
      prompts.push(opts.prompt);
      lastTools = opts.mcpTools ?? [];
      return { sessionId: null, response: "1. [L2](#note-line=2) “unique” is right ([p. 3](#page=3)).", status: "SUCCESS", denied: [], error: null };
    },
  };
}

async function ask(url: string, body: Record<string, unknown>) {
  const res = await req("POST", url, { provider: "claude", ...body });
  const text = await res.text();
  return { status: res.status, text, user: JSON.parse(text.match(/event: user\ndata: (.*)/)?.[1] ?? "null") };
}

const NOTE = "# Limits\nA limit is unique.\nEvery bounded sequence converges.\n\nSee [p. 3](#page=3).";

describe("reviewing a note", () => {
  let doc: string;
  beforeAll(async () => {
    doc = (await store.createDoc("Analysis", new TextEncoder().encode("%PDF"))).id;
    await req("PUT", `/api/docs/${doc}/notes/summary.md`, { content: NOTE, baseVersion: null });
  });

  it("puts the note, numbered, into the prompt and stores a short question", async () => {
    const r = await ask(`/api/docs/${doc}/ask`, { question: "", mode: "review-note", note: { name: "summary.md" } });
    expect(r.status).toBe(200);
    expect(r.user).toMatchObject({ content: "Review my note “summary.md”.", mode: "review-note", noteRef: { name: "summary.md" } });
    const p = prompts.at(-1)!;
    expect(p).toContain('<note name="summary.md">\n1| # Limits\n2| A limit is unique.\n3| Every bounded sequence converges.\n4| \n5| See [p. 3](#page=3).\n</note>');
    expect(p).toContain("[L12](#note-line=12)");
    expect(p).toContain("don't call `write_note`");
    // …and it can't: a review turn gets no write_note.
    expect(lastTools).toEqual(["list_notes", "read_note"]);
  });

  it("can review just the selected lines, with extra instructions", async () => {
    const r = await ask(`/api/docs/${doc}/ask`, { question: "Focus on the definitions.", mode: "review-note", note: { name: "summary.md", lines: [2, 99] } });
    expect(r.user.noteRef).toEqual({ name: "summary.md", lines: [2, 5], instructions: "Focus on the definitions." });
    expect(r.user.content).toBe("Review lines 2–5 of my note “summary.md”.\n\nFocus on the definitions.");
    const p = prompts.at(-1)!;
    expect(p).toContain("(lines 2–5, the part I selected)");
    expect(p).not.toContain("1| # Limits");
    expect(p).toContain("2| A limit is unique.");
    expect(p).toContain("My additional instructions: Focus on the definitions.");
  });

  it("challenges without giving answers", async () => {
    const r = await ask(`/api/docs/${doc}/ask`, { mode: "challenge-note", note: { name: "summary.md", lines: [3, 3] } });
    expect(r.user.content).toBe("Challenge me on line 3 of my note “summary.md”.");
    expect(prompts.at(-1)).toContain("Don't give the answers or hints yet");
  });

  it("'Propose fixes' asks for a replace draft, shown as a short question", async () => {
    const r = await ask(`/api/docs/${doc}/ask`, { mode: "fix-note", note: { name: "summary.md" } });
    expect(r.user).toMatchObject({ content: "Propose fixes for my note “summary.md”.", mode: "fix-note", noteRef: { name: "summary.md" } });
    const p = prompts.at(-1)!;
    expect(p).toContain('call `write_note` with mode "replace"');
    expect(p).not.toContain("<note"); // it reads the note itself (replace needs that)
    expect(lastTools).toContain("write_note");
  });

  it("refuses unknown notes and invalid names", async () => {
    expect((await ask(`/api/docs/${doc}/ask`, { mode: "review-note", note: { name: "missing.md" } })).status).toBe(404);
    expect((await ask(`/api/docs/${doc}/ask`, { mode: "review-note", note: { name: "../meta.json" } })).status).toBe(400);
    expect((await ask(`/api/docs/${doc}/ask`, { mode: "review-note" })).status).toBe(400);
    // Ignores invalid line ranges instead of failing.
    const r = await ask(`/api/docs/${doc}/ask`, { mode: "review-note", note: { name: "summary.md", lines: [9, 2] } });
    expect(r.user.noteRef.lines).toBeUndefined();
  });

  it("a second opinion reviews the same note again", async () => {
    const meta = (await store.readChat("doc", doc))!;
    const answer = meta.messages.findLast((m) => m.role === "assistant")!;
    const before = prompts.length;
    const r = await ask(`/api/docs/${doc}/ask`, { question: "Second opinion", secondOpinionOf: answer.id, provider: "agy" });
    expect(r.status).toBe(200);
    expect(r.user.noteRef?.name).toBe("summary.md");
    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).toContain('<note name="summary.md">');
    expect(prompts.at(-1)).toContain("Give me a second opinion");
  });

  it("only reads the chat's own notes (a folder chat, the folder's)", async () => {
    const f = (await store.createFolder("Course")).id;
    await store.setDocFolder(doc, f);
    expect((await ask(`/api/folders/${f}/ask`, { mode: "review-note", note: { name: "summary.md" } })).status).toBe(404);
    await req("PUT", `/api/folders/${f}/notes/course.md`, { content: "# Course", baseVersion: null });
    expect((await ask(`/api/folders/${f}/ask`, { mode: "review-note", note: { name: "course.md" } })).status).toBe(200);
    expect(prompts.at(-1)).toContain("cite the document and page");
  });
});

describe("numberedNote", () => {
  it("pads line numbers to the widest one", () => {
    const content = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
    expect(numberedNote(content, [9, 10]).text).toBe(" 9| l9\n10| l10");
  });

  it("keeps line ranges inside the note", () => {
    expect(numberedNote("a\nb", [0, 9]).text).toBe("1| a\n2| b");
    expect(numberedNote("a\nb", [5, 9]).text).toBe("2| b");
  });

  it("cuts long notes and says where", () => {
    const content = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n");
    const { text, cut } = numberedNote(content);
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_IN_PROMPT);
    expect(cut).toEqual({ from: 1, shown: text.split("\n").length, to: 2000 });
    const p = buildPrompt({ scope: { kind: "doc", doc: { id: "x", alias: "d1", name: "A", pages: 1, hasText: true, textFile: "/t", outlineFile: null }, folder: null }, question: "q", firstTurn: false, mode: "review-note", note: { name: "long.md", content } });
    expect(p).toContain(`the note has 2000 lines. Read the rest with \`read_note\` "long.md"`);
  });
});
