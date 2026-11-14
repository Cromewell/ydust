import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { MCP_NAME, MCP_TOOLS, type McpServer } from "../mcp/launch.ts";
import { cached, cliFile, runLines, runQuick, writeFileIfChanged, type AgentResult, type Model, type Provider, type RunOptions } from "./types.ts";

const AGY_BIN = process.env.AGY_BIN ?? "agy";

/**
 * A custom agent whose only tool is read_file: without it, agy's default agent also has
 * shell, write/edit and web search (search_web can't be blocked by permission rules).
 * agy discovers it in the working directory. A conversation keeps the agent it was
 * started with, so older sessions (see SESSION_TAG) are not resumed.
 */
const AGENT_NAME = "ydust-tutor";
const AGENT_FILE = `---
name: ${AGENT_NAME}
description: Read-only study tutor that answers questions about the user's documents.
tools:
  - read_file
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
You are a study tutor. You can only read files; follow the user's instructions about which files to read.
`;
/** Bump when the agent's tools change: sessions started with another setup are not resumed. */
const SESSION_TAG = "agent-read-only-1";

/**
 * agy reads both from the working directory ("workspace"): the read-only agent, and the
 * MCP servers in .agents/mcp_config.json — ydust's document tools, rewritten every turn
 * because the documents in scope change. (The user's global agy config stays untouched.)
 */
async function prepareWorkspace(cwd: string, mcp: McpServer | null | undefined) {
  await writeFileIfChanged(path.join(cwd, ".agents", "agents", `${AGENT_NAME}.md`), AGENT_FILE);
  const config = path.join(cwd, ".agents", "mcp_config.json");
  if (mcp) await writeFileIfChanged(config, JSON.stringify({ mcpServers: { [MCP_NAME]: mcp } }, null, 2));
  else await rm(config, { force: true });
}

/**
 * Antigravity CLI. Headless `agy` auto-denies any tool that would need approval, so we
 * pre-approve only reading the document folder (and the extra read-only folders) and
 * ydust's own document tools.
 *
 * Defense in depth: besides the read-only agent, writes, shell commands and URLs are denied
 * explicitly (writing inside the working directory would otherwise be allowed, and
 * `--mode plan` has no effect together with `--disable-slash-commands`). Deny wins over allow,
 * so other MCP tools aren't denied by a rule but stay unapproved, which headless agy refuses.
 */
