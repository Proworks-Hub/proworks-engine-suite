// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { MANIFESTO_TRACEABILITY_V5 } from "./data.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Manifesto Traceability Matrix, ingested verbatim.
//
// Copied rather than paraphrased, and the ids are the manifesto's own. A
// traceability matrix whose ids were renumbered on import cannot be traced
// back to the document it came from, which is the one thing it exists to do.
//
// This is a REFERENCE, not an authority. It records what the manifesto says
// each rule is for and who owns it. Whether the repository satisfies a rule is
// a conformance question, answered by the chamber against an ARCH rule that
// cites the TR id — see `rules.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export const traceabilityRuleSchema = z
  .object({
    id: z.string().regex(/^TR-\d{3}$/),
    rule: z.string().min(1),
    why: z.string().min(1),
    owner: z.string().min(1),
    implementation: z.string().min(1),
    verification: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();
export type TraceabilityRule = z.infer<typeof traceabilityRuleSchema>;

/** Validated at load, so a corrupted matrix fails loudly rather than silently. */
export const MANIFESTO_TRACEABILITY: readonly TraceabilityRule[] = z
  .array(traceabilityRuleSchema)
  .parse(MANIFESTO_TRACEABILITY_V5);

export function traceabilityRule(id: string): TraceabilityRule | undefined {
  return MANIFESTO_TRACEABILITY.find((r) => r.id === id);
}

/**
 * TR rules with no ARCH rule citing them.
 *
 * The honest coverage number. Reported rather than hidden: 38 manifesto rules
 * exist and the catalog currently implements a fraction of them, and a
 * traceability matrix that only listed what was already covered would show
 * 100% forever.
 */
export function uncoveredTraceabilityRules(
  citedSources: readonly string[],
): readonly TraceabilityRule[] {
  const cited = new Set(citedSources);
  return MANIFESTO_TRACEABILITY.filter((r) => !cited.has(r.id));
}
