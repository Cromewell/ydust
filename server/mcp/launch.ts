import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ScopeDoc } from "./search.ts";

/** How a CLI starts an MCP server (stdio). */
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

/** MCP server name, and its tools as each CLI names them. */
export const MCP_NAME = "ydust";
export const MCP_TOOLS = ["search", "read_pages"] as const;

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const serverFile = fileURLToPath(new URL("./search.ts", import.meta.url));

/**
 * ydust's search server for one turn, limited to these documents (the first is the default
 * for read_pages). Absolute paths only: the CLI starts it from the chat's folder.
 */
export function searchServer(docs: ScopeDoc[]): McpServer {
  return {
    command: process.execPath,
    args: ["--import", tsxLoader, serverFile],
    env: { YDUST_DOCS: JSON.stringify(docs) },
  };
}
