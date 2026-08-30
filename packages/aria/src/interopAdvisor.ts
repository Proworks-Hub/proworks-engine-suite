// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * File:    packages/aria/src/interopAdvisor.ts
 * Module:  aria
 * Purpose: Explaining connections, and being structurally unable to permit one.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE DISTINCTION ARIA EXISTS TO KEEP: POSSIBLE vs AUTHORIZED
//
// The addendum's evaluation list ends with "explicit distinction between
// 'possible' and 'authorized'", and that is the whole job. Every other item —
// hallucinated protocol features, wrong versions, unsafe mappings — is a
// competence problem that better models improve. This one is a design problem
// that better models make WORSE, because a more fluent advisor is more
// convincing when it says a thing can be done, and "can" is one short step
// from "may" in the mind of a developer under deadline.
//
// So every output of this module is an ADVICE record whose type carries
// `isAuthorization: false`, states what it is unsure about, and names who
// actually decides. There is no `approve`, `permit`, `activate`, `install` or
// `grant` on this surface, and a test asserts their absence rather than
// trusting that nobody adds one.
//
// UNCERTAINTY IS PART OF THE OUTPUT, NOT A CAVEAT ON IT
//
// A draft mapping that does not say which fields it guessed at is worse than
// no draft, because it launders a guess into a document that looks reviewed.
// `uncertainties` is required and non-empty for anything drafted by a model,
// enforced by the schema.
// ─────────────────────────────────────────────────────────────────────────────

export const interopAdviceKindSchema = z.enum([
  /** Natural language turned into a draft CommunicationIntent. */
  "DRAFT_INTENT",
  /** What a contract is missing before it can be used. */
  "MISSING_REQUIREMENTS",
  /** Why two schemas or two versions cannot talk. */
  "EXPLAIN_INCOMPATIBILITY",
  /** Why a route or pattern was refused. */
  "EXPLAIN_REJECTION",
  /** Alternatives among things ALREADY permitted. */
  "SUGGEST_ALTERNATIVE",
  /** A drafted MappingContract, with its doubts attached. */
  "DRAFT_MAPPING",
  /** Synthetic scenarios and counterexamples for testing. */
  "GENERATE_SCENARIOS",
  /** Client or adapter scaffolding from an approved contract. */
  "SCAFFOLD_FROM_CONTRACT",
  /** Public-standard research with source provenance. */
  "RESEARCH_SUMMARY",
]);
export type InteropAdviceKind = z.infer<typeof interopAdviceKindSchema>;

export const sourceCitationSchema = z
  .object({
    /** Where the claim came from. */
    url: z.string().min(1),
    title: z.string().min(1),
    /** When the source was read; standards move and advice goes stale. */
    retrievedAt: z.string().min(1),
    /**
     * True when this was actually retrieved rather than recalled.
     *
     * A model's memory of a specification is not a citation of it. Marking
     * recalled claims explicitly is the difference between research and
     * confident paraphrase, and it is the single most useful field here.
     */
    retrieved: z.boolean(),
  })
  .strict();
export type SourceCitation = z.infer<typeof sourceCitationSchema>;

export const interopAdviceSchema = z
  .object({
    adviceId: z.string().min(1),
    kind: interopAdviceKindSchema,
    subject: z.string().min(1),
    /** The advice itself, for a person to read. */
    body: z.string().min(1),

    /**
     * Always false, and typed as the literal.
     *
     * Not a boolean somebody could set. If ARIA's output could ever carry
     * `isAuthorization: true`, every consumer would eventually branch on it.
     */
    isAuthorization: z.literal(false),

    /** Who actually decides this. Required — advice must name its decider. */
    decidedBy: z.enum(["GOVERNANCE", "SECURITY_IQ", "SENTINEL", "HOST_DEVELOPER", "FOUNDRY", "NOBODY_YET"]),

    /** What the advisor is unsure about. Required for model-authored advice. */
    uncertainties: z.array(z.string().min(1)).max(20),

    /** Sources, with retrieval honesty. */
    citations: z.array(sourceCitationSchema).max(20),

    /** Whether a model produced this, and which. */
    modelProvenance: z
      .object({ producedByModel: z.boolean(), modelId: z.string().min(1).nullable() })
      .strict(),

    createdAt: z.string().min(1),
  })
  .strict()
  .refine((a) => !a.modelProvenance.producedByModel || a.uncertainties.length > 0, {
    message:
      "Model-authored advice must state what it is unsure about. A draft that hides its guesses launders them into something that looks reviewed, and the reader has no way to tell which parts to check.",
    path: ["uncertainties"],
  })
  .refine((a) => a.modelProvenance.producedByModel === (a.modelProvenance.modelId !== null), {
    message: "Model-produced advice must name the model, and advice no model produced must not name one.",
    path: ["modelProvenance", "modelId"],
  })
  .refine((a) => a.kind !== "RESEARCH_SUMMARY" || a.citations.length > 0, {
    message:
      "A research summary with no citations is a recollection. Research is only useful here if a reviewer can go and read the same thing.",
    path: ["citations"],
  });
