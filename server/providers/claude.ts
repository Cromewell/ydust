import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { MCP_NAME } from "../mcp/launch.ts";
import { newestPerFamily } from "../../src/lib/claudeModels.ts";
import { SYSTEM_RULES } from "../prompt.ts";
import { LIBRARY_DIR, writeAtomic } from "../store.ts";
import { cached, cliFile, runLines, runQuick, writeFileIfChanged, type AgentResult, type Model, type Provider, type RunOptions } from "./types.ts";

/** --effort levels. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
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
/** Options that not every Claude Code version knows (see `features`). */
export type ClaudeFeatures = {
  /** "manual" is the current name of the "default" permission mode (which still works, unlisted). */
  manualMode?: boolean;
  /** File with ydust's tutor rules for --append-system-prompt-file, if this version has it. */
  systemPromptFile?: string | null;
};

/** Claude Code's command line for a turn (`mcpConfig`: the file with ydust's MCP server). */
export function claudeArgs(opts: Omit<RunOptions, "prompt" | "onEvent" | "cwd">, mcpConfig: string | null, features: ClaudeFeatures = {}): string[] {
  const mcpArgs = mcpConfig ? ["--mcp-config", mcpConfig] : [];
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    features.manualMode ? "manual" : "default",
    // Only ydust's own MCP server (if any), and only its tools are pre-approved.
    "--strict-mcp-config",
    ...mcpArgs,
    "--tools",
    "Read",
    "Grep",
    "Glob",
    // Web turns: WebSearch exists but is not pre-approved, so every query asks ydust's `approve`
    // tool, i.e. the user. (No WebFetch: pages are never opened.)
    ...(opts.web && mcpConfig ? ["WebSearch"] : []),
  ];
  if (opts.web && mcpConfig) args.push("--permission-prompt-tool", `mcp__${MCP_NAME}__approve`);
  // ydust's tools are pre-approved, except `approve` itself (the CLI calls it, not the model).
  const approved = (opts.mcpTools ?? []).filter((t) => t !== "approve");
  if (mcpConfig && approved.length) args.push("--allowedTools", ...approved.map((t) => `mcp__${MCP_NAME}__${t}`));
  // The tutor rules as part of the system prompt, so they outlast the automatic compaction of long chats.
  if (features.systemPromptFile) args.push("--append-system-prompt-file", features.systemPromptFile);
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
  const has = await features();
  let systemPromptFile: string | null = null;
  if (has.systemPromptFile) {
    systemPromptFile = cliFile(opts.cwd, "claude-system.md");
    await writeFileIfChanged(systemPromptFile, SYSTEM_RULES);
  }
  const args = claudeArgs(opts, mcpConfig, { manualMode: has.manualMode, systemPromptFile });

  let sessionId = opts.sessionId ?? null;
  let response = "";
  let finalText = "";
  let sawText = false;
  let newMessage = false;
  let isError = false;
  let resultError: string | null = null;
  let gotResult = false;
  let resumeFailed = false;
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
        const errors: string[] = Array.isArray(e.errors) ? e.errors.filter((x: unknown): x is string => typeof x === "string") : [];
        if (isError) resultError = finalText || errors.join("\n") || `Claude stopped (${e.subtype ?? "error"}).`;
        // `--resume` with a session that is gone (e.g. Claude Code was reinstalled).
        if (opts.sessionId && errors.some((x) => /no conversation found/i.test(x))) resumeFailed = true;
        denied = (e.permission_denials ?? []).map((d: any) => d.tool_name).filter(Boolean);
      }
    },
  );

  if (model) void remember(opts.model ?? "", model);
  if (aborted) return { sessionId, response, status: "ABORTED", denied, error: null, model };
  if (opts.sessionId && !response.trim() && /no conversation found/i.test(stderr)) resumeFailed = true;
  if (resumeFailed) return { sessionId: null, response: "", status: "ERROR", denied, error: resultError ?? stderr.trim(), model, resumeFailed };
  if (!gotResult) return { sessionId, response, status: "ERROR", denied, error: stderr.trim() || `claude exited with code ${code}`, model };
  if (isError) return { sessionId, response, status: "ERROR", denied, error: resultError, model };
  return { sessionId, response: response.trim() ? response : finalText, status: "SUCCESS", denied, error: null, model };
}

