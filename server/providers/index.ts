import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import type { Provider, ProviderId } from "./types.ts";

export const PROVIDERS: Record<ProviderId, Provider> = { agy, claude };

export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && v in PROVIDERS;

export type { AgentEvent, AgentResult, Model, Provider, ProviderId } from "./types.ts";
