import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "../server/mcp/launch.ts";
import type { RunOptions } from "../server/providers/types.ts";

// store.ts (imported by app.ts) reads YDUST_LIBRARY when it is imported.
const lib = await mkdtemp(path.join(tmpdir(), "ydust-web-"));
process.env.YDUST_LIBRARY = lib;
const { app, runtime } = await import("../server/app.ts");
const store = await import("../server/store.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");

const headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

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

/** ydust's MCP server, started the way Claude Code starts it; `approve` called the way it calls it. */
function connect(mcp: McpServer) {
  const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
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
    /** What Claude Code does before a tool that isn't pre-approved. */
    permission: async (tool_name: string, input: Record<string, unknown>) =>
      JSON.parse((await rpc("tools/call", { name: "approve", arguments: { tool_name, input, tool_use_id: "toolu_1" } })).result.content[0].text),
    close: () => child.kill(),
  };
}
type Client = ReturnType<typeof connect>;

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
      return { sessionId: "s", response: await script(mcp, opts), status: "SUCCESS", denied: [], error: null };
    } finally {
      mcp.close();
    }
  },
};

type Event = { event: string; data: any };
/** Ask, reading events as they arrive; `onEvent` plays the browser (e.g. answers approvals). */
async function ask(url: string, body: Record<string, unknown>, onEvent: (e: Event) => void | Promise<void> = () => {}) {
  const res = await req("POST", url, { provider: "claude", ...body });
  if (res.status !== 200) return { status: res.status, events: [] as Event[], body: await res.json() };
  const events: Event[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const e = { event: chunk.match(/^event: ?(.*)$/m)?.[1] ?? "", data: JSON.parse(chunk.match(/^data: ?(.*)$/m)?.[1] ?? "null") };
      events.push(e);
      await onEvent(e);
    }
  }
  return { status: 200, events, body: null };
}

