import spawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { MCP_NAME } from "../mcp/launch.ts";
import { cached, cliFile, killTree, runLines, runQuick, writeFileIfChanged, type AgentResult, type Model, type Provider, type RunOptions } from "./types.ts";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

/**
 * Variables Claude Code sets for its own child processes. If ydust is started from inside
 * a Claude Code session, they would make our `claude` think it's a nested sub-session.
 * (User configuration like CLAUDE_CONFIG_DIR or API settings is kept.)
 */
const SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
  "CLAUDE_CODE_EMIT_STARTUP_TIMING",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_EFFORT",
  "NODE_OPTIONS", // e.g. a loader from the process that started ydust
];
function cleanEnv() {
  const env = { ...process.env };
  for (const k of SESSION_VARS) delete env[k];
  return env;
}

/**
 * Claude Code CLI in print mode. Only the read-only tools Read/Grep/Glob exist in the
 * session (no Bash, no edits, no web), plus ydust's own tools as the only MCP server (its
 * write_note only proposes drafts); in "default" permission mode anything outside the
 * working directory and the added folders is denied.
 */
/** Claude Code's command line for a turn (`mcpConfig`: the file with ydust's MCP server). */
export function claudeArgs(opts: Omit<RunOptions, "prompt" | "onEvent" | "cwd">, mcpConfig: string | null): string[] {
  const mcpArgs = mcpConfig ? ["--mcp-config", mcpConfig] : [];
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "default",
    // Only ydust's own MCP server (if any), and only its tools are pre-approved.
    "--strict-mcp-config",
    ...mcpArgs,
    "--tools",
    "Read",
    "Grep",
    "Glob",
  ];
  if (mcpConfig && opts.mcpTools?.length) args.push("--allowedTools", ...opts.mcpTools.map((t) => `mcp__${MCP_NAME}__${t}`));
  for (const d of opts.readDirs ?? []) args.push("--add-dir", d);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

async function run(opts: RunOptions): Promise<AgentResult> {
  // --strict-mcp-config alone loads no MCP servers; with ydust's tools, their config as a file.
  let mcpConfig: string | null = null;
  if (opts.mcp) {
    mcpConfig = cliFile(opts.cwd, "claude-mcp.json");
    await writeFileIfChanged(mcpConfig, JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "stdio", ...opts.mcp } } }, null, 2));
  }
  const args = claudeArgs(opts, mcpConfig);

  let sessionId = opts.sessionId ?? null;
  let response = "";
  let finalText = "";
  let sawText = false;
  let newMessage = false;
  let isError = false;
  let resultError: string | null = null;
  let gotResult = false;
  let denied: string[] = [];
  let model: string | null = null;
  const toolNames = new Map<string, string>();

  const { code, aborted, stderr } = await runLines(
    CLAUDE_BIN,
    args,
    // The prompt goes in on stdin: no argv length limits, no option parsing surprises.
    { cwd: opts.cwd, env: cleanEnv(), signal: opts.signal, stdin: opts.prompt, label: "Claude CLI" },
    (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "system" && e.subtype === "init" && e.session_id) {
        sessionId = e.session_id;
        if (typeof e.model === "string") model = e.model;
        opts.onEvent({ type: "init", sessionId: e.session_id });
      } else if (e.type === "stream_event") {
        const ev = e.event ?? {};
        if (ev.type === "message_start") newMessage = true;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          let text: string = ev.delta.text;
          // Separate text of distinct assistant messages (e.g. before and after a tool call).
          if (newMessage && sawText) text = "\n\n" + text;
          newMessage = false;
          sawText = true;
          response += text;
          opts.onEvent({ type: "delta", text });
        }
      } else if (e.type === "assistant") {
        for (const b of e.message?.content ?? []) {
          if (b.type !== "tool_use") continue;
          toolNames.set(b.id, b.name);
          const i = b.input ?? {};
          const detail = i.file_path ?? i.pattern ?? i.path ?? i.query ?? i.name ?? (i.from ? `${i.doc ?? ""} p. ${i.from}${i.to ? `–${i.to}` : ""}`.trim() : undefined);
          opts.onEvent({ type: "tool", name: b.name, state: "active", detail: typeof detail === "string" ? detail : undefined });
        }
      } else if (e.type === "user") {
        const content = e.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === "tool_result") opts.onEvent({ type: "tool", name: toolNames.get(b.tool_use_id) ?? "tool", state: "done" });
        }
      } else if (e.type === "result") {
        gotResult = true;
        sessionId = e.session_id ?? sessionId;
        isError = !!e.is_error || (e.subtype && e.subtype !== "success");
        finalText = typeof e.result === "string" ? e.result : "";
        if (isError) resultError = finalText || `Claude stopped (${e.subtype ?? "error"}).`;
        denied = (e.permission_denials ?? []).map((d: any) => d.tool_name).filter(Boolean);
      }
    },
  );

  if (aborted) return { sessionId, response, status: "ABORTED", denied, error: null, model };
  if (!gotResult) return { sessionId, response, status: "ERROR", denied, error: stderr.trim() || `claude exited with code ${code}`, model };
  if (isError) return { sessionId, response, status: "ERROR", denied, error: resultError, model };
  return { sessionId, response: response.trim() ? response : finalText, status: "SUCCESS", denied, error: null, model };
}

