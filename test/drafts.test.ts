import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "../server/mcp/launch.ts";
import type { RunOptions } from "../server/providers/types.ts";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-drafts-"));
process.env.YDUST_LIBRARY = lib;
const { app, runtime } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { MAX_DRAFTS, draftsDir } = await import("../server/drafts.ts");
const { notesDir, versionOf } = await import("../server/notes.ts");

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

// The MCP server is a real child process: it reaches this app over real HTTP, like in production.
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

/** A JSON-RPC client for ydust's MCP server, started the way a CLI starts it. */
function connect(mcp: McpServer) {
  const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const msg = JSON.parse(l);
    waiting.get(msg.id)?.(msg);
  });
  let next = 1;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    tools: async () => (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name) as string[],
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      return { text: r.content[0].text as string, error: !!r.isError };
    },
    close: () => child.kill(),
  };
}
type Client = ReturnType<typeof connect>;

/** Stand-in for a CLI: runs `script` against ydust's MCP server and answers with what it returns. */
let script: (mcp: Client, opts: RunOptions) => Promise<string> = async () => "ok";
let lastOpts: RunOptions | null = null;
PROVIDERS.claude = {
  ...PROVIDERS.claude,
  available: async () => true,
  describeModel: async (m) => m,
  defaultEffort: async () => null,
  async run(opts) {
    lastOpts = opts;
    const mcp = connect(opts.mcp!);
    try {
      const response = await script(mcp, opts);
      return { sessionId: "session-1", response, status: "SUCCESS", denied: [], error: null };
    } finally {
      mcp.close();
    }
  },
};

