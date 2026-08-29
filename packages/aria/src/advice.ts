// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { traceContextSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ARIA — constitutional intelligence. Advises; never authorizes.
//
// The whole engine turns on one sentence, so it is worth being precise about
// what it means structurally rather than as a promise.
//
// Advice is not a decision that happens to be phrased politely. The difference
// is that a decision CHANGES WHAT MAY HAPPEN and advice changes only what
// somebody knows. So `Advice` below has no `permitted`, no `approved`, no
// `decision` — not because those were left out, but because a type carrying
// one would be a decision with a different name, and the first caller to treat
// it as one would be right to.
//
// WHY ARIA CANNOT BE ASKED "MAY I"
//
// There is no `authorize`, no `permit`, no `allow`. The only question it
// answers is "what do you notice", and the only thing it returns is something
// a human or Governance can read and disregard. An advisory engine that could
// be consulted in the authorization path would become load-bearing the moment
// a caller stopped reading the answers and started branching on them.
//
// WHY IT MUST BE ABLE TO SAY IT DOES NOT KNOW
//
// The rest of this Hive already refuses to let unknown collapse into a
// convenient answer: NOT_ASSESSED for invariants, NOT_RUN for validators, null
// for score dimensions, INCONCLUSIVE for runs, and — as of this week —
// `unknown` for health. An advisor is the component most tempted to fill a
// silence, because producing advice is what it is for. `abstain` is how it
// declines, and abstaining with a reason is a real answer.
// ─────────────────────────────────────────────────────────────────────────────

export const adviceConfidenceSchema = z.enum([
  /** Enough evidence that a reader can act on it. */
  "well-supported",
  /** A pattern worth a look, not a conclusion. */
  "suggestive",
  /** Stated so it is on the record, with the gap named. */
  "speculative",
]);
export type AdviceConfidence = z.infer<typeof adviceConfidenceSchema>;

/**
 * What ARIA looked at.
 *
 * References, never copies. ARIA advising from its own snapshot of a Governance
 * decision would create a second version able to disagree with the first —
 * which is the same objection AuditIQ raises to copying a decision into an
 * audit record.
 */
export const observationRefSchema = z
  .object({
    sourceKind: z.enum([
      "governance_decision",
      "sentinel_finding",
      "foundry_mission",
      "foundry_promotion",
      "audit_record",
      "engine_health",
    ]),
    locator: z.string().min(1),
    observedAt: z.string().min(1),
  })
  .strict();
export type ObservationRef = z.infer<typeof observationRefSchema>;

export const adviceSchema = z
  .object({
    adviceId: z.string().min(1),
    /** What ARIA noticed, in plain language. */
    observation: z.string().min(1),
    /**
     * What it suggests somebody consider.
     *
     * Phrased as a suggestion in the type as well as in the words: there is no
     * `action` field a caller could execute, because advice that arrives as an
     * executable instruction is an instruction.
     */
    suggestion: z.string().min(1),
    confidence: adviceConfidenceSchema,
    /**
     * What ARIA does not know. REQUIRED unless well-supported.
     *
     * Naming the gap is what lets a reader judge the advice instead of
     * inheriting ARIA's confidence in it — the same rule SentinelIQ applies to
     * findings, and for the same reason.
     */
    uncertainty: z.string().min(1).optional(),
    /** At least one. Advice with no observation behind it is an opinion. */
    basedOn: z.array(observationRefSchema).min(1),
    /** Who or what should read this. Never "the system". */
    addressedTo: z.enum(["human", "governance", "sentinel", "foundry"]),
    trace: traceContextSchema.optional(),
    producedAt: z.string().min(1),
  })
  .strict()
  .refine((a) => a.confidence === "well-supported" || Boolean(a.uncertainty), {
    message:
      "Advice that is not well-supported must name what it does not know. Confidence without a stated gap " +
      "asks the reader to inherit ARIA's certainty rather than judge it.",
    path: ["uncertainty"],
  });
export type Advice = z.infer<typeof adviceSchema>;

/** Why ARIA declined to advise. A real answer, not an absence of one. */
export const abstentionSchema = z
  .object({
    abstained: z.literal(true),
    reason: z.string().min(1),
    /** What would have to be true for ARIA to have something to say. */
    wouldNeed: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Abstention = z.infer<typeof abstentionSchema>;

export type AdviceResult =
  | { readonly advised: true; readonly advice: Advice }
  | { readonly advised: false; readonly abstention: Abstention };
