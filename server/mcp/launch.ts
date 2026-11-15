import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toolsFor, type NotesScope, type ScopeDoc } from "./search.ts";

/** How a CLI starts an MCP server (stdio). */
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

/** MCP server name. */
export const MCP_NAME = "ydust";
/** Every tool it can have; a turn gets the ones that apply (see ydustServer). */
export const MCP_TOOLS = ["search", "read_pages", "list_highlights", "list_notes", "read_note", "write_note"] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const serverFile = fileURLToPath(new URL("./search.ts", import.meta.url));

/**
 * ydust's MCP server for one turn: search/read_pages over these documents (the first is the
 * default for read_pages), and the chat's notes (drafts go back to ydust with the turn's
 * token). Absolute paths only: the CLI starts it from the chat's folder.
 */
export function ydustServer(docs: ScopeDoc[], notes: NotesScope | null): { server: McpServer; tools: McpTool[] } {
  const env: Record<string, string> = { YDUST_DOCS: JSON.stringify(docs) };
  if (notes) {
    env.YDUST_NOTES_DIR = notes.dir;
    if (notes.api && notes.token) {
      env.YDUST_API = notes.api;
      env.YDUST_TURN_TOKEN = notes.token;
    }
  }
  return {
    server: { command: process.execPath, args: ["--import", tsxLoader, serverFile], env },
    tools: toolsFor(docs, notes).map((t) => t.name as McpTool),
  };
}

/** Only the document tools (kept for callers that have no notes). */
export const searchServer = (docs: ScopeDoc[]) => ydustServer(docs, null).server;
