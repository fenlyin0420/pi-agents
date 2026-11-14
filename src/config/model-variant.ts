/**
 * OpenCode model variant suffixes ("provider/model#variant").
 *
 * OpenCode writes the variant into the model id itself; pi resolves only the
 * ":" suffix form, so a shared agent file whose `model:` carries "#high" would
 * send the literal id to the provider and get "Model is unavailable". Splitting
 * the suffix here keeps one agent file usable by both hosts.
 */

import type { ThinkingLevel } from "../types.ts";
import { THINKING_LEVELS } from "../types.ts";

export interface ModelVariantSplit {
  /** Model reference with the variant suffix removed. */
  model?: string;
  /** Variant name from the suffix, when the reference had one. */
  variant?: string;
  /** Thinking level the variant names, when it names one of the pi levels. */
  thinking?: ThinkingLevel;
}

/**
 * Split a trailing "#variant" off a model reference.
 *
 * The suffix is only a variant when both sides are non-empty; anything else is
 * returned unchanged so a model id that legitimately contains "#" survives.
 */
export function splitModelVariant(ref: string | undefined): ModelVariantSplit {
  if (!ref) return { model: ref };

  const hashIndex = ref.lastIndexOf("#");
  if (hashIndex <= 0) return { model: ref };

  const model = ref.slice(0, hashIndex).trim();
  const variant = ref.slice(hashIndex + 1).trim();
  if (!model || !variant) return { model: ref };

  const thinking = THINKING_LEVELS.find((level) => level === variant);
  return { model, variant, thinking };
}