/** "claude-opus-5-5" → "Claude Opus 5.5" (dates like -20250101 and a "[1m]" are dropped). */
export function prettyClaude(id: string) {
  const parts = id.replace(/\[\w+\]$/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
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

// Claude Code accepts aliases that always point at the latest model of each family. If it can't
// list its models (see `info`), the full id behind an alias is learned from the answers (their
// init event names the model) and remembered, so the picker can show real names.
const ALIASES = ["opus", "sonnet", "haiku", "fable"];
const LEARNED_FILE = path.join(LIBRARY_DIR, "claude-models.json");
let learned: Promise<Record<string, string>> | null = null;
const learnedModels = () => (learned ??= readFile(LEARNED_FILE, "utf8").then((t) => JSON.parse(t) as Record<string, string>).catch(() => ({}) as Record<string, string>));

/** `alias` ("" = the default) answered with `id`. */
async function remember(alias: string, id: string) {
  const all = await learnedModels();
  if (all[alias] === id) return;
  all[alias] = id;
  await writeAtomic(LEARNED_FILE, JSON.stringify(all, null, 2)).catch(() => {});
}

/** What Claude Code says about itself: its models, and what a session without any choice would use. */
export type ClaudeInfo = { models: Model[]; model: string | null; effort: string | null };

/** The answers to PROBE, one JSON per line. */
export function parseClaudeInfo(lines: string[]): ClaudeInfo {
  const info: ClaudeInfo = { models: [], model: null, effort: null };
  for (const line of lines) {
    let r: any;
    try {
      r = JSON.parse(line)?.response?.response;
    } catch {
      continue;
    }
    if (Array.isArray(r?.models)) {
      info.models = r.models
        // "default" is the account's recommendation: ydust shows the user's own default instead.
        .filter((m: any) => typeof m?.value === "string" && m.value !== "default")
        .map((m: any): Model => {
          const full = typeof m.resolvedModel === "string" ? m.resolvedModel : null;
          // "Opus 5.5 · Best for everyday, complex tasks": the name is in the label already.
          const description = typeof m.description === "string" ? m.description.split(" · ").slice(1).join(" · ") : "";
          return {
            id: m.value,
            label: full ? prettyClaude(full) : String(m.displayName ?? m.value),
            detail: full ?? m.value,
            description: description || undefined,
            efforts: Array.isArray(m.supportedEffortLevels) ? EFFORTS.filter((e) => m.supportedEffortLevels.includes(e)) : [],
          };
        });
    }
    if (r?.applied) {
      if (typeof r.applied.model === "string") info.model = r.applied.model;
      if (EFFORTS.includes(r.applied.effort)) info.effort = r.applied.effort;
    }
  }
  // Either way it may name its own model ("claude-fable-5-1[1m]"): the full id, as in the list.
  info.model = info.models.find((m) => m.detail === info.model || m.id === info.model)?.detail ?? info.model;
  return info;
}

/** Control requests of the stream-json protocol: no prompt, so nothing is answered or billed. */
const PROBE = ["initialize", "get_settings"].map((subtype) => JSON.stringify({ type: "control_request", request_id: subtype, request: { subtype } }) + "\n").join("");
const info = cached(
  10 * 60_000,
  async (): Promise<ClaudeInfo> => {
    const lines: string[] = [];
    const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
    // Older versions don't know these requests: then the aliases below have to do.
    await runLines(CLAUDE_BIN, args, { cwd: tmpdir(), env: cleanEnv(), stdin: PROBE, signal: AbortSignal.timeout(10_000), label: "Claude CLI" }, (l) => void lines.push(l)).catch(() => {});
    return parseClaudeInfo(lines);
  },
  (i) => i.models.length > 0,
);

const models = async (): Promise<Model[]> => {
  const { models } = await info();
  if (models.length) return Promise.all(newestPerFamily(models).map(async (m) => ({ ...m, defaultEffort: await defaultEffort(m.id) })));
  const known = await learnedModels();
  return ALIASES.map((alias) => ({
    id: alias,
    label: known[alias] ? prettyClaude(known[alias]) : `Claude ${alias.charAt(0).toUpperCase()}${alias.slice(1)}`,
    detail: known[alias] ?? alias,
    efforts: EFFORTS,
  }));
};

async function defaultModel(): Promise<Model | null> {
  const { models, model, effort } = await info();
  const id = model ?? (await learnedModels())[""];
  if (!id) return null;
  const listed = models.find((m) => m.detail === id);
  return { id: "", label: prettyClaude(id), detail: id, description: listed?.description, efforts: listed?.efforts ?? EFFORTS, defaultEffort: effort ?? (await defaultEffort(id)) };
}

async function describeModel(id: string) {
  // Aliases stand for the full id they resolve to; full ids are prettified directly.
  const { models } = await info();
  return prettyClaude(models.find((m) => m.id === id)?.detail ?? (await learnedModels())[id] ?? id);
}

/**
 * Does this claude accept these options? Asked without any input, so it stops right after
 * reading its command line ("Input must be provided"), before any request.
 */
async function accepts(args: string[]) {
  const r = await runQuick(CLAUDE_BIN, ["--print", "--tools", "", "--strict-mcp-config", "--no-session-persistence", ...args], { timeout: 20_000, env: cleanEnv(), cwd: tmpdir() });
  return !r.notFound && !/unknown option|invalid|error: option/i.test(r.stderr + r.stdout) && /input must be provided/i.test(r.stderr + r.stdout);
}
const features = cached(10 * 60_000, async () => {
  // Our own file (another user's ydust on a shared computer may probe at the same time).
  const probe = path.join(tmpdir(), `ydust-claude-probe-${process.pid}.md`);
  await writeFile(probe, "probe\n").catch(() => {});
  try {
    const [manualMode, systemPromptFile] = await Promise.all([accepts(["--permission-mode", "manual"]), accepts(["--append-system-prompt-file", probe])]);
    return { manualMode, systemPromptFile };
  } finally {
    await rm(probe, { force: true });
  }
});

const available = cached(60_000, async () => (await runQuick(CLAUDE_BIN, ["--version"], { timeout: 10_000, env: cleanEnv() })).ok);

/**
 * The effort used when none is chosen: for the default model Claude Code says it itself; for
 * another one, only an effort saved for that model in its settings is certain.
 */
async function defaultEffort(model: string | null): Promise<string | null> {
  const i = await info();
  const id = model ? (i.models.find((m) => m.id === model)?.detail ?? model) : i.model;
  if (i.effort && id === i.model) return i.effort;
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
    const settings = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    // A Claude Code that doesn't answer `info` is an older one, with a single setting.
    const level = (id && settings.modelSettings?.[id]?.effortLevel) ?? (i.models.length ? null : settings.effortLevel);
    return typeof level === "string" && EFFORTS.includes(level) ? level : null;
  } catch {
    return null;
  }
}

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  cli: "Claude Code (claude)",
  run,
  models,
  defaultModel,
  describeModel,
  efforts: EFFORTS,
  defaultEffort,
  webSearch: true,
  available,
};
