import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidNoteName, noteNameProblem, toNoteName } from "../src/lib/noteNames.ts";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-notes-"));
process.env.YDUST_LIBRARY = lib;
const { app } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { MAX_NOTES, notesDir, versionOf } = await import("../server/notes.ts");

afterAll(() => rm(lib, { recursive: true, force: true }));

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

describe("note names", () => {
  it("accepts plain names in any script", () => {
    for (const ok of ["summary.md", "Kapitel 3 – Grenzwerte.md".replace("–", "-"), "Übung_1.md", "a.b.md", "конспект.md", "要約.md", "x".repeat(77) + ".md"]) {
      expect(noteNameProblem(ok), ok).toBeNull();
    }
  });

  it("rejects paths, hidden files, odd endings and reserved Windows names", () => {
    for (const bad of [
      "",
      "summary",
      "summary.txt",
      "summary.MD",
      "../x.md",
      "a/b.md",
      "a\\b.md",
      ".md",
      ".hidden.md",
      " lead.md",
      "trail .md",
      "dot..md",
      "con.md",
      "CON.md",
      "nul.notes.md",
      "COM1.md",
      "lpt9.md",
      "x".repeat(78) + ".md",
      "a:b.md",
      "a*b.md",
      "tab\t.md",
      "é.md", // not NFC
      42,
    ]) {
      expect(isValidNoteName(bad), String(bad)).toBe(false);
    }
  });

  it("turns typed titles into valid names", () => {
    expect(toNoteName("Chapter 3: Limits")).toBe("Chapter 3 Limits.md");
    expect(toNoteName("summary.md")).toBe("summary.md");
    expect(toNoteName("  ..dots..  ")).toBe("dots.md");
    expect(toNoteName("con")).toBe("con_.md");
    expect(toNoteName("???")).toBeNull();
    expect(toNoteName("y".repeat(200))!.length).toBeLessThanOrEqual(80);
  });
});

