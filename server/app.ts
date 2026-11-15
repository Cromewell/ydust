import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { PROVIDERS, isProviderId } from "./providers/index.ts";
import { searchServer } from "./mcp/launch.ts";
import { MAX_NOTE_BYTES, NoteError, deleteNote, listNotes, readNote, renameNote, saveNote } from "./notes.ts";
import { buildPrompt, scopeSignature, type DocRef, type Scope } from "./prompt.ts";
import {
  IMAGE_TYPES,
  LIBRARY_DIR,
  chatDir,
  chatExists,
  clearImages,
  createDoc,
  createFolder,
  deleteDoc,
  deleteFolder,
  docDir,
  folderOfDoc,
  imagePath,
  isValidId,
  isValidImageId,
  listDocs,
  listFolders,
  newMessage,
  outlinePath,
  pdfPath,
  readAllPages,
  readChat,
  readFolder,
  readMeta,
  readOutline,
  readPageText,
  saveImage,
  setDocFolder,
  summarize,
  summarizeFolder,
  textPath,
  updateChat,
  updateFolder,
  updateMeta,
  writeText,
  type ChatKind,
  type DocMeta,
  type Message,
  type Quote,
} from "./store.ts";

const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_IMAGES_PER_QUESTION = 10;
const MAX_OUTLINE = 200_000;
/** Bump when ydust's document tools change, so resumed sessions are told about them. */
const TOOLS_VERSION = 1;

/** All API routes. server/index.ts serves it (tests call `app.request` without a port). */
export const app = new Hono();
/** One running turn per chat ("doc:<id>" / "folder:<id>"). `done` settles once the process has exited. */
const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
const chatKey = (kind: ChatKind, id: string) => `${kind}:${id}`;

// Only this app may talk to the API: block DNS rebinding (foreign Host header) and
// cross-site requests from other web pages (foreign Origin), which could otherwise
// upload files or drive the agent through your browser.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
app.use("/api/*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const origin = c.req.header("origin");
  let originOk = true;
  if (origin) {
    try {
      originOk = LOCAL_HOST.test(new URL(origin).host);
    } catch {
      originOk = false;
    }
  }
  if (!LOCAL_HOST.test(host) || !originOk || c.req.header("sec-fetch-site") === "cross-site") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const validateId = async (c: Context, next: Next) => {
  if (!isValidId(c.req.param("id") ?? "")) return c.json({ error: "not found" }, 404);
  await next();
};
for (const base of ["/api/docs", "/api/folders"]) {
  app.use(`${base}/:id`, validateId);
  app.use(`${base}/:id/*`, validateId);
}

app.get("/api/health", (c) => c.json({ ok: true, library: LIBRARY_DIR }));

app.get("/api/providers", async (c) =>
  c.json(
    await Promise.all(
      Object.values(PROVIDERS).map(async (p) => {
        const available = await p.available();
        const base = { id: p.id, label: p.label, available, efforts: p.efforts };
        if (!available) return { ...base, models: [], defaultModel: null, defaultEffort: null };
        const [models, defaultModel, defaultEffort] = await Promise.all([p.models(), p.defaultModel(), p.defaultEffort()]);
        return { ...base, models, defaultModel, defaultEffort };
      }),
    ),
  ),
);

// --- Documents ---

app.get("/api/docs", async (c) => c.json(await listDocs()));

app.post("/api/docs", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "no file uploaded" }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "file is larger than 200 MB" }, 413);
  const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null;
  if (folderId && (!isValidId(folderId) || !(await readFolder(folderId)))) return c.json({ error: "folder not found" }, 404);
  const data = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(data.subarray(0, 1024)).indexOf("%PDF") === -1) {
    return c.json({ error: "that file is not a PDF" }, 415);
  }
  const name = file.name.replace(/\.pdf$/i, "").trim() || "Untitled";
  const meta = await createDoc(name, data);
  if (folderId) await setDocFolder(meta.id, folderId);
  return c.json(summarize(meta, folderId), 201);
});

