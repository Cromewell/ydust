import { describe, expect, it } from "vitest";
import { groupModels, parseModels, pickVariant } from "../server/providers/agy.ts";
import { parseClaudeInfo, prettyClaude } from "../server/providers/claude.ts";
import type { ProviderInfo } from "../src/lib/api.ts";
import { claudeFamily, newestPerFamily } from "../src/lib/claudeModels.ts";
import { nearestEffort, splitEffort } from "../src/lib/effort.ts";
import { choose } from "../src/lib/models.ts";

const all = parseModels(
  [
    "Fetching available models...",
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
    "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
    "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
    "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n"),
);

describe("Gemini's models", () => {
  it("are listed once, with their efforts in order", () => {
    expect(groupModels(all, "gemini-4-hydrogen-high")).toEqual([
      { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: [], defaultEffort: null },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"], defaultEffort: "medium" },
    ]);
  });

  it.each([
    ["gemini-4-hydrogen", "xhigh", "gemini-4-hydrogen-xhigh"],
    ["gemini-4-hydrogen", null, "gemini-4-hydrogen-medium"],
    ["gemini-3.8-flash", "max", "gemini-3.8-flash-high"], // the closest it has
    ["gemini-3.8-flash-high", null, "gemini-3.8-flash-high"], // a full id (older versions)
    ["gemini-3.8-flash-high", "low", "gemini-3.8-flash-low"],
    ["claude-opus-4-6-thinking", "high", "claude-opus-4-6-thinking"],
    ["gpt-oss-120b", null, "gpt-oss-120b-medium"],
    [null, "low", "gemini-4-hydrogen-low"], // agy's default model with another effort
    ["unknown-model", "low", "unknown-model"],
  ])("%s with effort %s → %s", (model, effort, id) => {
    expect(pickVariant(all, model, effort, "gemini-4-hydrogen-medium")).toBe(id);
  });

  it("without any choice or known default, agy decides", () => {
    expect(pickVariant(all, null, "low", null)).toBeNull();
  });
});

describe("Claude's models", () => {
  const line = (id: string, response: unknown) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  it("have display names, not ids or aliases", () => {
    const info = parseClaudeInfo([
      "noise",
      line("initialize", {
        models: [
          { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best" },
          { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high"] },
          { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1" },
        ],
      }),
      line("get_settings", { applied: { model: "claude-opus-5-5", effort: "medium" } }),
    ]);
    expect(info).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
      models: [
        { id: "opus", label: "Claude Opus 5.5", detail: "claude-opus-5-5", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high"] },
        { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1", detail: "claude-fable-5-1", description: undefined, efforts: [] },
      ],
    });
    expect(prettyClaude("claude-fable-5-1[1m]")).toBe("Claude Fable 5.1");
  });
  it("recognizes the default model under its own name", () => {
    const info = parseClaudeInfo([
      line("get_settings", { applied: { model: "claude-fable-5-1[1m]", effort: "high" } }),
      line("initialize", { models: [{ value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1" }] }),
    ]);
    expect(info.model).toBe("claude-fable-5-1");
  });
  it("an older Claude Code that can't answer lists nothing", () => {
    expect(parseClaudeInfo(["Error: unknown"])).toEqual({ models: [], model: null, effort: null });
  });
});

it("splits and matches efforts", () => {
  expect(splitEffort("gemini-4-hydrogen-xhigh")).toEqual(["gemini-4-hydrogen", "xhigh"]);
  expect(splitEffort("claude-opus-4-6-thinking")).toEqual(["claude-opus-4-6-thinking", null]);
  expect(nearestEffort(["low", "high"], "medium")).toBe("low");
  expect(nearestEffort(["medium", "high"], "low")).toBe("medium");
  expect(nearestEffort([], "low")).toBeNull();
});

describe("choose", () => {
  const provider: ProviderInfo = {
    id: "claude",
    label: "Claude",
    cli: "claude",
    available: true,
    efforts: ["low", "medium", "high", "max"],
    models: [
      { id: "opus", label: "Claude Opus 5.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" },
      { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1", efforts: ["low", "high"] },
    ],
    defaultModel: { id: "", label: "Claude Opus 5.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" },
    webSearch: true,
    webSearchNote: null,
  };
  it("falls back to the default, and fits the effort to the model", () => {
    expect(choose(provider, "", "")).toMatchObject({ id: "", effort: "", defaultEffort: "medium" });
    expect(choose(provider, "gone", "max")).toMatchObject({ id: "", effort: "max" });
    expect(choose(provider, "fable", "max")).toMatchObject({ id: "claude-fable-5-1[1m]", effort: "high", defaultEffort: null });
  });
  it("follows a family to its newest model", () => {
    expect(choose(provider, "claude-fable-4-9[1m]", "")).toMatchObject({ id: "claude-fable-5-1[1m]" });
    expect(choose(provider, "claude-opus-4-6-20260101", "")).toMatchObject({ id: "opus" });
    expect(choose({ ...provider, id: "agy" }, "fable", "")).toMatchObject({ id: "" });
  });
  it("keeps the choice while the models aren't loaded", () => {
    expect(choose(undefined, "opus", "high")).toMatchObject({ id: "opus", effort: "high" });
  });
});

describe("newestPerFamily", () => {
  const ids = (list: [string, string?][]) => newestPerFamily(list.map(([id, detail]) => ({ id, detail }))).map((m) => m.id);
  it("keeps one model per family, the newest", () => {
    expect(ids([["claude-opus-4-8"], ["opus", "claude-opus-5-5"], ["claude-fable-5-1[1m]", "claude-fable-5-1"], ["claude-fable-5-10"], ["claude-fable-5"], ["haiku", "claude-haiku-5-5"]])).toEqual([
      "opus",
      "claude-fable-5-10",
      "haiku",
    ]);
    expect(ids([["claude-3-5-sonnet-20241022"], ["claude-sonnet-4-20250514"]])).toEqual(["claude-sonnet-4-20250514"]);
  });
  it("prefers the plain one of the same version, and leaves other models alone", () => {
    expect(ids([["sonnet[1m]", "claude-sonnet-5-5"], ["sonnet", "claude-sonnet-5-5"]])).toEqual(["sonnet"]);
    expect(ids([["my-gateway/model-a"], ["my-gateway/model-b"]])).toEqual(["my-gateway/model-a", "my-gateway/model-b"]);
    expect(ids([["gpt-4"], ["gpt-5"]])).toEqual(["gpt-4", "gpt-5"]);
    expect(ids([["opus"], ["claude-opus-4-8"]])).toEqual(["opus"]);
    expect(claudeFamily("claude-fable-5-1[1m]")).toEqual({ family: "fable", version: [5, 1] });
  });
});