describe("notes routes", () => {
  let doc: string, folder: string;
  beforeAll(async () => {
    doc = (await store.createDoc("Script", new TextEncoder().encode("%PDF-1.7"))).id;
    folder = (await store.createFolder("Course")).id;
  });

  it("lists nothing before the first note", async () => {
    const res = await req("GET", `/api/docs/${doc}/notes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("creates, reads, updates and lists a note as a plain file", async () => {
    const url = `/api/docs/${doc}/notes/${enc("Summary 1.md")}`;
    const created = await req("PUT", url, { content: "# Limits\n\n$\\lim a_n$ [p. 3](#page=3)\n", baseVersion: null });
    expect(created.status).toBe(200);
    const c = await created.json();
    expect(c).toMatchObject({ name: "Summary 1.md", title: "Limits", version: versionOf("# Limits\n\n$\\lim a_n$ [p. 3](#page=3)\n") });
    expect(c).not.toHaveProperty("content");
    expect(await readFile(path.join(store.docDir(doc), "notes", "Summary 1.md"), "utf8")).toContain("$\\lim a_n$");

    const updated = await req("PUT", url, { content: "# Limits\n\nmore", baseVersion: c.version });
    expect(updated.status).toBe(200);
    const u = await updated.json();
    expect(u.version).not.toBe(c.version);

    const read = await (await req("GET", url)).json();
    expect(read).toMatchObject({ name: "Summary 1.md", content: "# Limits\n\nmore", version: u.version, size: 14 });

    const list = await (await req("GET", `/api/docs/${doc}/notes`)).json();
    expect(list).toEqual([expect.objectContaining({ name: "Summary 1.md", title: "Limits", size: 14 })]);
  });

  it("refuses a save based on an old version, and returns the current content", async () => {
    const url = `/api/docs/${doc}/notes/race.md`;
    const v1 = (await (await req("PUT", url, { content: "one", baseVersion: null })).json()).version;
    // Someone else (another tab or editor) changes the file.
    await writeFile(path.join(notesDir("doc", doc), "race.md"), "changed outside");
    const res = await req("PUT", url, { content: "mine", baseVersion: v1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This note was changed elsewhere meanwhile.",
      current: { content: "changed outside", version: versionOf("changed outside") },
    });
    expect(await readFile(path.join(notesDir("doc", doc), "race.md"), "utf8")).toBe("changed outside");
  });

  it("refuses to create over an existing note, or one that differs only in case", async () => {
    await req("PUT", `/api/docs/${doc}/notes/case.md`, { content: "x", baseVersion: null });
    expect((await req("PUT", `/api/docs/${doc}/notes/case.md`, { content: "y", baseVersion: null })).status).toBe(409);
    const res = await req("PUT", `/api/docs/${doc}/notes/CASE.md`, { content: "y", baseVersion: null });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`"case.md" already exists`);
  });

  it("reports a deleted note as a conflict, not a silent re-create", async () => {
    const url = `/api/docs/${doc}/notes/gone.md`;
    const v = (await (await req("PUT", url, { content: "x", baseVersion: null })).json()).version;
    expect((await req("DELETE", url)).status).toBe(200);
    const res = await req("PUT", url, { content: "y", baseVersion: v });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toBeNull();
    expect((await req("GET", url)).status).toBe(404);
  });

  it("renames, refusing clashes", async () => {
    await req("PUT", `/api/docs/${doc}/notes/old.md`, { content: "keep me", baseVersion: null });
    await req("PUT", `/api/docs/${doc}/notes/other.md`, { content: "o", baseVersion: null });
    expect((await req("PATCH", `/api/docs/${doc}/notes/old.md`, { name: "OTHER.md" })).status).toBe(409);
    expect((await req("PATCH", `/api/docs/${doc}/notes/old.md`, { name: "../escape.md" })).status).toBe(400);
    const res = await req("PATCH", `/api/docs/${doc}/notes/old.md`, { name: "New name.md" });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("New name.md");
    expect((await (await req("GET", `/api/docs/${doc}/notes/${enc("New name.md")}`)).json()).content).toBe("keep me");
    expect((await req("GET", `/api/docs/${doc}/notes/old.md`)).status).toBe(404);
    // Only a change of case: allowed.
    expect((await req("PATCH", `/api/docs/${doc}/notes/${enc("New name.md")}`, { name: "new name.md" })).status).toBe(200);
  });

  it("rejects invalid names, including encoded paths", async () => {
    for (const name of ["..%2F..%2Fstate.json", "%2E%2E%2Fx.md", "notes.txt", ".drafts", "con.md"]) {
      const res = await req("PUT", `/api/docs/${doc}/notes/${name}`, { content: "x", baseVersion: null });
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
    }
    expect(await readdir(lib)).not.toContain("x.md");
  });

  it("validates the body", async () => {
    const url = `/api/docs/${doc}/notes/body.md`;
    expect((await req("PUT", url, { content: 5, baseVersion: null })).status).toBe(400);
    expect((await req("PUT", url, { content: "x", baseVersion: 3 })).status).toBe(400);
  });

  it("limits a note to 1 MB", async () => {
    const url = `/api/docs/${doc}/notes/big.md`;
    expect((await req("PUT", url, { content: "a".repeat(1_000_001), baseVersion: null })).status).toBe(413);
    expect((await req("PUT", url, { content: "ä".repeat(500_001), baseVersion: null })).status).toBe(413); // bytes, not characters
    expect((await req("PUT", url, { content: "a".repeat(1_000_000), baseVersion: null })).status).toBe(200);
  });

  it(`limits a chat to ${MAX_NOTES} notes`, async () => {
    const dir = notesDir("folder", folder);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: MAX_NOTES }, (_, i) => writeFile(path.join(dir, `n${i}.md`), "")));
    const res = await req("PUT", `/api/folders/${folder}/notes/one-more.md`, { content: "x", baseVersion: null });
    expect(res.status).toBe(400);
    expect((await (await req("GET", `/api/folders/${folder}/notes`)).json()).length).toBe(MAX_NOTES);
    // Existing notes can still be saved.
    expect((await req("PUT", `/api/folders/${folder}/notes/n0.md`, { content: "y", baseVersion: versionOf("") })).status).toBe(200);
  });

  it("ignores files that aren't notes and leaves no temporary files", async () => {
    const dir = notesDir("doc", doc);
    await mkdir(path.join(dir, ".drafts"), { recursive: true });
    await writeFile(path.join(dir, "readme.txt"), "x");
    const names = (await (await req("GET", `/api/docs/${doc}/notes`)).json()).map((n: { name: string }) => n.name);
    expect(names).not.toContain("readme.txt");
    expect(names).not.toContain(".drafts");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not follow symbolic links", async () => {
    const outside = path.join(lib, "outside.md");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(notesDir("doc", doc), "link.md"));
    const names = (await (await req("GET", `/api/docs/${doc}/notes`)).json()).map((n: { name: string }) => n.name);
    expect(names).not.toContain("link.md");
    expect((await req("GET", `/api/docs/${doc}/notes/link.md`)).status).toBe(400);
    expect((await req("PUT", `/api/docs/${doc}/notes/link.md`, { content: "pwned", baseVersion: versionOf("secret") })).status).toBe(400);
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it.skipIf(process.platform === "win32")("refuses a notes folder that is a link", async () => {
    const d = (await store.createDoc("Linked", new TextEncoder().encode("%PDF"))).id;
    const elsewhere = path.join(lib, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, notesDir("doc", d));
    expect((await req("PUT", `/api/docs/${d}/notes/a.md`, { content: "x", baseVersion: null })).status).toBe(400);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("works for folder chats, and 404s for unknown chats", async () => {
    const f = (await store.createFolder("Other course")).id;
    expect((await req("PUT", `/api/folders/${f}/notes/course.md`, { content: "# Course", baseVersion: null })).status).toBe(200);
    expect(await readFile(path.join(store.folderDir(f), "notes", "course.md"), "utf8")).toBe("# Course");
    expect((await req("GET", `/api/folders/00000000-0000-4000-8000-000000000000/notes`)).status).toBe(404);
    expect((await req("PUT", `/api/docs/00000000-0000-4000-8000-000000000000/notes/a.md`, { content: "x", baseVersion: null })).status).toBe(404);
    expect(await readdir(lib)).not.toContain("00000000-0000-4000-8000-000000000000");
  });

  it("keeps notes when the chat is reset, and removes them with the document", async () => {
    const d = (await store.createDoc("Reset", new TextEncoder().encode("%PDF"))).id;
    await req("PUT", `/api/docs/${d}/notes/keep.md`, { content: "x", baseVersion: null });
    expect((await req("POST", `/api/docs/${d}/reset`)).status).toBe(200);
    expect((await req("GET", `/api/docs/${d}/notes/keep.md`)).status).toBe(200);
    expect((await req("DELETE", `/api/docs/${d}`)).status).toBe(200);
    // A late autosave must not bring the deleted document's folder back.
    expect((await req("PUT", `/api/docs/${d}/notes/keep.md`, { content: "late", baseVersion: versionOf("x") })).status).toBe(404);
    expect(await readdir(lib)).not.toContain(d);
  });
});
