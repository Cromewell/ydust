import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, RunOptions } from "../server/providers/types.ts";

// The ask route with a scripted CLI: one turn per chat, sessions that are gone, errors.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-ask-"));
process.env.YDUST_LIBRARY = lib;
const { app, runtime } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");

let server: ReturnType<typeof serve>;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  runtime.apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(lib, { recursive: true, force: true });
});

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) => app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const ask = async (doc: string, body: Record<string, unknown>) => {
  const res = await req("POST", `/api/docs/${doc}/ask`, { provider: "claude", ...body });
  return { status: res.status, text: await res.text() };
};

/** The scripted CLI: `script` answers each run; `runs` records them. */
let script: (opts: RunOptions) => Promise<AgentResult>;
let runs: RunOptions[] = [];
const ok = (response: string, sessionId = "sess-new"): AgentResult => ({ sessionId, response, status: "SUCCESS", denied: [], error: null });
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()));
  });
PROVIDERS.claude = {
  ...PROVIDERS.claude,
  available: async () => true,
  describeModel: async (m) => m,
  defaultEffort: async () => null,
  run: (opts) => {
    runs.push(opts);
    return script(opts);
  },
};
beforeEach(() => {
  runs = [];
  script = async () => ok("answer");
});

const pdf = new TextEncoder().encode("%PDF-1.7\n");
const newDoc = async () => (await store.createDoc("Doc", pdf)).id;

describe("one answer at a time per chat", () => {
  it("refuses a second question that arrives at the same moment", async () => {
    const doc = await newDoc();
    let concurrent = 0;
    let most = 0;
    script = async (opts) => {
      most = Math.max(most, ++concurrent);
      await wait(150, opts.signal);
      concurrent--;
      return ok("answer");
    };
    const results = await Promise.all([ask(doc, { question: "one" }), ask(doc, { question: "two" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(most).toBe(1);
    expect((await store.readChat("doc", doc))!.messages).toHaveLength(2);
  });

  it("stays busy, and stoppable, until its answer is done", async () => {
    const doc = await newDoc();
    let stopped = false;
    script = async (opts) => {
      await wait(5000, opts.signal);
      stopped = !!opts.signal?.aborted;
      return { ...ok(""), status: opts.signal?.aborted ? "ABORTED" : "SUCCESS" };
    };
    const running = ask(doc, { question: "long" });
    await wait(100);
    expect((await (await req("GET", `/api/docs/${doc}`)).json()).busy).toBe(true);
    expect((await ask(doc, { question: "meanwhile" })).status).toBe(409);
    await req("POST", `/api/docs/${doc}/stop`);
    await running;
    expect(stopped).toBe(true);
    expect((await (await req("GET", `/api/docs/${doc}`)).json()).busy).toBe(false);
  });

  it("frees the chat when the question is refused", async () => {
    const doc = await newDoc();
    expect((await ask(doc, { question: " " })).status).toBe(400);
    expect((await ask(doc, { question: "fine" })).status).toBe(200);
  });
});

describe("sessions", () => {
  it("asks again in a new session, with the rules and the chat so far, when the old one is gone", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "first" });
    script = async (opts) => (opts.sessionId ? { ...ok("", null as unknown as string), status: "ERROR", error: "No conversation found", resumeFailed: true } : ok("fresh answer", "sess-2"));
    await ask(doc, { question: "second" });
    expect(runs.map((r) => r.sessionId)).toEqual([null, "sess-new", null]);
    expect(runs[2].prompt).toContain("Rules for the whole conversation");
    expect(runs[2].prompt).toContain("first");
    const chat = (await store.readChat("doc", doc))!;
    expect(chat.conversations.claude).toBe("sess-2");
    expect(chat.messages.at(-1)).toMatchObject({ content: "fresh answer", newSession: true });
    expect(chat.messages.at(-1)!.error).toBeFalsy();
  });

  it("keeps the session after another error (a usage limit, …)", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "first" });
    script = async () => ({ ...ok(""), status: "ERROR", error: "usage limit reached" });
    await ask(doc, { question: "second" });
    const chat = (await store.readChat("doc", doc))!;
    expect(chat.conversations.claude).toBe("sess-new");
    expect(chat.messages.at(-1)).toMatchObject({ error: true, content: "Claude: usage limit reached" });
    expect(chat.messages.at(-1)!.content).not.toContain("could not continue");
    expect(runs).toHaveLength(2); // no second try with a new session
  });
});

