import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { MCP_NAME, type McpServer } from "../mcp/launch.ts";
import { EFFORTS, nearestEffort, splitEffort } from "../../src/lib/effort.ts";
import { SYSTEM_RULES } from "../prompt.ts";
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
You can only read files; follow the user's instructions about which files to read.

${SYSTEM_RULES}`;
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
/** Antigravity's permissions for a turn. */
export function agySettings(opts: Pick<RunOptions, "cwd" | "readDirs" | "mcp" | "mcpTools">) {
  return {
    permissions: {
      allow: [
        ...[opts.cwd, ...(opts.readDirs ?? [])].map((d) => `read_file(${d})`),
        ...(opts.mcp ? (opts.mcpTools ?? []).filter((t) => t !== "approve").map((t) => `mcp(${MCP_NAME}/${t})`) : []),
      ],
      deny: ["write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", ...(opts.mcp ? [] : ["mcp(*)"])],
    },
  };
}

async function run(opts: RunOptions): Promise<AgentResult> {
  await prepareWorkspace(opts.cwd, opts.mcp);
  const chosen = opts.model || opts.effort ? pickVariant(await variants(), opts.model ?? null, opts.effort ?? null, await defaultId()) : null;
  const settingsFile = cliFile(opts.cwd, "agy-settings.json");
  const readDirs = opts.readDirs ?? [];
  const settings = agySettings(opts);
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
  if (chosen) args.push("--model", chosen);

  let sessionId = opts.sessionId ?? null;
  let response = "";
  let status = "UNKNOWN";
  let denied: string[] = [];
  let lastTextStep = -1;
  let gotResult = false;
  let resultError = "";
  let extra = "";
  // A conversation that no longer exists: agy only warns and starts a new, empty one, which
  // would answer without the rules and the chat so far. Stop it right away and say so.
  let resumeFailed = false;
  const giveUp = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, giveUp.signal]) : giveUp.signal;

  const { code, aborted, stderr } = await runLines(
    AGY_BIN,
    args,
    {
      cwd: opts.cwd,
      signal,
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
        if (opts.sessionId && e.conversation_id !== opts.sessionId) {
          resumeFailed = true;
          giveUp.abort();
          return;
        }
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
          const detail = mcp ? (a.query ?? a.name ?? (a.from ? `${a.doc ?? ""} p. ${a.from}${a.to ? `–${a.to}` : ""}`.trim() : undefined)) : (p.Path ?? p.CommandLine ?? p.Url ?? p.Query);
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
        resultError = typeof r.error === "string" ? r.error : typeof r.error?.message === "string" ? r.error.message : "";
        denied = (r.denied_actions ?? []).map((a: any) => a.display_name ?? a.action);
      }
    },
  );

  // agy doesn't report the model; it's either the chosen one or its configured default.
  const model = chosen ?? (await defaultId());
  const effort = model ? splitEffort(model)[1] : null;
  if (resumeFailed && !opts.signal?.aborted) {
    return { sessionId: null, response: "", status: "ERROR", denied, error: `conversation ${opts.sessionId} not found`, model, effort, resumeFailed };
  }
  if (aborted) return { sessionId, response, status: "ABORTED", denied, error: null, model, effort };
  const diag = (stderr + extra).trim();
  if (!gotResult && code !== 0) return { sessionId, response, status: "ERROR", denied, error: diag || `agy exited with code ${code}`, model, effort };
  // It may have said something before it failed: still a failure.
  if (/ERROR|FAIL/i.test(status)) return { sessionId, response, status: "ERROR", denied, error: resultError || diag || "agy failed without saying why", model, effort };
  return { sessionId, response, status, denied, error: response.trim() ? null : diag || null, model, effort };
}

/** agy lists every effort of a model as a model of its own ("gemini-4-hydrogen-high"). */
export type Variant = { id: string; label: string };
export function parseModels(stdout: string): Variant[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 2 && p[0].trim() && !p[0].includes(" "))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}
const variants = cached(
  10 * 60_000,
  async () => {
    const { ok, stdout } = await runQuick(AGY_BIN, ["models"], { timeout: 30_000 });
    return ok ? parseModels(stdout) : [];
  },
  (list) => list.length > 0,
);

/** A variant's label without its effort: "Gemini 4 Hydrogen (High)" → "Gemini 4 Hydrogen". */
const familyLabel = (v: Variant) => (splitEffort(v.id)[1] ? v.label.replace(/\s*\((?:minimal|low|medium|x-?high|high|max)\)$/i, "") : v.label);

const effortsOf = (all: Variant[], family: string) =>
  EFFORTS.filter((e) => all.some((v) => v.id === `${family}-${e}`));

/** The effort a family gets when none is chosen: that of agy's default model, else medium. */
function familyDefault(all: Variant[], family: string, defaultVariant: string | null) {
  const [f, e] = splitEffort(defaultVariant ?? "");
  return f === family && e ? e : nearestEffort(effortsOf(all, family), "medium");
}

/** One model per family, with the efforts it comes in. */
export function groupModels(all: Variant[], defaultVariant: string | null): Model[] {
  const families = new Map<string, Variant>();
  for (const v of all) {
    const family = splitEffort(v.id)[0];
    if (!families.has(family)) families.set(family, v);
  }
  return [...families].map(([family, v]) => ({
    id: family,
    label: familyLabel(v),
    efforts: effortsOf(all, family),
    defaultEffort: familyDefault(all, family, defaultVariant),
  }));
}

/** The id to pass to agy for a model (a family, a full id, or null: agy's default) and an effort. */
export function pickVariant(all: Variant[], model: string | null, effort: string | null, defaultVariant: string | null): string | null {
  const wanted = model || defaultVariant;
  if (!wanted) return null;
  if (!effort && all.some((v) => v.id === wanted)) return wanted;
  const family = all.some((v) => v.id === wanted) ? splitEffort(wanted)[0] : wanted;
  const level = nearestEffort(effortsOf(all, family), effort ?? familyDefault(all, family, defaultVariant) ?? "medium");
  if (level) return `${family}-${level}`;
  // Not listed (or the list couldn't be read): agy knows best.
  return effort && !all.length && !splitEffort(wanted)[1] ? `${wanted}-${effort}` : wanted;
}

const models = async () => groupModels(await variants(), await defaultId());

// `agy --help` may exit non-zero; it's available as long as it can be started.
const available = cached(60_000, async () => !(await runQuick(AGY_BIN, ["--help"], { timeout: 10_000 })).notFound);

/** agy stores the default model by its display name in ~/.gemini/antigravity-cli/settings.json. */
async function defaultName(): Promise<string | null> {
  try {
    const file = process.env.AGY_SETTINGS ?? path.join(homedir(), ".gemini", "antigravity-cli", "settings.json");
    const name = JSON.parse(await readFile(file, "utf8")).model;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
async function defaultId(): Promise<string | null> {
  const name = await defaultName();
  return (name && (await variants()).find((v) => v.label === name || v.id === name)?.id) || null;
}

async function defaultModel(): Promise<Model | null> {
  const [name, id] = [await defaultName(), await defaultId()];
  if (!id) return name ? { id: "", label: name } : null;
  const family = (await models()).find((m) => m.id === splitEffort(id)[0]);
  return family ? { ...family, id: "", detail: id } : null;
}

/** The family's name: the effort is recorded (and shown) separately. */
async function describeModel(id: string) {
  const v = (await variants()).find((m) => m.id === id);
  return v ? familyLabel(v) : id;
}

async function defaultEffort(model: string | null) {
  const id = pickVariant(await variants(), model, null, await defaultId());
  return id ? splitEffort(id)[1] : null;
}

// agy runs other vendors' models too, but it is there for Gemini. Its effort is part of the model id.
export const agy: Provider = {
  id: "agy",
  label: "Gemini",
  cli: "Antigravity CLI (agy)",
  sessionTag: SESSION_TAG,
  run,
  models,
  defaultModel,
  describeModel,
  efforts: EFFORTS,
  // Headless agy can't ask for approval per action (only `agy acp` could), and its search_web
  // can't be limited by permission rules: no web search rather than searches without a click.
  webSearchNote: "Gemini can't ask you to approve each search when it runs in the background, so web search is only available with Claude.",
  defaultEffort,
  available,
};