app.get("/api/docs/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await readMeta(id);
  if (!meta) return c.json({ error: "not found" }, 404);
  return c.json({ ...meta, folderId: (await folderOfDoc(id))?.id ?? null, busy: running.has(chatKey("doc", id)) });
});

app.get("/api/docs/:id/file", async (c) => {
  const file = pdfPath(c.req.param("id"));
  const info = await stat(file).catch(() => null);
  if (!info) return c.json({ error: "not found" }, 404);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { "Content-Type": "application/pdf", "Content-Length": String(info.size) },
  });
});

app.patch("/api/docs/:id", async (c) => {
  const id = c.req.param("id");
  const { name, lastPage, folderId } = await c.req.json<{ name?: string; lastPage?: number; folderId?: string | null }>();
  if (folderId !== undefined) {
    if (folderId !== null && (typeof folderId !== "string" || !isValidId(folderId) || !(await readFolder(folderId)))) {
      return c.json({ error: "folder not found" }, 404);
    }
    if (!(await readMeta(id))) return c.json({ error: "not found" }, 404);
    await setDocFolder(id, folderId);
  }
  const meta = await updateMeta(id, (m) => {
    if (typeof name === "string" && name.trim()) m.name = name.trim().slice(0, 200);
    if (Number.isInteger(lastPage) && lastPage! >= 1) m.lastPage = lastPage!;
  });
  return c.json(summarize(meta, (await folderOfDoc(id))?.id ?? null));
});

app.put("/api/docs/:id/text", async (c) => {
  const id = c.req.param("id");
  const { pages, version, outline } = await c.req.json<{ pages: string[]; version?: number; outline?: string }>();
  if (!Array.isArray(pages) || pages.some((p) => typeof p !== "string")) {
    return c.json({ error: "pages must be an array of strings" }, 400);
  }
  if (!(await readMeta(id))) return c.json({ error: "not found" }, 404);
  await writeText(id, pages, typeof outline === "string" ? outline.slice(0, MAX_OUTLINE) : undefined);
  const chars = pages.reduce((n, p) => n + p.trim().length, 0);
  const meta = await updateMeta(id, (m) => {
    m.pages = pages.length;
    m.hasText = chars >= Math.max(40, pages.length * 15);
    m.textVersion = Number.isInteger(version) ? version : 1;
  });
  return c.json(summarize(meta, (await folderOfDoc(id))?.id ?? null));
});

app.delete("/api/docs/:id", async (c) => {
  const id = c.req.param("id");
  const run = running.get(chatKey("doc", id));
  if (run) {
    run.controller.abort();
    await run.done; // let the stopped turn finish writing before the folder is removed
  }
  await deleteDoc(id);
  return c.json({ ok: true });
});

// Text of every page (for in-document search).
app.get("/api/docs/:id/pages", async (c) => {
  const pages = await readAllPages(c.req.param("id"));
  return pages ? c.json({ pages }) : c.json({ error: "no text for this document" }, 404);
});

// --- Folders ---

app.get("/api/folders", async (c) => c.json(await listFolders()));

app.post("/api/folders", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  const clean = typeof name === "string" ? name.trim().slice(0, 200) : "";
  return c.json(summarizeFolder(await createFolder(clean || "New folder")), 201);
});

app.get("/api/folders/:id", async (c) => {
  const f = await readFolder(c.req.param("id"));
  if (!f) return c.json({ error: "not found" }, 404);
  return c.json({ ...f, busy: running.has(chatKey("folder", f.id)) });
});

app.patch("/api/folders/:id", async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  const f = await updateFolder(c.req.param("id"), (x) => {
    if (typeof name === "string" && name.trim()) x.name = name.trim().slice(0, 200);
  });
  return c.json(summarizeFolder(f));
});

app.delete("/api/folders/:id", async (c) => {
  const id = c.req.param("id");
  const run = running.get(chatKey("folder", id));
  if (run) {
    run.controller.abort();
    await run.done;
  }
  await deleteFolder(id);
  return c.json({ ok: true });
});