/** Ask a question; returns the server-sent events. */
async function ask(url: string, body: Record<string, unknown>) {
  const res = await req("POST", url, { provider: "claude", ...body });
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: ?(.*)$/m)?.[1];
      const data = chunk.match(/^data: ?(.*)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("write_note → draft → review", () => {
  let doc: string;
  let askUrl: string;
  beforeAll(async () => {
    doc = (await store.createDoc("Script", new TextEncoder().encode("%PDF"))).id;
    askUrl = `/api/docs/${doc}/ask`;
  });

  it("gives every turn the notes tools, even without document text", async () => {
    let tools: string[] = [];
    script = async (mcp) => ((tools = await mcp.tools()), "fine");
    await ask(askUrl, { question: "hi" });
    expect(tools).toEqual(["list_notes", "read_note", "write_note"]);
    expect(lastOpts!.mcpTools).toEqual(["list_notes", "read_note", "write_note"]);
  });

  it("stores a draft, streams it, and leaves the notes untouched", async () => {
    script = async (mcp) => {
      expect((await mcp.call("list_notes")).text).toBe("There are no notes yet.");
      const w = await mcp.call("write_note", { name: "Exercises chapter 2.md", mode: "create", content: "# Exercises\n\n1. Show $a_n \\to 0$.", summary: "Five exercises" });
      expect(w.error).toBe(false);
      expect(w.text).toContain("Saved as a draft for review");
      return "I drafted five exercises.";
    };
    const events = await ask(askUrl, { question: "Write me exercises into a note." });
    const draft = events.find((e) => e.event === "draft")!.data;
    expect(draft).toMatchObject({ target: "Exercises chapter 2.md", mode: "create", summary: "Five exercises", revision: 1 });
    const done = events.find((e) => e.event === "done")!.data;
    expect(done.drafts).toEqual([draft]);
    expect(await exists(path.join(draftsDir("doc", doc), `${draft.id}.json`))).toBe(true);
    expect(await exists(path.join(notesDir("doc", doc), "Exercises chapter 2.md"))).toBe(false);

    const shown = await (await req("GET", `/api/docs/${doc}/drafts/${draft.id}`)).json();
    expect(shown).toMatchObject({ content: "# Exercises\n\n1. Show $a_n \\to 0$.", current: null, status: "open" });
    expect((await (await req("GET", `/api/docs/${doc}/notes`)).json())).toEqual([]);
  });

  it("accepts a draft into a renamed note, and records that on the answer", async () => {
    const [d] = await (await req("GET", `/api/docs/${doc}/drafts`)).json();
    const res = await req("POST", `/api/docs/${doc}/drafts/${d.id}/accept`, { target: "Exercises.md" });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(notesDir("doc", doc), "Exercises.md"), "utf8")).toBe("# Exercises\n\n1. Show $a_n \\to 0$.");
    expect(await exists(path.join(draftsDir("doc", doc), `${d.id}.json`))).toBe(false);
    const meta = (await store.readMeta(doc))!;
    expect(meta.messages.flatMap((m) => m.drafts ?? []).find((x) => x.id === d.id)).toMatchObject({ status: "accepted", acceptedAs: "Exercises.md" });
    expect((await req("POST", `/api/docs/${doc}/drafts/${d.id}/accept`, {})).status).toBe(404);
  });

  it("appends only against the version the user saw", async () => {
    script = async (mcp) => {
      const w = await mcp.call("write_note", { name: "Exercises.md", mode: "append", content: "2. Another one.", summary: "One more" });
      expect(w.error).toBe(false);
      return "Added one.";
    };
    const draft = (await ask(askUrl, { question: "One more exercise" })).find((e) => e.event === "draft")!.data;
    const shown = await (await req("GET", `/api/docs/${doc}/drafts/${draft.id}`)).json();
    expect(shown.current.content).toContain("# Exercises");

    // The user edits the note meanwhile: accepting against the old version is refused, with the new one.
    const saved = await (await req("PUT", `/api/docs/${doc}/notes/Exercises.md`, { content: "# Exercises (mine)\n\n1. Mine.", baseVersion: shown.current.version })).json();
    const stale = await req("POST", `/api/docs/${doc}/drafts/${draft.id}/accept`, { base: shown.current.version });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toEqual({ content: "# Exercises (mine)\n\n1. Mine.", version: saved.version });

    expect((await req("POST", `/api/docs/${doc}/drafts/${draft.id}/accept`, { base: saved.version })).status).toBe(200);
    expect(await readFile(path.join(notesDir("doc", doc), "Exercises.md"), "utf8")).toBe("# Exercises (mine)\n\n1. Mine.\n\n2. Another one.\n");
  });

  it("refuses replace unless the note was read as it is now, and create over an existing note", async () => {
    const results: { text: string; error: boolean }[] = [];
    script = async (mcp) => {
      results.push(await mcp.call("write_note", { name: "Exercises.md", mode: "replace", content: "# New", summary: "s" }));
      results.push(await mcp.call("write_note", { name: "Exercises.md", mode: "create", content: "# New", summary: "s" }));
      results.push(await mcp.call("write_note", { name: "Missing.md", mode: "append", content: "x", summary: "s" }));
      results.push(await mcp.call("write_note", { name: "../escape.md", mode: "create", content: "x", summary: "s" }));
      results.push(await mcp.call("write_note", { name: "Big.md", mode: "create", content: "x".repeat(200_001), summary: "s" }));
      // Reading outside the chat's notes folder is refused like writing.
      for (const name of ["../meta.json", "../../state.json", "..\\meta.json", ".drafts", 7]) {
        expect((await mcp.call("read_note", { name })).text).not.toContain("{");
      }
      expect((await mcp.call("read_note", { name: "Exercises.md" })).text).toContain("2. Another one.");
      results.push(await mcp.call("write_note", { name: "Exercises.md", mode: "replace", content: "# Exercises (mine)\n\n1. Mine, improved.", summary: "Improved" }));
      return "done";
    };
    const events = await ask(askUrl, { question: "Rewrite it" });
    expect(results.map((r) => r.error)).toEqual([true, true, true, true, true, false]);
    expect(results[0].text).toContain("Read \"Exercises.md\" with read_note first");
    expect(results[1].text).toContain("already exists");
    expect(results[2].text).toContain('Use mode "create"');
    expect(results[3].text).toContain("Invalid note name");
    expect(results[4].text).toContain("at most 200 kB");
    expect(events.filter((e) => e.event === "draft")).toHaveLength(1);
  });

  it("discarding leaves no trace in the notes", async () => {
    const before = await readFile(path.join(notesDir("doc", doc), "Exercises.md"), "utf8");
    const [d] = await (await req("GET", `/api/docs/${doc}/drafts`)).json();
    expect(d.mode).toBe("replace");
    expect((await req("DELETE", `/api/docs/${doc}/drafts/${d.id}`)).status).toBe(200);
    expect(await readFile(path.join(notesDir("doc", doc), "Exercises.md"), "utf8")).toBe(before);
    expect(await readdir(draftsDir("doc", doc))).toEqual([]);
    const meta = (await store.readMeta(doc))!;
    expect(meta.messages.flatMap((m) => m.drafts ?? []).find((x) => x.id === d.id)?.status).toBe("discarded");
  });

  it("'Request changes' revises a draft: version 2 replaces version 1", async () => {
    script = async (mcp) => (await mcp.call("write_note", { name: "Cheat sheet.md", mode: "create", content: "# Cheat sheet\n\nv1", summary: "v1" }), "v1");
    const v1 = (await ask(askUrl, { question: "Cheat sheet please" })).find((e) => e.event === "draft")!.data;

    let prompt = "";
    script = async (mcp, opts) => {
      prompt = opts.prompt;
      await mcp.call("write_note", { name: "Cheat sheet.md", mode: "create", content: "# Cheat sheet\n\nv2", summary: "v2" });
      return "Revised.";
    };
    const events = await ask(askUrl, { question: "Shorter please", draftId: v1.id });
    const user = events.find((e) => e.event === "user")!.data;
    expect(user.draftRef).toEqual({ id: v1.id, target: "Cheat sheet.md", revision: 1 });
    expect(prompt).toContain("v1");
    expect(prompt).toContain("My requested changes: Shorter please");
    const v2 = events.find((e) => e.event === "draft")!.data;
    expect(v2).toMatchObject({ revision: 2, replaces: v1.id });

    // Version 1 stays readable until version 2 is decided, but can't be accepted.
    expect((await (await req("GET", `/api/docs/${doc}/drafts/${v1.id}`)).json()).status).toBe("superseded");
    expect((await req("POST", `/api/docs/${doc}/drafts/${v1.id}/accept`, {})).status).toBe(409);
    expect((await req("POST", askUrl, { provider: "claude", question: "again", draftId: v1.id })).status).toBe(409);

    expect((await req("POST", `/api/docs/${doc}/drafts/${v2.id}/accept`, {})).status).toBe(200);
    expect(await readFile(path.join(notesDir("doc", doc), "Cheat sheet.md"), "utf8")).toBe("# Cheat sheet\n\nv2");
    expect(await readdir(draftsDir("doc", doc))).toEqual([]);
    const drafts = (await store.readMeta(doc))!.messages.flatMap((m) => m.drafts ?? []);
    expect(drafts.find((x) => x.id === v1.id)?.status).toBe("superseded");
    expect(drafts.find((x) => x.id === v2.id)?.status).toBe("accepted");
  });

  it("keeps at most 20 drafts per chat, dropping the oldest", async () => {
    script = async (mcp) => {
      for (let i = 0; i < MAX_DRAFTS + 3; i++) await mcp.call("write_note", { name: `n${i}.md`, mode: "create", content: `${i}`, summary: "" });
      return "many";
    };
    await ask(askUrl, { question: "many" });
    const left = await (await req("GET", `/api/docs/${doc}/drafts`)).json();
    expect(left).toHaveLength(MAX_DRAFTS);
    expect(left.map((d: { target: string }) => d.target)).not.toContain("n0.md");
  });

  it("'Reset chat' removes open drafts and keeps the notes", async () => {
    expect((await req("POST", `/api/docs/${doc}/reset`)).status).toBe(200);
    expect(await exists(draftsDir("doc", doc))).toBe(false);
    expect(await exists(path.join(notesDir("doc", doc), "Exercises.md"))).toBe(true);
  });

  it("works for folder chats, writing into the folder's notes", async () => {
    const f = (await store.createFolder("Course")).id;
    script = async (mcp) => (await mcp.call("write_note", { name: "Overview.md", mode: "create", content: "# Course", summary: "s" }), "ok");
    const d = (await ask(`/api/folders/${f}/ask`, { question: "overview" })).find((e) => e.event === "draft")!.data;
    expect((await req("POST", `/api/folders/${f}/drafts/${d.id}/accept`, {})).status).toBe(200);
    expect(await readFile(path.join(notesDir("folder", f), "Overview.md"), "utf8")).toBe("# Course");
    expect(versionOf("# Course")).toHaveLength(16);
  });
});

