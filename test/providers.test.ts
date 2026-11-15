import { describe, expect, it } from "vitest";
import { MCP_TOOLS, ydustServer } from "../server/mcp/launch.ts";
import { agySettings } from "../server/providers/agy.ts";
import { claudeArgs } from "../server/providers/claude.ts";

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

  it("without ydust's server, approves nothing", () => {
    const bare = claudeArgs({}, null);
    expect(bare).not.toContain("--allowedTools");
    expect(bare).not.toContain("--mcp-config");
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
    expect(turn.tools).toEqual([...MCP_TOOLS]);
    const noApi = ydustServer(docs, { dir: "/lib/d1/notes" });
    expect(noApi.server.env).not.toHaveProperty("YDUST_TURN_TOKEN");
    expect(noApi.tools).toEqual(["search", "read_pages", "list_highlights", "list_notes", "read_note"]);
  });

  it("offers search only when there is text to search", () => {
    expect(ydustServer([], { dir: "/x", api: "http://127.0.0.1:1", token: "t" }).tools).toEqual(["list_notes", "read_note", "write_note"]);
  });
});