// --- What the agent knows about the documents ---

async function docRef(meta: DocMeta, withOutline: boolean): Promise<DocRef> {
  const outline = await readOutline(meta.id);
  return {
    id: meta.id,
    alias: meta.alias ?? meta.id.slice(0, 8),
    name: meta.name,
    pages: meta.pages,
    hasText: meta.hasText,
    textFile: textPath(meta.id),
    outlineFile: outline?.trim() ? outlinePath(meta.id) : null,
    outline: withOutline ? outline : undefined,
  };
}

async function metasOf(ids: string[]) {
  return (await Promise.all(ids.map((d) => readMeta(d)))).filter((m): m is DocMeta => m !== null);
}

/** The scope of a chat, plus the extra folders its agent may read. */
async function loadScope(kind: ChatKind, id: string): Promise<{ scope: Scope; docs: DocRef[]; readDirs: string[] } | null> {
  if (kind === "doc") {
    const meta = await readMeta(id);
    if (!meta) return null;
    const folder = await folderOfDoc(id);
    const others = folder ? await Promise.all((await metasOf(folder.docIds.filter((d) => d !== id))).map((m) => docRef(m, false))) : [];
    const self = await docRef(meta, false);
    return {
      scope: { kind, doc: self, folder: folder ? { name: folder.name, others } : null },
      docs: [self, ...others],
      readDirs: others.map((d) => docDir(d.id)),
    };
  }
  const folder = await readFolder(id);
  if (!folder) return null;
  const docs = await Promise.all((await metasOf(folder.docIds)).map((m) => docRef(m, true)));
  return { scope: { kind, name: folder.name, docs }, docs, readDirs: docs.map((d) => docDir(d.id)) };
}

// --- Chat routes, the same for a document's chat and a folder's chat ---

