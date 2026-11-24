import type { Model, ProviderInfo } from "./api";
import { claudeFamily } from "./claudeModels";
import { nearestEffort } from "./effort";

/**
 * The model and effort a question will use, from the remembered choice ("" = the CLI's default).
 * An id the CLI doesn't list (any more) counts as the default; an older Claude model or a short
 * name ("fable") as the listed one of its family. `effort` is "" unless one was chosen.
 */
export function choose(provider: ProviderInfo | undefined, modelId: string, effort: string) {
  if (!provider) return { model: null, id: modelId, efforts: [], effort, defaultEffort: null }; // not loaded yet
  const family = provider.id === "claude" && modelId ? claudeFamily(modelId)?.family : undefined;
  const listed = provider.models.find((m) => m.id === modelId) ?? (family ? provider.models.find((m) => claudeFamily(m.id)?.family === family) : undefined);
  const model: Model | null = listed ?? provider.defaultModel ?? null;
  const efforts = model?.efforts ?? (model ? [] : provider.efforts);
  return {
    /** The listed model that was chosen, or the default (null: unknown). */
    model,
    id: listed?.id ?? "",
    efforts,
    effort: effort ? (nearestEffort(efforts, effort) ?? "") : "",
    /** What is used when no effort is chosen, if known. */
    defaultEffort: model?.defaultEffort ?? null,
  };
}