describe("web search, approved query by query", () => {
  let doc: string;
  let url: string;
  beforeAll(async () => {
    doc = (await store.createDoc("Analysis", new TextEncoder().encode("%PDF"))).id;
    url = `/api/docs/${doc}/ask`;
  });
  const decide = (aid: string, body: unknown) => req("POST", `/api/docs/${doc}/approvals/${aid}`, body);

  it("asks the user, runs the allowed query, and records it", async () => {
    let decision: unknown;
    script = async (mcp, opts) => {
      expect(opts.web).toBe(true);
      expect(await mcp.tools()).toContain("approve");
      decision = await mcp.permission("WebSearch", { query: "Bolzano Weierstrass theorem", allowed_domains: ["example.org"] });
      return "Found it.";
    };
    const r = await ask(url, { question: "What else is known?", web: true }, async (e) => {
      if (e.event === "approval") {
        expect(e.data).toMatchObject({ kind: "web-search", query: "Bolzano Weierstrass theorem", n: 1 });
        expect((await decide(e.data.id, { decision: "allow" })).status).toBe(200);
      }
    });
    // Only the approved query goes on: nothing else the model put into the input.
    expect(decision).toEqual({ behavior: "allow", updatedInput: { query: "Bolzano Weierstrass theorem" } });
    expect(r.events.find((e) => e.event === "user")!.data.web).toBe(true);
    expect(r.events.find((e) => e.event === "done")!.data.webQueries).toEqual(["Bolzano Weierstrass theorem"]);
    expect(lastOpts!.prompt).toContain("Web search is on for this question");
  });

  it("runs an edited query instead", async () => {
    let decision: any;
    script = async (mcp) => ((decision = await mcp.permission("WebSearch", { query: "my whole note text here" })), "ok");
    const r = await ask(url, { question: "q", web: true }, async (e) => {
      if (e.event === "approval") await decide(e.data.id, { decision: "allow", query: "  sequence limit uniqueness " });
    });
    expect(decision.updatedInput.query).toBe("sequence limit uniqueness");
    expect(r.events.find((e) => e.event === "done")!.data.webQueries).toEqual(["sequence limit uniqueness"]);
  });

  it("a declined search tells the model to answer from the documents", async () => {
    let decision: any;
    script = async (mcp) => ((decision = await mcp.permission("WebSearch", { query: "x" })), "From the documents: …");
    const r = await ask(url, { question: "q", web: true }, async (e) => {
      if (e.event === "approval") await decide(e.data.id, { decision: "deny" });
    });
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("declined");
    expect(decision.message).toContain("Answer from the documents");
    expect(r.events.find((e) => e.event === "done")!.data.webQueries).toBeUndefined();
  });

  it("denies every other tool at once, without asking", async () => {
    const decisions: any[] = [];
    script = async (mcp) => {
      for (const t of ["WebFetch", "Bash", "Write", "Read", "mcp__ydust__approve"]) decisions.push(await mcp.permission(t, { url: "https://x", command: "rm -rf /" }));
      decisions.push(await mcp.permission("WebSearch", { query: "  " }));
      return "ok";
    };
    const r = await ask(url, { question: "q", web: true });
    expect(decisions.every((d) => d.behavior === "deny")).toBe(true);
    expect(r.events.some((e) => e.event === "approval")).toBe(false);
  });

  it("counts consecutive searches", async () => {
    const ns: number[] = [];
    script = async (mcp) => {
      await mcp.permission("WebSearch", { query: "a" });
      await mcp.permission("WebSearch", { query: "b" });
      return "ok";
    };
    const r = await ask(url, { question: "q", web: true }, async (e) => {
      if (e.event === "approval") {
        ns.push(e.data.n);
        await decide(e.data.id, { decision: "allow" });
      }
    });
    expect(ns).toEqual([1, 2]);
    expect(r.events.find((e) => e.event === "done")!.data.webQueries).toEqual(["a", "b"]);
  });

  it("no answer in time counts as a denial", async () => {
    runtime.approvalTimeoutMs = 300;
    let decision: any;
    script = async (mcp) => ((decision = await mcp.permission("WebSearch", { query: "slow" })), "ok");
    const r = await ask(url, { question: "q", web: true });
    runtime.approvalTimeoutMs = 5 * 60_000;
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("didn't answer");
    expect(r.events.find((e) => e.event === "approval-done")!.data).toMatchObject({ decision: "deny" });
  });

  it("stopping the answer denies a waiting search", async () => {
    let decision: any;
    script = async (mcp) => ((decision = await mcp.permission("WebSearch", { query: "stop me" })), "ok");
    await ask(url, { question: "q", web: true }, async (e) => {
      if (e.event === "approval") expect((await req("POST", `/api/docs/${doc}/stop`)).status).toBe(200);
    });
    expect(decision.behavior).toBe("deny");
  });

  it("validates the user's decision", async () => {
    expect((await decide("nope", { decision: "allow" })).status).toBe(404);
    script = async (mcp) => (await mcp.permission("WebSearch", { query: "q" }), "ok");
    await ask(url, { question: "q", web: true }, async (e) => {
      if (e.event !== "approval") return;
      expect((await decide(e.data.id, { decision: "maybe" })).status).toBe(400);
      expect((await decide(e.data.id, { decision: "allow", query: "   " })).status).toBe(400);
      // Another chat can't answer it.
      const other = (await store.createDoc("Other", new TextEncoder().encode("%PDF"))).id;
      expect((await req("POST", `/api/docs/${other}/approvals/${e.data.id}`, { decision: "allow" })).status).toBe(404);
      expect((await decide(e.data.id, { decision: "deny" })).status).toBe(200);
      expect((await decide(e.data.id, { decision: "allow" })).status).toBe(404); // answered already
    });
  });

  it("without the toggle there is no approve tool, and the route refuses searches", async () => {
    let tools: string[] = [];
    let token = "";
    script = async (mcp, opts) => {
      tools = await mcp.tools();
      token = opts.mcp!.env.YDUST_TURN_TOKEN;
      const res = await app.request("/api/internal/approvals", { method: "POST", headers, body: JSON.stringify({ token, kind: "web-search", query: "x" }) });
      expect(await res.json()).toEqual({ decision: "deny", reason: "not-allowed" });
      return "ok";
    };
    const r = await ask(url, { question: "q" });
    expect(tools).not.toContain("approve");
    expect(lastOpts!.web).toBe(false);
    expect(lastOpts!.prompt).not.toContain("Web search is on");
    expect(r.events.find((e) => e.event === "user")!.data.web).toBeUndefined();
  });

  it("refuses web search for an assistant that can't ask per query", async () => {
    const r = await ask(url, { question: "q", web: true, provider: "agy" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("approve each search");
  });

  it("the internal route is closed to browsers", async () => {
    for (const h of [{ origin: "http://127.0.0.1:5173" }, { "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
      const res = await app.request("/api/internal/approvals", { method: "POST", headers: { ...headers, ...h }, body: "{}" });
      expect(res.status).toBe(403);
    }
  });
});