function chatRoutes(kind: ChatKind, base: string) {
  app.post(`${base}/:id/reset`, async (c) => {
    const id = c.req.param("id");
    const run = running.get(chatKey(kind, id));
    if (run) {
      run.controller.abort();
      await run.done; // let the stopped turn save before we wipe the history
    }
    const chat = await updateChat(kind, id, (m) => {
      m.messages = [];
      m.conversations = {};
      delete m.sessionTags;
      delete m.contextSigs;
      delete m.toolsVersion;
    });
    await clearImages(chatDir(kind, id));
    return c.json(chat);
  });

  app.post(`${base}/:id/stop`, (c) => {
    running.get(chatKey(kind, c.req.param("id")))?.controller.abort();
    return c.json({ ok: true });
  });

  // Pin an answer to the notes, or edit its note.
  app.patch(`${base}/:id/messages/:mid`, async (c) => {
    const { pinned, note } = await c.req.json<{ pinned?: boolean; note?: string }>();
    let found: unknown = null;
    await updateChat(kind, c.req.param("id"), (m) => {
      const msg = m.messages.find((x) => x.id === c.req.param("mid") && x.role === "assistant");
      if (!msg) return;
      if (typeof pinned === "boolean") msg.pinned = pinned || undefined;
      if (typeof note === "string") msg.note = note.slice(0, 20_000) || undefined;
      found = msg;
    });
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  // --- Notes (Markdown files in the chat's notes/ folder) ---

  /** Runs a note operation; refusals become their status code (409 carries the current content). */
  const notes = (fn: (c: Context, id: string) => Promise<Response>) => async (c: Context) => {
    const id = c.req.param("id")!;
    if (!(await chatExists(kind, id))) return c.json({ error: "not found" }, 404);
    try {
      return await fn(c, id);
    } catch (err) {
      if (!(err instanceof NoteError)) throw err;
      return c.json(err.current === undefined ? { error: err.message } : { error: err.message, current: err.current }, err.status);
    }
  };
  // JSON escaping can make the body larger than the note itself; the exact limit is checked on the content.
  const noteBody = bodyLimit({ maxSize: 3 * MAX_NOTE_BYTES, onError: (c) => c.json({ error: "A note can be at most 1 MB." }, 413) });

  app.get(`${base}/:id/notes`, notes(async (c, id) => c.json(await listNotes(kind, id))));
  app.get(`${base}/:id/notes/:name`, notes(async (c, id) => c.json(await readNote(kind, id, c.req.param("name")!))));
  app.put(
    `${base}/:id/notes/:name`,
    noteBody,
    notes(async (c, id) => {
      const { content, baseVersion = null } = await c.req.json<{ content?: unknown; baseVersion?: unknown }>();
      const { content: _, ...saved } = await saveNote(kind, id, c.req.param("name")!, content, baseVersion);
      return c.json(saved);
    }),
  );
  app.patch(`${base}/:id/notes/:name`, notes(async (c, id) => c.json(await renameNote(kind, id, c.req.param("name")!, (await c.req.json<{ name?: unknown }>()).name))));
  app.delete(
    `${base}/:id/notes/:name`,
    notes(async (c, id) => {
      await deleteNote(kind, id, c.req.param("name")!);
      return c.json({ ok: true });
    }),
  );

  app.post(`${base}/:id/images`, async (c) => {
    const id = c.req.param("id");
    if (!(await readChat(kind, id))) return c.json({ error: "not found" }, 404);
    const file = (await c.req.parseBody()).file;
    if (!(file instanceof File)) return c.json({ error: "no image uploaded" }, 400);
    if (file.size > MAX_IMAGE) return c.json({ error: "image is larger than 20 MB" }, 413);
    const img = await saveImage(chatDir(kind, id), new Uint8Array(await file.arrayBuffer()));
    if (!img) return c.json({ error: "only PNG, JPEG, WebP and GIF images are supported" }, 415);
    return c.json({ id: img }, 201);
  });

  app.get(`${base}/:id/images/:img`, async (c) => {
    const img = c.req.param("img");
    if (!isValidImageId(img)) return c.json({ error: "not found" }, 404);
    const file = imagePath(chatDir(kind, c.req.param("id")), img);
    const info = await stat(file).catch(() => null);
    if (!info) return c.json({ error: "not found" }, 404);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        "Content-Type": IMAGE_TYPES[img.split(".").pop()!],
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.post(`${base}/:id/ask`, async (c) => {
    const id = c.req.param("id");
    const key = chatKey(kind, id);
    const dir = chatDir(kind, id);
    const body = await c.req.json<{
      question?: string;
      quote?: Quote;
      model?: string;
      effort?: string;
      images?: string[];
      language?: string;
      provider?: string;
      level?: string;
      mode?: string;
      /** Id of an assistant message: ask the same question again (to another assistant). */
      secondOpinionOf?: string;
    }>();
    const { model, effort, language, level, secondOpinionOf, provider: providerId = "agy" } = body;
    let { question, quote, images } = body;
    let mode = body.mode === "check" ? ("check" as const) : undefined;
    if (!isProviderId(providerId)) return c.json({ error: "unknown assistant" }, 400);
    const provider = PROVIDERS[providerId];
    const previous = running.get(key);
    if (previous) {
      // A just-stopped turn may still be shutting down; give it a moment.
      if (!previous.controller.signal.aborted) {
        return c.json({ error: "The assistant is still answering the previous question." }, 409);
      }
      await Promise.race([previous.done, new Promise((r) => setTimeout(r, 5000))]);
      if (running.has(key)) return c.json({ error: "The previous question is still stopping, try again." }, 409);
    }
    const chat = await readChat(kind, id);
    const loaded = chat && (await loadScope(kind, id));
    if (!chat || !loaded) return c.json({ error: "not found" }, 404);
    const { scope, docs, readDirs } = loaded;

    // Second opinion: repeat the question that led to that answer, and show the answer.
    let otherAnswer: { by: string; content: string } | undefined;
    const shownAlready = new Set<string>(); // not repeated in the handed-over history
    if (typeof secondOpinionOf === "string") {
      const i = chat.messages.findIndex((m) => m.id === secondOpinionOf && m.role === "assistant");
      const asked = i > 0 ? chat.messages.slice(0, i).reverse().find((m) => m.role === "user") : undefined;
      if (!asked) return c.json({ error: "answer not found" }, 404);
      question = asked.content;
      quote = asked.quote;
      images = asked.images;
      mode = asked.mode;
      const prev = chat.messages[i];
      shownAlready.add(prev.id).add(asked.id);
      otherAnswer = { by: prev.provider && isProviderId(prev.provider) ? PROVIDERS[prev.provider].label : "another assistant", content: prev.content };
    }

    // A quote is from this chat's document, or (folder chat) from one of the folder's documents.
    let cleanQuote: Quote | undefined;
    if (quote && typeof quote.text === "string" && quote.text.trim() && Number.isInteger(quote.page) && quote.page >= 1) {
      const from = kind === "doc" ? id : quote.doc;
      if (typeof from !== "string" || !docs.some((d) => d.id === from)) return c.json({ error: "that passage is not from a document of this chat" }, 400);
      cleanQuote = { text: quote.text.trim(), page: quote.page, doc: kind === "folder" ? from : undefined };
    }
    const quoteDocId = cleanQuote ? (cleanQuote.doc ?? id) : null;

    if (typeof question !== "string" || !question.trim()) return c.json({ error: "question is empty" }, 400);
    const imageIds = Array.isArray(images) ? [...new Set(images)] : [];
    if (imageIds.length > MAX_IMAGES_PER_QUESTION) return c.json({ error: `at most ${MAX_IMAGES_PER_QUESTION} images per question` }, 400);
    for (const img of imageIds) {
      if (typeof img !== "string" || !isValidImageId(img) || !(await stat(imagePath(dir, img)).catch(() => null))) {
        return c.json({ error: "unknown image" }, 400);
      }
    }

    // Resume the CLI's session, unless it was started with another setup (Provider.sessionTag).
    const tag = provider.sessionTag ?? "";
    const sessionId = chat.conversations[providerId] && (chat.sessionTags?.[providerId] ?? "") === tag ? chat.conversations[providerId] : null;
    const signature = scopeSignature(scope);
    // Sessions from before folders existed were told about this document only.
    const told = chat.contextSigs?.[providerId] ?? (scope.kind === "doc" ? scopeSignature({ ...scope, folder: null }) : "");
    // ydust's search/read_pages tools over the chat's documents (that have text); the first is the default.
    const searchable = docs.filter((d) => d.hasText).map((d) => ({ alias: d.alias, name: d.name, textFile: d.textFile }));
    const mcp = searchable.length ? searchServer(searchable) : null;

    const controller = new AbortController();
    let finish!: () => void;
    running.set(key, { controller, done: new Promise<void>((r) => (finish = r)) });
    const release = () => {
      running.delete(key);
      finish();
    };

    let userMsg: Message, prompt: string;
    try {
      userMsg = newMessage({
        role: "user",
        content: question.trim(),
        quote: cleanQuote,
        images: imageIds.length ? imageIds : undefined,
        mode,
        secondOpinionOf: otherAnswer ? secondOpinionOf : undefined,
      });
      await updateChat(kind, id, (m) => void m.messages.push(userMsg));
      // Everything since this assistant's last answer (all of it, if it has no session here).
      // Answers from before multi-provider support carry no provider: they were agy's.
      const answeredBy = (m: Message) => (m.role === "assistant" ? (m.provider ?? "agy") : null);
      const lastOwn = chat.messages.map(answeredBy).lastIndexOf(providerId);
      const unseen = sessionId ? chat.messages.slice(lastOwn + 1) : chat.messages;
      prompt = buildPrompt({
        scope,
        question: question.trim(),
        quote: cleanQuote,
        quoteDoc: quoteDocId ? docs.find((d) => d.id === quoteDocId) : null,
        pageText: cleanQuote && quoteDocId ? await readPageText(quoteDocId, cleanQuote.page) : null,
        images: imageIds.map((img) => imagePath(dir, img)),
        language: typeof language === "string" ? language : undefined,
        firstTurn: !sessionId,
        contextChanged: !!sessionId && told !== signature,
        tools: !!mcp,
        toolsIntro: !!mcp && !!sessionId && (chat.toolsVersion?.[providerId] ?? 0) < TOOLS_VERSION,
        // What the other assistant discussed meanwhile is handed over as context
        // (everything, if this assistant starts a new session).
        history: unseen.filter((m) => (sessionId ? answeredBy(m) !== providerId : true) && !shownAlready.has(m.id)),
        docNames: new Map(docs.map((d) => [d.id, d.name])),
        level: typeof level === "string" ? level : undefined,
        mode,
        otherAnswer,
      });
    } catch (err) {
      release();
      throw err;
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort());
      // Chain writes so deltas always reach the client in order.
      let chain = Promise.resolve();
      const send = (event: string, data: unknown) =>
        (chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));

      let assistant;
      try {
        void send("user", userMsg);
        const cleanModel = typeof model === "string" && /^[\w.-]+$/.test(model) ? model : null;
        const cleanEffort = typeof effort === "string" && provider.efforts.includes(effort) ? effort : null;
        const result = await provider.run({
          effort: cleanEffort,
          prompt,
          cwd: dir,
          readDirs,
          mcp,
          sessionId,
          model: cleanModel,
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === "delta") void send("delta", e.text);
            else if (e.type === "tool") void send("tool", e);
          },
        });

        let content = result.response.trim();
        let error = false;
        if (result.status !== "ABORTED" && (result.error || !content)) {
          error = true;
          const resumeFailed = !!sessionId && !content;
          content = result.error
            ? `${provider.label}: ${result.error}` +
              (resumeFailed ? `\n\n${provider.label} could not continue the earlier conversation. Ask again — it will start fresh, with this chat so far as context.` : "")
            : result.denied.length
              ? `${provider.label} stopped because it tried to use a tool that is not allowed here (${result.denied.join(", ")}). Try asking again, maybe more specifically.`
              : `${provider.label} returned an empty answer.`;
        }
        const usedModel = result.model ?? cleanModel;
        assistant = newMessage({
          role: "assistant",
          content,
          error,
          stopped: result.status === "ABORTED",
          provider: providerId,
          model: usedModel ?? undefined,
          modelLabel: usedModel ? await provider.describeModel(usedModel).catch(() => usedModel) : undefined,
          effort: cleanEffort ?? (await provider.defaultEffort().catch(() => null)) ?? undefined,
        });
        await updateChat(kind, id, (m) => {
          m.messages.push(assistant!);
          if (result.sessionId && !error) {
            m.conversations[providerId] = result.sessionId;
            m.sessionTags = { ...m.sessionTags, [providerId]: tag };
            m.contextSigs = { ...m.contextSigs, [providerId]: signature };
            if (mcp) m.toolsVersion = { ...m.toolsVersion, [providerId]: TOOLS_VERSION };
          }
          // A failed resume (e.g. the CLI's session file is gone) would fail forever: start over
          // next time — the conversation so far is then handed over as context.
          else if (error && !result.response.trim() && sessionId) delete m.conversations[providerId];
        }).catch(() => {}); // the chat may have been deleted meanwhile
      } catch (err) {
        assistant = newMessage({ role: "assistant", content: (err as Error).message, error: true, provider: providerId });
        await updateChat(kind, id, (m) => void m.messages.push(assistant!)).catch(() => {});
      } finally {
        release();
      }
      await send("done", assistant);
    });
  });
}

chatRoutes("doc", "/api/docs");
chatRoutes("folder", "/api/folders");
