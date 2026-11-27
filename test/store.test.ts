import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// store.ts reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-store-"));
process.env.YDUST_LIBRARY = lib;
const store = await import("../server/store.ts");

afterAll(() => rm(lib, { recursive: true, force: true }));

const pdf = new TextEncoder().encode("%PDF-1.7\n");
const readJsonFile = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("ids and paths", () => {
  it("uses the library from YDUST_LIBRARY", () => {
    expect(store.LIBRARY_DIR).toBe(path.resolve(lib));
  });

  it("accepts only UUID-shaped ids", () => {
    expect(store.isValidId(randomUUID())).toBe(true);
    for (const bad of ["", "abc", "../../etc/passwd", `${randomUUID()}/..`, randomUUID().toUpperCase(), `${randomUUID()}x`]) {
      expect(store.isValidId(bad), bad).toBe(false);
    }
  });

  it("refuses to build paths from invalid ids", () => {
    expect(() => store.docDir("..")).toThrow("invalid document id");
    expect(() => store.folderDir("../x")).toThrow("invalid folder id");
    expect(() => store.pdfPath("a/../../b")).toThrow();
    const id = randomUUID();
    expect(store.docDir(id)).toBe(path.join(lib, id));
    expect(store.folderDir(id)).toBe(path.join(lib, "folders", id));
    expect(store.chatDir("folder", id)).toBe(store.folderDir(id));
  });

  it("accepts only generated image ids", () => {
    const id = `${randomUUID()}.png`;
    expect(store.isValidImageId(id)).toBe(true);
    for (const bad of ["x.png", `${randomUUID()}.svg`, `../${randomUUID()}.png`, `${randomUUID()}.png/..`]) {
      expect(store.isValidImageId(bad), bad).toBe(false);
    }
    expect(() => store.imagePath(lib, "../secret.png")).toThrow("invalid image id");
  });
});

describe("documents", () => {
  it("creates a document with the next alias and a meta file", async () => {
    const a = await store.createDoc("First", pdf);
    const b = await store.createDoc("Second", pdf);
    expect(Number(b.alias!.slice(1))).toBe(Number(a.alias!.slice(1)) + 1);
    expect(await readFile(store.pdfPath(a.id), "utf8")).toBe("%PDF-1.7\n");
    expect((await store.readMeta(a.id))!.name).toBe("First");
    expect(await store.readMeta(randomUUID())).toBeNull();
  });

  it("writes meta atomically, leaving no temporary files", async () => {
    const d = await store.createDoc("Atomic", pdf);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.updateMeta(d.id, (m) => void (m.lastPage = i + 1))));
    const files = await readdir(store.docDir(d.id));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await readJsonFile(path.join(store.docDir(d.id), "meta.json"))).toMatchObject({ id: d.id });
  });

  it("serializes read-modify-write, so no concurrent update is lost", async () => {
    const d = await store.createDoc("Busy", pdf);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.updateChat("doc", d.id, (m) => void m.messages.push(store.newMessage({ role: "user", content: `q${i}` }))),
      ),
    );
    const chat = (await store.readChat("doc", d.id))!;
    expect(chat.messages.map((m) => m.content).sort()).toEqual(Array.from({ length: 25 }, (_, i) => `q${i}`).sort());
  });

  it("migrates the pre-multi-provider conversationId on read", async () => {
    const d = await store.createDoc("Legacy", pdf);
    const file = path.join(store.docDir(d.id), "meta.json");
    const raw = await readJsonFile(file);
    raw.conversationId = "conv-1";
    await writeFile(file, JSON.stringify(raw));
    expect((await store.readChat("doc", d.id))!.conversations).toEqual({ agy: "conv-1" });
    expect(await store.readMeta(d.id)).not.toHaveProperty("conversationId");
  });

  it("keeps the chat in chat.json, so metadata writes don't rewrite it", async () => {
    const d = await store.createDoc("Split", pdf);
    await store.updateChat("doc", d.id, (m) => void m.messages.push(store.newMessage({ role: "user", content: "hi" })));
    await store.updateMeta(d.id, (m) => void (m.lastPage = 3));
    const meta = await readJsonFile(path.join(store.docDir(d.id), "meta.json"));
    expect(meta).toMatchObject({ lastPage: 3, messageCount: 1 });
    expect(meta).not.toHaveProperty("messages");
    expect((await readJsonFile(path.join(store.docDir(d.id), "chat.json"))).messages).toHaveLength(1);
  });

  it("moves the chat of an old meta.json / folder.json into chat.json", async () => {
    const d = await store.createDoc("Old", pdf);
    const file = path.join(store.docDir(d.id), "meta.json");
    const raw = await readJsonFile(file);
    delete raw.messageCount;
    Object.assign(raw, { messages: [store.newMessage({ role: "user", content: "old" })], conversations: { claude: "s1" }, sessionTags: { claude: "" } });
    await writeFile(file, JSON.stringify(raw));
    const f = await store.createFolder("OldFolder");
    const ffile = path.join(store.folderDir(f.id), "folder.json");
    await writeFile(ffile, JSON.stringify({ ...(await readJsonFile(ffile)), messages: [store.newMessage({ role: "user", content: "f" })], conversations: {} }));

    expect((await store.readMeta(d.id))!.messageCount).toBe(1); // counted before the migration, too
    expect((await store.readChat("doc", d.id))!.messages.map((m) => m.content)).toEqual(["old"]);
    await store.migrateChats();
    expect(await readJsonFile(file)).not.toHaveProperty("messages");
    expect(await readJsonFile(ffile)).not.toHaveProperty("messages");
    expect(await store.readChat("doc", d.id)).toMatchObject({ conversations: { claude: "s1" }, sessionTags: { claude: "" } });
    expect((await store.readChat("folder", f.id))!.messages.map((m) => m.content)).toEqual(["f"]);
    expect((await store.listFolders()).find((x) => x.id === f.id)!.messageCount).toBe(1);
  });

  it("summarize drops chat internals and counts messages", async () => {
    const id = (await store.createDoc("Sum", pdf)).id;
    await store.updateChat("doc", id, (m) => {
      m.messages.push(store.newMessage({ role: "user", content: "hi" }));
      m.conversations = { claude: "s" };
      m.sessionTags = { claude: "" };
    });
    const d = (await store.readMeta(id))!;
    const s = store.summarize(d, null);
    expect(s).toMatchObject({ id: d.id, name: "Sum", messageCount: 1, folderId: null });
    for (const k of ["messages", "conversations", "sessionTags", "contextSigs", "toolsVersion", "conversationId"]) expect(s).not.toHaveProperty(k);
  });

  it("deleteDoc removes the folder and the folder membership", async () => {
    const d = await store.createDoc("Gone", pdf);
    const f = await store.createFolder("Holder");
    await store.setDocFolder(d.id, f.id);
    await store.deleteDoc(d.id);
    expect(await stat(store.docDir(d.id)).catch(() => null)).toBeNull();
    expect((await store.readFolder(f.id))!.docIds).not.toContain(d.id);
  });
});