describe("failed answers", () => {
  const two = () => {
    // The other CLI, scripted the same way.
    PROVIDERS.agy = { ...PROVIDERS.claude, id: "agy", label: "Gemini" };
  };

  it("keeps what came before an error, says that it broke off, and keeps the old session", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "first" });
    script = async () => ({ ...ok("Half an answ", "sess-broken"), status: "ERROR", error: "quota exceeded" });
    await ask(doc, { question: "second" });
    const chat = (await store.readChat("doc", doc))!;
    expect(chat.messages.at(-1)).toMatchObject({ content: "Half an answ", brokeOff: "quota exceeded" });
    expect(chat.messages.at(-1)!.error).toBeFalsy();
    expect(chat.conversations.claude).toBe("sess-new");
    // The next question hands it over, as the session may not have it.
    script = async () => ok("whole");
    await ask(doc, { question: "go on" });
    expect(runs.at(-1)!.prompt).toContain("Half an answ");
  });

  it("an error that only repeats itself as text is just an error", async () => {
    const doc = await newDoc();
    script = async () => ({ ...ok("usage limit"), status: "ERROR", error: "usage limit reached" });
    await ask(doc, { question: "first" });
    expect((await store.readChat("doc", doc))!.messages.at(-1)).toMatchObject({ error: true, content: "Claude: usage limit reached" });
  });

  it("doesn't lose what the other assistant said when the question after it failed", async () => {
    two();
    const doc = await newDoc();
    await ask(doc, { question: "q1" });
    script = async () => ok("the other one's answer", "agy-1");
    await ask(doc, { question: "q2", provider: "agy" });
    script = async () => ({ ...ok(""), status: "ERROR", error: "quota" });
    await ask(doc, { question: "q3" });
    script = async () => ok("fine");
    await ask(doc, { question: "q4" });
    expect(runs.at(-1)!.sessionId).toBe("sess-new");
    expect(runs.at(-1)!.prompt).toContain("the other one's answer");
    // Once it got through, it isn't repeated.
    await ask(doc, { question: "q5" });
    expect(runs.at(-1)!.prompt).not.toContain("the other one's answer");
  });
});

describe("a PDF asked about before its text was read", () => {
  it("is announced once the text is there, exactly once", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "first" });
    expect(runs[0].prompt).toContain("still being read");
    expect(runs[0].prompt).not.toContain("read_pages");
    await req("PUT", `/api/docs/${doc}/text`, { pages: ["Ein langer Text über Gruppen, Ringe und Körper, genug zum Lesen."], version: 4 });
    await ask(doc, { question: "second" });
    expect(runs[1].sessionId).toBe("sess-new");
    expect(runs[1].prompt).toContain("now it can");
    expect(runs[1].prompt).toContain("read_pages");
    await ask(doc, { question: "third" });
    expect(runs[2].prompt).not.toContain("now it can");
    expect(runs[2].prompt).not.toContain("read_pages");
  });

  it("re-announces new text if the turn was aborted before init", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "first" });
    await req("PUT", `/api/docs/${doc}/text`, { pages: ["Ein langer Text über Gruppen, Ringe und Körper, genug zum Lesen."], version: 4 });
    // Aborted before init arrives on the resumed session: the CLI never received the update.
    script = async (opts) => ({ ...ok("", opts.sessionId ?? "sess-new"), status: "ABORTED" });
    await ask(doc, { question: "aborted early" });
    script = async () => ok("answer");
    await ask(doc, { question: "next" });
    expect(runs[2].prompt).toContain("now it can");
    expect(runs[2].prompt).toContain("read_pages");
  });
});

describe("prompts", () => {
  it("answers built-in prompts in the document's language, typed questions in theirs", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "Explain this passage in simple terms.", preset: true, quote: { text: "Ein Satz.", page: 1 } });
    expect(runs[0].prompt).toContain("Answer language: the language of the selected passage");
    await ask(doc, { question: "Was heißt das?" });
    expect(runs[1].prompt).toContain("Answer language: the language of my question.");
    const asked = (await store.readChat("doc", doc))!.messages.filter((m) => m.role === "user");
    expect(asked.map((m) => !!m.preset)).toEqual([true, false]);
  });

  it("clips a huge quote", async () => {
    const doc = await newDoc();
    await ask(doc, { question: "q", quote: { text: "x".repeat(100_000), page: 1 } });
    expect((await store.readChat("doc", doc))!.messages[0].quote!.text.length).toBe(20_000);
  });
});

describe("drafts", () => {
  it("are refused while a review (which only reads) runs", async () => {
    const doc = await newDoc();
    await store.updateChat("doc", doc, () => {});
    await req("PUT", `/api/docs/${doc}/notes/n.md`, { content: "# N\n", baseVersion: null });
    let status = 0;
    script = async (opts) => {
      const token = opts.mcp!.env.YDUST_TURN_TOKEN;
      const res = await fetch(`${runtime.apiBase}/api/internal/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, target: "n.md", mode: "append", content: "more", summary: "s" }),
      });
      status = res.status;
      return ok("reviewed");
    };
    await ask(doc, { question: "", mode: "review-note", note: { name: "n.md" } });
    expect(status).toBe(403);
    expect(runs[0].mcpTools).not.toContain("write_note");
  });
});