async function run(opts: RunOptions): Promise<AgentResult> {
  await prepareWorkspace(opts.cwd, opts.mcp);
  const settingsFile = cliFile(opts.cwd, "agy-settings.json");
  const readDirs = opts.readDirs ?? [];
  const settings = {
    permissions: {
      allow: [
        ...[opts.cwd, ...readDirs].map((d) => `read_file(${d})`),
        ...(opts.mcp ? MCP_TOOLS.map((t) => `mcp(${MCP_NAME}/${t})`) : []),
      ],
      deny: ["write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", ...(opts.mcp ? [] : ["mcp(*)"])],
    },
  };
  // The prompt goes in on stdin (stream-json), not as an argument: it can be long and
  // multi-line, which a command line can't carry everywhere (Windows: 32k chars, cmd.exe 8k).
  await writeFileIfChanged(settingsFile, JSON.stringify(settings, null, 2));
  const args = [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--agent",
    AGENT_NAME,
    "--settings",
    settingsFile,
  ];
  for (const d of readDirs) args.push("--add-dir", d);
  if (opts.sessionId) args.push("--conversation", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);

  let sessionId = opts.sessionId ?? null;
  let response = "";
  let status = "UNKNOWN";
  let denied: string[] = [];
  let lastTextStep = -1;
  let gotResult = false;
  let extra = "";

  const { code, aborted, stderr } = await runLines(
    AGY_BIN,
    args,
    {
      cwd: opts.cwd,
      signal: opts.signal,
      label: "Antigravity CLI",
      stdin: JSON.stringify({ event: "user", message: { content: opts.prompt } }) + "\n",
    },
    (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        extra += line + "\n"; // agy prints some diagnostics as plain text
        return;
      }
      if (e.event === "init" && e.conversation_id) {
        sessionId = e.conversation_id;
        opts.onEvent({ type: "init", sessionId: e.conversation_id });
      } else if (e.event === "step_update") {
        const s = e.step_update ?? {};
        if (s.step_type === "agent_response" && s.text_delta) {
          // Separate text from distinct response steps (e.g. before and after a tool call).
          let text: string = s.text_delta;
          if (lastTextStep !== -1 && s.step_index !== lastTextStep) text = "\n\n" + text;
          lastTextStep = s.step_index;
          response += text;
          opts.onEvent({ type: "delta", text });
        } else if (s.step_type === "tool" && s.tool_name) {
          const p = s.tool_info?.parameters ?? {};
          // MCP calls arrive as call_mcp_tool { ServerName, ToolName, Arguments }.
          const mcp = s.tool_name === "call_mcp_tool" && typeof p.ToolName === "string";
          const a = mcp ? (p.Arguments ?? {}) : {};
          const detail = mcp ? (a.query ?? (a.from ? `${a.doc ?? ""} p. ${a.from}${a.to ? `–${a.to}` : ""}`.trim() : undefined)) : (p.Path ?? p.CommandLine ?? p.Url ?? p.Query);
          opts.onEvent({
            type: "tool",
            name: mcp ? `${p.ServerName}/${p.ToolName}` : s.tool_name,
            state: s.state === "DONE" ? "done" : "active",
            detail: typeof detail === "string" ? detail : undefined,
          });
        }
      } else if (e.event === "result") {
        gotResult = true;
        const r = e.result ?? {};
        status = r.status ?? status;
        sessionId = r.conversation_id ?? sessionId;
        if (typeof r.response === "string" && r.response.length > response.length) response = r.response;
        denied = (r.denied_actions ?? []).map((a: any) => a.display_name ?? a.action);
      }
    },
  );

  // agy doesn't report the model; it's either the chosen one or its configured default.
  const model = opts.model ?? (await defaultModel())?.detail ?? null;
  if (aborted) return { sessionId, response, status: "ABORTED", denied, error: null, model };
  const diag = (stderr + extra).trim();
  if (!gotResult && code !== 0) return { sessionId, response, status: "ERROR", denied, error: diag || `agy exited with code ${code}`, model };
  return { sessionId, response, status, denied, error: response.trim() ? null : diag || null, model };
}

const models = cached(10 * 60_000, async (): Promise<Model[]> => {
  const { ok, stdout } = await runQuick(AGY_BIN, ["models"], { timeout: 30_000 });
  if (!ok) return [];
  return stdout
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 2 && p[0].trim() && !p[0].includes(" "))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim(), detail: id.trim() }));
});

// `agy --help` may exit non-zero; it's available as long as it can be started.
const available = cached(60_000, async () => !(await runQuick(AGY_BIN, ["--help"], { timeout: 10_000 })).notFound);

/** agy stores the default model by its display name in ~/.gemini/antigravity-cli/settings.json. */
async function defaultModel(): Promise<Model | null> {
  try {
    const file = process.env.AGY_SETTINGS ?? path.join(homedir(), ".gemini", "antigravity-cli", "settings.json");
    const name = JSON.parse(await readFile(file, "utf8")).model;
    if (typeof name !== "string" || !name) return null;
    const match = (await models()).find((m) => m.label === name || m.id === name);
    return { id: "", label: match?.label ?? name, detail: match?.id };
  } catch {
    return null;
  }
}

async function describeModel(id: string) {
  return (await models()).find((m) => m.id === id)?.label ?? id;
}

// Gemini's effort is part of the model id ("…-flash-high"), so no separate effort picker.
export const agy: Provider = {
  id: "agy",
  label: "Antigravity",
  sessionTag: SESSION_TAG,
  run,
  models,
  defaultModel,
  describeModel,
  efforts: [],
  defaultEffort: async () => null,
  available,
};