describe("the internal route", () => {
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    app.request("/api/internal/drafts", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  it("needs the token of a running turn", async () => {
    for (const token of [undefined, "", "x".repeat(64), 42]) {
      const res = await post({ token, target: "a.md", mode: "create", content: "x", summary: "" });
      expect(res.status).toBe(403);
    }
  });

  it("rejects anything that looks like a browser request", async () => {
    let token = "";
    let results: number[] = [];
    script = async (_mcp, opts) => {
      token = opts.mcp!.env.YDUST_TURN_TOKEN;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const body = { token, target: "a.md", mode: "create", content: "x", summary: "" };
      results = [
        (await post(body, { origin: "http://127.0.0.1:5173" })).status,
        (await post(body, { "sec-fetch-site": "same-origin" })).status,
        (await post(body, { "sec-fetch-site": "none" })).status,
      ];
      return "ok";
    };
    const doc = (await store.createDoc("Other", new TextEncoder().encode("%PDF"))).id;
    await ask(`/api/docs/${doc}/ask`, { question: "q" });
    expect(results).toEqual([403, 403, 403]);
    // The turn is over: its token is worthless now.
    expect((await post({ token, target: "a.md", mode: "create", content: "x", summary: "" })).status).toBe(403);
    expect(await exists(draftsDir("doc", doc))).toBe(false);
  });
});
