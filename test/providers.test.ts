import { describe, expect, it } from "vitest";
import { MCP_TOOLS, ydustServer } from "../server/mcp/launch.ts";
import { agySettings } from "../server/providers/agy.ts";
import { claudeArgs } from "../server/providers/claude.ts";
import { runLines } from "../server/providers/types.ts";

// The promise in the README: the assistant reads, and proposes notes only as drafts.
// These tests pin down what each CLI is allowed to do.

const docs = [{ alias: "d1", name: "Script", textFile: "/lib/d1/document.txt" }];
const turn = ydustServer(docs, { dir: "/lib/d1/notes", api: "http://127.0.0.1:8787", token: "t".repeat(64) });

/** The values that follow a flag, up to the next flag. */
function values(args: string[], flag: string) {
  const i = args.indexOf(flag);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  return out;
}

describe("Claude Code", () => {
  const args = claudeArgs({ mcp: turn.server, mcpTools: turn.tools, readDirs: ["/lib/d2"], sessionId: "s", model: "opus", effort: "high" }, "/lib/d1/.agents/claude-mcp.json");

  it("has only the read-only built-in tools", () => {
    expect(values(args, "--tools")).toEqual(["Read", "Grep", "Glob"]);
  });

  it("never gets tools that write, run commands or go online", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task"]) {
      expect(args, t).not.toContain(t);
    }
  });

  it("pre-approves only ydust's own MCP tools, and loads no other MCP server", () => {
    expect(values(args, "--allowedTools")).toEqual(["mcp__ydust__search", "mcp__ydust__read_pages", "mcp__ydust__list_highlights", "mcp__ydust__list_notes", "mcp__ydust__read_note", "mcp__ydust__write_note"]);
    expect(args).toContain("--strict-mcp-config");
    expect(values(args, "--permission-mode")).toEqual(["default"]);
  });

  it("uses the current name of the permission mode, and the rules file, where the CLI has them", () => {
    const newer = claudeArgs({ mcp: turn.server, mcpTools: turn.tools }, "/x.json", { manualMode: true, systemPromptFile: "/lib/d1/.agents/claude-system.md" });
    expect(values(newer, "--permission-mode")).toEqual(["manual"]);
    expect(values(newer, "--append-system-prompt-file")).toEqual(["/lib/d1/.agents/claude-system.md"]);
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("without ydust's server, approves nothing", () => {
    const bare = claudeArgs({}, null);
    expect(bare).not.toContain("--allowedTools");
    expect(bare).not.toContain("--mcp-config");
  });
});

describe("Claude Code with web search on", () => {
  const web = ydustServer(docs, { dir: "/lib/d1/notes", api: "http://127.0.0.1:8787", token: "t".repeat(64) }, { web: true });
  const args = claudeArgs({ mcp: web.server, mcpTools: web.tools, web: true }, "/lib/d1/.agents/claude-mcp.json");

  it("has WebSearch, but never pre-approved: every query asks ydust's approve tool", () => {
    expect(values(args, "--tools")).toEqual(["Read", "Grep", "Glob", "WebSearch"]);
    expect(values(args, "--allowedTools")).not.toContain("WebSearch");
    expect(values(args, "--permission-prompt-tool")).toEqual(["mcp__ydust__approve"]);
    expect(web.server.env.YDUST_WEB).toBe("1");
    expect(web.tools).toContain("approve");
  });

  it("never pre-approves the approve tool itself, and never gets WebFetch", () => {
    expect(values(args, "--allowedTools")).not.toContain("mcp__ydust__approve");
    for (const t of ["WebFetch", "Bash", "Write", "Edit"]) expect(args).not.toContain(t);
  });

  it("without the toggle: no WebSearch, no permission prompt tool", () => {
    const plain = claudeArgs({ mcp: turn.server, mcpTools: turn.tools }, "/x.json");
    expect(plain).not.toContain("WebSearch");
    expect(plain).not.toContain("--permission-prompt-tool");
    expect(turn.tools).not.toContain("approve");
  });

  it("web search needs ydust's MCP server (no server, no search)", () => {
    expect(claudeArgs({ web: true }, null)).not.toContain("WebSearch");
  });
});

describe("Antigravity", () => {
  const settings = agySettings({ cwd: "/lib/d1", readDirs: ["/lib/d2"], mcp: turn.server, mcpTools: turn.tools });

  it("still denies writing files, commands and URLs", () => {
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["write_file(*)", "command(*)", "read_url(*)", "execute_url(*)"]));
  });

  it("allows reading the chat's folders and ydust's tools, nothing else", () => {
    expect(settings.permissions.allow).toEqual([
      "read_file(/lib/d1)",
      "read_file(/lib/d2)",
      "mcp(ydust/search)",
      "mcp(ydust/read_pages)",
      "mcp(ydust/list_highlights)",
      "mcp(ydust/list_notes)",
      "mcp(ydust/read_note)",
      "mcp(ydust/write_note)",
    ]);
  });

  it("without ydust's server, denies every MCP tool", () => {
    expect(agySettings({ cwd: "/lib/d1" }).permissions.deny).toContain("mcp(*)");
  });
});

describe("ydust's MCP server for a turn", () => {
  it("gets the notes folder, and the API and token only together", () => {
    expect(turn.server.env).toMatchObject({ YDUST_NOTES_DIR: "/lib/d1/notes", YDUST_API: "http://127.0.0.1:8787", YDUST_TURN_TOKEN: "t".repeat(64) });
    expect(turn.tools).toEqual(MCP_TOOLS.filter((t) => t !== "approve"));
    const noApi = ydustServer(docs, { dir: "/lib/d1/notes" });
    expect(noApi.server.env).not.toHaveProperty("YDUST_TURN_TOKEN");
    expect(noApi.tools).toEqual(["search", "read_pages", "list_highlights", "list_notes", "read_note"]);
  });

  it("offers search only when there is text to search", () => {
    expect(ydustServer([], { dir: "/x", api: "http://127.0.0.1:1", token: "t" }).tools).toEqual(["list_notes", "read_note", "write_note"]);
  });
});

describe("runLines", () => {
  it("ends a CLI at once when the answer was stopped before it started", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const started = Date.now();
    const r = await runLines(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { signal: stopped.signal, label: "test" }, () => {});
    expect(r.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
