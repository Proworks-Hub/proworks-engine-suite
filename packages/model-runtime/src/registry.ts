// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import type { IntelligenceTask, Stakes } from "@proworks-hub/intelligence-core";

// ─────────────────────────────────────────────────────────────────────────────
// Which model serves which task.
//
// Data, not code, so changing a route is a configuration change rather than a
// deployment. That matters more than it sounds: model deprecations arrive on
// somebody else's schedule, and a routing table that requires a release to
// edit is one that will be edited during an incident.
//
// Prices live here too, with the date they were correct. A price with no date
// is a number nobody can judge, and every cost figure derived from it inherits
// that.
// ─────────────────────────────────────────────────────────────────────────────

export const modelDescriptorSchema = z
  .object({
    /** The adapter that can serve it. */
    provider: z.string().min(1),
    /** The provider's own identifier, verbatim. */
    model: z.string().min(1),
    /** Tasks this model is registered to serve. */
    tasks: z.array(z.string()).min(1),
    /** Lower is preferred. Ties are broken by declaration order. */
    preference: z.number().int().default(100),
    /**
     * Whether this model may serve a `critical` request.
     *
     * Explicit rather than inferred from preference: a cheap fast model is a
     * perfectly good fallback for a low-stakes classification and the wrong
     * thing to silently substitute when a caller said the answer matters.
     */
    allowedForCritical: z.boolean().default(false),
    /** Whether the provider can guarantee a JSON shape natively. */
    supportsStructuredOutput: z.boolean().default(false),
    contextTokens: z.number().int().positive().optional(),
    pricing: z
      .object({
        inputPerMillionUsd: z.number().nonnegative(),
        outputPerMillionUsd: z.number().nonnegative(),
        /** When this price was last confirmed. Surfaced with every estimate. */
        pricedAt: z.string().min(1),
      })
      .strict()
      .optional(),
    /** Set when a provider has announced an end date. */
    deprecatedAfter: z.string().optional(),
  })
  .strict();
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export interface ModelRegistry {
  /** Candidates for a task, best first. */
  routesFor(task: IntelligenceTask, stakes: Stakes): ModelDescriptor[];
  all(): ModelDescriptor[];
  /** Models whose end date has passed or is near, for the console to warn about. */
  deprecated(withinDays: number, now?: Date): ModelDescriptor[];
}

export function createModelRegistry(models: readonly ModelDescriptor[]): ModelRegistry {
  const parsed = models.map((model) => modelDescriptorSchema.parse(model));

  return {
    routesFor(task, stakes) {
      return parsed
        .filter((model) => model.tasks.includes(task))
        // A critical request is never served by a model not cleared for it,
        // even as a last resort. A caller that said "this matters" would rather
        // have an error than a plausible answer from the cheap model.
        .filter((model) => (stakes === "critical" ? model.allowedForCritical : true))
        .sort((a, b) => a.preference - b.preference);
    },

    all() {
      return [...parsed];
    },

    deprecated(withinDays, now = new Date()) {
      const cutoff = now.getTime() + withinDays * 86_400_000;
      return parsed.filter(
        (model) => model.deprecatedAfter !== undefined && Date.parse(model.deprecatedAfter) <= cutoff,
      );
    },
  };
}

/**
 * Estimates what a call cost.
 *
 * Returns undefined rather than zero when there is no price. Zero is a claim
 * that the call was free, which is never true and quietly makes a spend
 * dashboard read low.
 */
export function estimateCost(
  model: ModelDescriptor,
  usage: { inputTokens: number; outputTokens: number },
): { estimatedCostUsd: number; pricedAt: string } | undefined {
  if (!model.pricing) return undefined;
  return {
    estimatedCostUsd:
      (usage.inputTokens / 1_000_000) * model.pricing.inputPerMillionUsd +
      (usage.outputTokens / 1_000_000) * model.pricing.outputPerMillionUsd,
    pricedAt: model.pricing.pricedAt,
  };
}

/**
 * How stale a price is, in days.
 *
 * Surfaced beside every spend figure. A cost estimate from a price list nobody
 * has touched in a year is not evidence, and the console should say so rather
 * than presenting a confident number.
 */
export function priceAgeDays(pricedAt: string, now: Date = new Date()): number | null {
  const at = Date.parse(pricedAt);
  if (Number.isNaN(at)) return null;
  return Math.floor((now.getTime() - at) / 86_400_000);
}