/** "claude-opus-5-5" → "Claude Opus 5.5" (dates like -20250101 are dropped). */
export function prettyClaude(id: string) {
  const parts = id.split("-").filter((p) => !/^\d{8}$/.test(p));
  const words: string[] = [];
  let version: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) version.push(p);
    else {
      if (version.length) words.push(version.join(".")), (version = []);
      words.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  if (version.length) words.push(version.join("."));
  return words.join(" ");
}

/**
 * Which full model an alias (or the default, "") stands for. Claude Code has no "list
 * models" command, but its first stream-json line (the init event) names the resolved
 * model, so we start it and kill it right there — no session is saved.
 */
function resolveModel(alias: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--strict-mcp-config"];
    if (alias) args.push("--model", alias);
    const child = spawn(CLAUDE_BIN, args, { env: cleanEnv(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let found: string | null = null;
    const timer = setTimeout(() => killTree(child, true), 20_000);
    child.on("error", () => resolve(null));
    child.stdin!.on("error", () => {});
    child.stdin!.end("x");
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const e = JSON.parse(line);
        if (e.type === "system" && e.subtype === "init") {
          found = typeof e.model === "string" ? e.model : null;
          killTree(child, true);
        }
      } catch {}
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(found);
    });
  });
}

// Claude Code accepts aliases that always point at the latest model of each family.
const ALIASES = ["opus", "sonnet", "haiku", "fable"];
const resolved = cached(30 * 60_000, async () => {
  const ids = await Promise.all(["", ...ALIASES].map(resolveModel));
  return { default: ids[0], aliases: ALIASES.map((a, i) => ({ alias: a, id: ids[i + 1] })) };
});

const models = async (): Promise<Model[]> =>
  (await resolved()).aliases.map(({ alias, id }) => ({
    id: alias,
    label: id ? prettyClaude(id) : `${alias.charAt(0).toUpperCase()}${alias.slice(1)} (latest)`,
    detail: id ?? alias,
  }));

async function defaultModel(): Promise<Model | null> {
  const id = (await resolved()).default;
  return id ? { id: "", label: prettyClaude(id), detail: id } : null;
}

async function describeModel(id: string) {
  // Aliases resolve to full ids; full ids are prettified directly.
  const alias = (await resolved()).aliases.find((a) => a.alias === id);
  return prettyClaude(alias?.id ?? id);
}

const available = cached(60_000, async () => (await runQuick(CLAUDE_BIN, ["--version"], { timeout: 10_000, env: cleanEnv() })).ok);

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Claude Code's default effort is the "effortLevel" in its user settings. */
async function defaultEffort(): Promise<string | null> {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
    const level = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")).effortLevel;
    return typeof level === "string" && EFFORTS.includes(level) ? level : null;
  } catch {
    return null;
  }
}

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  run,
  models,
  defaultModel,
  describeModel,
  efforts: EFFORTS,
  defaultEffort,
  available,
};