describe("aliases", () => {
  it("ensureAliases gives old documents aliases, oldest first, never reusing one", async () => {
    const before = await store.listDocs();
    const highest = Math.max(...before.map((d) => Number(d.alias!.slice(1))));
    const legacy = [];
    for (const [name, createdAt] of [
      ["Newer", "2020-02-01T00:00:00.000Z"],
      ["Older", "2020-01-01T00:00:00.000Z"],
    ]) {
      const d = await store.createDoc(name, pdf);
      const file = path.join(store.docDir(d.id), "meta.json");
      const raw = await readJsonFile(file);
      delete raw.alias;
      raw.createdAt = createdAt;
      await writeFile(file, JSON.stringify(raw));
      legacy.push(d.id);
    }
    await store.ensureAliases();
    const [newer, older] = await Promise.all(legacy.map((id) => store.readMeta(id)));
    const n = (m: typeof newer) => Number(m!.alias!.slice(1));
    expect(n(older)).toBeGreaterThan(highest);
    expect(n(newer)).toBe(n(older) + 1);
    const all = (await store.listDocs()).map((d) => d.alias);
    expect(new Set(all).size).toBe(all.length);
  });

  it("ensureAliases raises a stale counter above every alias in use", async () => {
    await writeFile(path.join(lib, "state.json"), JSON.stringify({ nextAlias: 1 }));
    await store.ensureAliases();
    const highest = Math.max(...(await store.listDocs()).map((d) => Number(d.alias!.slice(1))));
    const fresh = await store.createDoc("Fresh", pdf);
    expect(Number(fresh.alias!.slice(1))).toBe(highest + 1);
  });
});

describe("text and outline", () => {
  it("writes pages with markers and reads them back", async () => {
    const d = await store.createDoc("Text", pdf);
    await store.writeText(d.id, ["  one  ", "two\nlines", ""], "p. 1  Intro");
    expect(await readFile(store.textPath(d.id), "utf8")).toBe("=== Page 1 ===\none\n\n=== Page 2 ===\ntwo\nlines\n\n=== Page 3 ===\n\n");
    expect(await store.readAllPages(d.id)).toEqual(["one", "two\nlines", ""]);
    expect(await store.readPageText(d.id, 2)).toBe("two\nlines");
    expect(await store.readPageText(d.id, 3)).toBe("");
    expect(await store.readPageText(d.id, 4)).toBeNull();
    expect(await store.readOutline(d.id)).toBe("p. 1  Intro\n");
  });

  it("removes the outline when a new extraction has none", async () => {
    const d = await store.createDoc("Outline", pdf);
    await store.writeText(d.id, ["a"], "p. 1  A");
    await store.writeText(d.id, ["a"]);
    expect(await store.readOutline(d.id)).toBeNull();
  });

  it("returns null without extracted text", async () => {
    const d = await store.createDoc("NoText", pdf);
    expect(await store.readAllPages(d.id)).toBeNull();
    expect(await store.readPageText(d.id, 1)).toBeNull();
  });

  it("does not confuse page 1 with page 10", async () => {
    const d = await store.createDoc("Ten", pdf);
    await store.writeText(d.id, Array.from({ length: 11 }, (_, i) => `text ${i + 1}`));
    expect(await store.readPageText(d.id, 1)).toBe("text 1");
    expect(await store.readPageText(d.id, 10)).toBe("text 10");
  });

  it("ignores inline page marker text inside a page", async () => {
    const d = await store.createDoc("InlineMarker", pdf);
    await store.writeText(d.id, ["see === Page 2 === for details", "real page 2"]);
    expect(await store.readPageText(d.id, 1)).toBe("see === Page 2 === for details");
    expect(await store.readPageText(d.id, 2)).toBe("real page 2");
  });
});

