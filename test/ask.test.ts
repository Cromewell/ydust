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
