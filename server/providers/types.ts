import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { McpServer } from "../mcp/launch.ts";

/** Which CLI answers. */
export type ProviderId = "agy" | "claude";

export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; state: "active" | "done"; detail?: string };

export type AgentResult = {
  sessionId: string | null;
  response: string;
  /** "ABORTED" when stopped by the user. */
  status: string;
  /** Tools the agent tried to use but wasn't allowed to. */
  denied: string[];
  /** Error text from the CLI itself (e.g. not logged in). */
  error: string | null;
  /** The model that actually answered (full id), if the CLI reports it. */
  model?: string | null;
};

export type RunOptions = {
  prompt: string;
  /** Working directory; the agent may only read inside it (and inside `readDirs`). */
  cwd: string;
  /** Extra folders the agent may read (e.g. the other documents of the same folder). */
  readDirs?: string[];
  /** ydust's tools as an MCP server, if any, and which of its tools this turn has. */
  mcp?: McpServer | null;
  mcpTools?: readonly string[];
  /** This turn may search the web: every query goes through ydust's `approve` tool (the user decides). */
  web?: boolean;
  sessionId?: string | null;
  model?: string | null;
  /** Reasoning effort, one of Provider.efforts. */
  effort?: string | null;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
};

/** `id` is what we pass to --model; `detail` the full model id it stands for. */
export type Model = { id: string; label: string; detail?: string };

export interface Provider {
  id: ProviderId;
  label: string;
  /** Sessions saved under another tag (e.g. started with other tools) are not resumed. */
  sessionTag?: string;
  run(opts: RunOptions): Promise<AgentResult>;
  models(): Promise<Model[]>;
  /** What the CLI uses when no model is chosen (from its own settings). */
  defaultModel(): Promise<Model | null>;
  /** Human-readable name for a model id. */
  describeModel(id: string): Promise<string>;
  /** Selectable reasoning effort levels (empty: not supported). */
  efforts: string[];
  /**
   * Web search with the user's approval per query (see RunOptions.web). Unset: not possible
   * (`webSearchNote` says why, for the UI).
   */
  webSearch?: boolean;
  webSearchNote?: string;
  /** Effort the CLI uses when none is chosen (from its settings), if known. */
  defaultEffort(): Promise<string | null>;
  available(): Promise<boolean>;
}

const WINDOWS = process.platform === "win32";

/** Write a file only if its content changed (creating its folder). */
export async function writeFileIfChanged(file: string, content: string) {
  if ((await readFile(file, "utf8").catch(() => null)) === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/**
 * Per-chat files for the CLIs (agent, settings, MCP config), in the chat's folder. JSON goes
 * to the CLIs as a file path, never inline: on Windows a CLI installed with npm runs through
 * cmd.exe twice, where quotes inside an argument could turn "&" in a document name into a command.
 */
export const cliFile = (cwd: string, name: string) => path.join(cwd, ".agents", name);

/**
 * Stop a CLI. On Windows a CLI installed with npm is a .cmd file that runs inside cmd.exe:
 * killing that would leave the real process running, so end the whole process tree.
 */
export function killTree(child: ChildProcess, force = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (WINDOWS && child.pid) {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

/**
 * Spawn a CLI, feed every stdout line to `onLine`, and settle once it exits.
 * Handles stop (SIGTERM, then SIGKILL) and a missing binary.
 *
 * Uses cross-spawn: on Windows it finds `agy.exe` / `claude.cmd` via PATHEXT and runs .cmd
 * files through cmd.exe with safely escaped arguments (Node can't start them directly).
 * Long or multi-line input (the prompt) goes through stdin, never the command line.
 */
export function runLines(
  bin: string,
  args: string[],
  opts: SpawnOptions & { signal?: AbortSignal; stdin?: string; label: string },
  onLine: (line: string) => void,
): Promise<{ code: number | null; aborted: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Don't hand `signal` to spawn(): it would kill the child itself and report an AbortError
    // instead of a clean "stopped" result. We handle aborting below.
    const { signal: _signal, stdin: _stdin, label: _label, ...spawnOpts } = opts;
    const child = spawn(bin, args, { ...spawnOpts, windowsHide: true, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => {}); // EPIPE if the process exits before reading the prompt
    let stderr = "";
    const onAbort = () => {
      killTree(child);
      setTimeout(() => killTree(child, true), 4000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    createInterface({ input: child.stdout! }).on("line", onLine);
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`Could not find the ${opts.label} ("${bin}"). Is it installed and on your PATH?`)
          : err,
      );
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, aborted: !!opts.signal?.aborted, stderr });
    });
  });
}

/** Run a CLI briefly (e.g. `agy models`) and collect its output. Never rejects. */
export function runQuick(
  bin: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; stdout: string; notFound: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (r: { ok: boolean; notFound: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, stdout });
    };
    const child = spawn(bin, args, { env: opts.env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      killTree(child, true);
      finish({ ok: false, notFound: false });
    }, opts.timeout);
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.on("error", (err) => finish({ ok: false, notFound: (err as NodeJS.ErrnoException).code === "ENOENT" }));
    child.on("close", (code) => finish({ ok: code === 0, notFound: false }));
  });
}

/** Cache `fn` for `ms` milliseconds. */
export function cached<T>(ms: number, fn: () => Promise<T>): () => Promise<T> {
  let entry: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (!entry || Date.now() - entry.at > ms) entry = { at: Date.now(), value: fn() };
    return entry.value;
  };
}