describe("folders", () => {
  it("a document is in at most one folder", async () => {
    const d = await store.createDoc("Mover", pdf);
    const [a, b] = await Promise.all([store.createFolder("A"), store.createFolder("B")]);
    await store.setDocFolder(d.id, a.id);
    expect((await store.folderOfDoc(d.id))!.id).toBe(a.id);
    await store.setDocFolder(d.id, b.id);
    expect((await store.readFolder(a.id))!.docIds).not.toContain(d.id);
    expect((await store.readFolder(b.id))!.docIds).toEqual([d.id]);
    await store.setDocFolder(d.id, null);
    expect(await store.folderOfDoc(d.id)).toBeNull();
  });

  it("concurrent moves never leave a document in two folders", async () => {
    const d = await store.createDoc("Racer", pdf);
    const folders = await Promise.all(["X", "Y", "Z"].map((n) => store.createFolder(n)));
    await Promise.all([...folders, ...folders].map((f) => store.setDocFolder(d.id, f.id)));
    const holding = (await Promise.all(folders.map((f) => store.readFolder(f.id)))).filter((f) => f!.docIds.includes(d.id));
    expect(holding).toHaveLength(1);
    expect(holding[0]!.docIds.filter((x) => x === d.id)).toHaveLength(1);
  });

  it("keeps the order documents were added in", async () => {
    const f = await store.createFolder("Ordered");
    const docs = [];
    for (const n of ["1", "2", "3"]) {
      const d = await store.createDoc(n, pdf);
      await store.setDocFolder(d.id, f.id);
      docs.push(d.id);
    }
    await store.setDocFolder(docs[0], f.id); // adding again doesn't duplicate or reorder
    expect((await store.readFolder(f.id))!.docIds).toEqual(docs);
  });

  it("deleting a folder keeps its documents", async () => {
    const d = await store.createDoc("Kept", pdf);
    const f = await store.createFolder("Temp");
    await store.setDocFolder(d.id, f.id);
    await store.deleteFolder(f.id);
    expect(await store.readFolder(f.id)).toBeNull();
    expect(await store.readMeta(d.id)).not.toBeNull();
    expect(await store.folderOfDoc(d.id)).toBeNull();
  });

  it("lists folders by name, case-insensitively, and fills defaults on read", async () => {
    const id = randomUUID();
    await mkdir(store.folderDir(id), { recursive: true });
    await writeFile(path.join(store.folderDir(id), "folder.json"), JSON.stringify({ id, name: "Äpfel", createdAt: "", updatedAt: "" }));
    expect(await store.readFolder(id)).toMatchObject({ docIds: [] });
    expect(await store.readChat("folder", id)).toMatchObject({ messages: [], conversations: {} });
    const names = (await store.listFolders()).map((x) => x.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    // "Äpfel" sorts like "apfel": after "A", before "B".
    expect(names.indexOf("A")).toBeLessThan(names.indexOf("Äpfel"));
    expect(names.indexOf("Äpfel")).toBeLessThan(names.indexOf("B"));
  });

  it("updateChat works the same for folder chats", async () => {
    const f = await store.createFolder("Chat");
    await store.updateChat("folder", f.id, (m) => void m.messages.push(store.newMessage({ role: "user", content: "hello" })));
    expect((await store.readChat("folder", f.id))!.messages.map((m) => m.content)).toEqual(["hello"]);
    await expect(store.updateChat("folder", randomUUID(), () => {})).rejects.toThrow("folder not found");
    await expect(store.updateChat("doc", randomUUID(), () => {})).rejects.toThrow("document not found");
  });
});

describe("images", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");

  it("detects the type from the bytes, not the name", () => {
    expect(store.sniffImage(png)).toBe("png");
    expect(store.sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(store.sniffImage(new TextEncoder().encode("GIF89a"))).toBe("gif");
    expect(store.sniffImage(webp)).toBe("webp");
    expect(store.sniffImage(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("saves under a generated id and clears them all", async () => {
    const d = await store.createDoc("Pics", pdf);
    const dir = store.chatDir("doc", d.id);
    const img = (await store.saveImage(dir, png))!;
    expect(store.isValidImageId(img)).toBe(true);
    expect(img.endsWith(".png")).toBe(true);
    expect(await store.saveImage(dir, new TextEncoder().encode("not an image"))).toBeNull();
    expect(await stat(store.imagePath(dir, img))).toBeTruthy();
    await store.clearImages(dir);
    expect(await stat(store.imagesDir(dir)).catch(() => null)).toBeNull();
  });
});