export type InteropAdvice = z.infer<typeof interopAdviceSchema>;

/**
 * Explains why a communication path was refused.
 *
 * Takes the planner's own rejection list rather than re-deriving anything.
 * An advisor that computed its own opinion of why a route failed would drift
 * from the router within a release, and would then confidently explain a
 * refusal that never happened.
 */
export function explainRejections(input: {
  readonly adviceId: string;
  readonly subject: string;
  readonly rejections: readonly { readonly patternId: string; readonly reason: string; readonly remedy: string | null }[];
  readonly createdAt: string;
}): InteropAdvice {
  const withRemedies = input.rejections.filter((r) => r.remedy !== null);
  const structural = input.rejections.filter((r) => r.remedy === null);

  const body = [
    `${input.rejections.length} pattern(s) were refused for this conversation.`,
    "",
    ...withRemedies.map((r) => `• ${r.patternId}: ${r.reason}\n  What would change it: ${r.remedy}`),
    ...(structural.length > 0
      ? ["", "Refused with no available remedy (the mechanism simply does not fit):", ...structural.map((r) => `• ${r.patternId}: ${r.reason}`)]
      : []),
    "",
    "This explains what the planner decided and why. It does not permit anything: whether this conversation may happen at all is a Governance question, and a route existing has never meant a route is allowed.",
  ].join("\n");

  return {
    adviceId: input.adviceId,
    kind: "EXPLAIN_REJECTION",
    subject: input.subject,
    body,
    isAuthorization: false,
    decidedBy: "HOST_DEVELOPER",
    uncertainties: [],
    citations: [],
    modelProvenance: { producedByModel: false, modelId: null },
    createdAt: input.createdAt,
  };
}

/**
 * Suggests alternatives from a list of ALREADY-permitted options.
 *
 * The `permitted` argument is not a convenience — it is the mechanism. ARIA
 * cannot suggest something outside it, because it is only ever handed what is
 * already allowed. An advisor that could name an unpermitted option would be
 * generating demand for a permission, which is how "ARIA said we could" ends
 * up in a post-incident review.
 */
export function suggestAlternatives(input: {
  readonly adviceId: string;
  readonly subject: string;
  readonly permitted: readonly { readonly optionId: string; readonly tradeoff: string }[];
  readonly createdAt: string;
}): InteropAdvice {
  const body =
    input.permitted.length === 0
      ? "There are no already-permitted alternatives to suggest. Anything else would need a Governance decision first, and asking for one is a different conversation from choosing between options."
      : [
          "Alternatives that are already permitted for this path:",
          "",
          ...input.permitted.map((p) => `• ${p.optionId} — ${p.tradeoff}`),
          "",
          "Every option listed is one the topology and policy already allow. Options that would need new permission are deliberately not listed here.",
        ].join("\n");

  return {
    adviceId: input.adviceId,
    kind: "SUGGEST_ALTERNATIVE",
    subject: input.subject,
    body,
    isAuthorization: false,
    decidedBy: "HOST_DEVELOPER",
    uncertainties: [],
    citations: [],
    modelProvenance: { producedByModel: false, modelId: null },
    createdAt: input.createdAt,
  };
}

/** Advice ARIA may never produce, checked by name at the boundary. */
export const FORBIDDEN_ADVISOR_VERBS: readonly string[] = Object.freeze([
  "approve",
  "authorize",
  "permit",
  "grant",
  "activate",
  "install",
  "deploy",
  "admit",
  "revoke",
  "escalate",
]);

/**
 * Whether a proposed advisory action is one ARIA may perform.
 *
 * Exists because the natural way to extend an advisor is to let it "just do
 * the obvious next step", and the obvious next step is almost always one of
 * the forbidden verbs. This makes the refusal a function call with a reason
 * rather than a code-review conversation that may not happen.
 */
export function mayPerform(action: string): { readonly permitted: boolean; readonly reason: string } {
  const normalized = action.trim().toLowerCase();
  const hit = FORBIDDEN_ADVISOR_VERBS.find((verb) => normalized.startsWith(verb) || normalized.includes(` ${verb}`));
  if (hit !== undefined) {
    return {
      permitted: false,
      reason: `"${action}" is a decision, not advice — ${hit} belongs to Governance, Security IQ or a human operator. ARIA can explain what would be involved and what the tradeoffs are; the moment it could take the step, its confidence would become a permission.`,
    };
  }
  return { permitted: true, reason: `"${action}" produces advice somebody is free to disregard.` };
}

/** Model confidence is not permission, however high it gets. */
export function modelConfidenceGrantsPermission(): false {
  return false;
}

/** ARIA can reach nothing on its own initiative. */
export function advisorMayActOnItsOwnAdvice(): false {
  return false;
}
