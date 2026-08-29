// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { repairClassSchema } from "../repair/candidate.js";
import { NEGATIVE_OUTCOMES, type RepairCase } from "./experience.js";

// ─────────────────────────────────────────────────────────────────────────────
// The generalization pipeline (directive §§27-28).
//
// "A Repair Experience is not automatically Hive Knowledge."
//
//   Repair Case → Eligibility → Governance → De-identify/Minimize → Abstract
//   → Validate → Propose Generalized Lesson → Knowledge Core
//
// The directive's own example is the whole specification:
//
//   GOOD  "Consumers of at-least-once event delivery must make consequential
//          state transitions idempotent."
//   BAD   "Tenant ABC's order 388 failed on server X at 2:14 AM."
//
// The second is not merely less useful. It is tenant data that has escaped its
// boundary by being reclassified as a lesson, and once it is in the Knowledge
// Core it is readable by everything that reads knowledge. So minimization is
// not a formatting step — it is the containment boundary, and it is enforced
// rather than encouraged.
//
// EACH STAGE CAN REFUSE
//
// The pipeline returns at the first refusal with the stage named. A single
// boolean would make "not eligible" and "Governance said no" indistinguishable,
// and those need completely different responses.
// ─────────────────────────────────────────────────────────────────────────────

export const ruleStatusSchema = z.enum(["PROPOSED", "VALIDATED", "APPROVED", "SUPERSEDED", "REJECTED"]);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

export const generalizedRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),

    failureClass: z.string().min(1),
    repairClass: repairClassSchema,

    /** Kinds of component, not instances. `event-consumer`, not `wo_8f3a`. */
    applicableComponents: z.array(z.string().min(1)).min(1),
    applicableContracts: z.array(z.string().min(1)).default([]),

    /** When this rule applies. A rule with no preconditions applies always. */
    preconditions: z.array(z.string().min(1)).min(1),
    recommendedResponse: z.string().min(1),
    /** What NOT to do. Often the more valuable half. */
    forbiddenResponses: z.array(z.string().min(1)).min(1),

    confidence: z.enum(["suspected", "probable", "confirmed"]),
    /** How many cases support it. One case is an anecdote. */
    evidenceCount: z.number().int().positive(),

    provenance: z
      .object({
        derivedFromCaseIds: z.array(z.string().min(1)).min(1),
        proposedBy: z.string().min(1),
        proposedAt: z.string().min(1),
        governanceReference: z.string().min(1),
      })
      .strict(),

    constitutionVersion: z.string().min(1),
    charterVersions: z.record(z.string(), z.string()).default({}),

    status: ruleStatusSchema,
  })
  .strict()
  .refine((r) => r.confidence !== "confirmed" || r.evidenceCount >= 2, {
    message:
      "A confirmed rule needs at least two supporting cases. One case is an anecdote, and a rule drawn from an anecdote will be applied to situations it never saw.",
    path: ["evidenceCount"],
  });
export type GeneralizedRule = z.infer<typeof generalizedRuleSchema>;

export type GeneralizationStage =
  | "eligibility"
  | "governance"
  | "minimization"
  | "abstraction"
  | "validation";

export type GeneralizationResult =
  | { readonly generalized: true; readonly rule: GeneralizedRule }
  | { readonly generalized: false; readonly stage: GeneralizationStage; readonly reason: string };

/**
 * Patterns that must never appear in a generalized lesson.
 *
 * The containment boundary. Each is something that identifies a tenant, an
 * order, a machine or a moment — the ingredients of "Tenant ABC's order 388
 * failed on server X at 2:14 AM".
 */
const IDENTIFYING_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\btenant[\s_-]?(id)?[\s:=]+["']?[a-z0-9][\w-]*/i, what: "a tenant identifier" },
  { pattern: /\border[\s_-]?(id|number|#)?[\s:=#]+["']?\d+/i, what: "an order identifier" },
  { pattern: /\b(wo|ord|inv|cust)[_-][a-z0-9]{3,}\b/i, what: "a generated entity id" },
  { pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, what: "a timestamp" },
  { pattern: /\b\d{1,2}:\d{2}\s?(am|pm)\b/i, what: "a wall-clock time" },
  { pattern: /\bserver[\s_-]?[a-z0-9]+\b/i, what: "a host name" },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, what: "an IP address" },
  { pattern: /[\w.+-]+@[\w-]+\.[\w.]+/, what: "an email address" },
  { pattern: /\bksix\b/i, what: "a specific organization name" },
];

export interface MinimizationCheck {
  readonly clean: boolean;
  readonly found: readonly string[];
}

/**
 * Whether a lesson still carries identifying material.
 *
 * Runs over the whole rule, not just the description — a tenant id hiding in
 * `applicableComponents` is just as escaped as one in the title.
 */
export function checkMinimization(rule: {
  title: string;
  description: string;
  preconditions: readonly string[];
  recommendedResponse: string;
  forbiddenResponses: readonly string[];
  applicableComponents: readonly string[];
}): MinimizationCheck {
  const text = [
    rule.title,
    rule.description,
    rule.recommendedResponse,
    ...rule.preconditions,
    ...rule.forbiddenResponses,
    ...rule.applicableComponents,
  ].join("\n");

  const found = IDENTIFYING_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.what);
  return { clean: found.length === 0, found };
}

/** What Governance is asked, and what it answers. */
export interface GeneralizationAuthority {
  /**
   * May this case's lesson leave its tenant and become Hive knowledge?
   *
   * §36 puts cross-tenant learning under Governance explicitly. This is a port
   * the host binds; nothing here decides it.
   */
  mayGeneralize(input: {
    caseId: string;
    components: readonly string[];
    crossTenant: boolean;
  }): { permitted: boolean; reason: string; decisionId: string };
}

export interface EligibilityCheck {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * Whether a case is worth generalizing at all.
 *
 * Checked before Governance is bothered, and before anything is abstracted.
 * The bar is deliberately high: a rule extracted from a case nobody validated,
 * or from a diagnosis that turned out to be wrong, will be applied confidently
 * to situations it never saw.
 */
export function checkEligibility(repairCase: RepairCase): EligibilityCheck {
  const reasons: string[] = [];

  if (repairCase.diagnosisConfirmed === false) {
    reasons.push(
      "The diagnosis was later found to be incorrect. A lesson drawn from a wrong diagnosis teaches the wrong thing confidently.",
    );
  }

  if (repairCase.diagnosisConfirmed === null) {
    reasons.push(
      "Nobody has confirmed whether the diagnosis was correct. Unconfirmed is not confirmed.",
    );
  }

  if (repairCase.confidence === "suspected") {
    reasons.push("The case itself is only suspected. A suspicion does not become a rule by being written down.");
  }

  const succeeded = repairCase.repairAttempts.some((a) => a.outcome === "APPLIED_SUCCEEDED");
  const failedInstructively = repairCase.repairAttempts.some((a) =>
    NEGATIVE_OUTCOMES.includes(a.outcome),
  );

  if (!succeeded && !failedInstructively) {
    reasons.push("Neither a proven repair nor an instructive failure. There is nothing here to learn from.");
  }

  if (repairCase.knowledgeStatus === "GENERALIZATION_DENIED") {
    reasons.push("Governance has already refused generalization for this case.");
  }

  if (repairCase.knowledgeStatus === "SUPERSEDED") {
    reasons.push("This case has been superseded by a later one.");
  }

  return { eligible: reasons.length === 0, reasons };
}

export interface GeneralizeInput {
  ruleId: string;
  repairCase: RepairCase;
  /** Supporting cases beyond the primary one. More cases, more confidence. */
  corroboratingCases?: readonly RepairCase[];
  authority: GeneralizationAuthority;
  /**
   * The abstracted lesson.
   *
   * Supplied by the caller, because abstraction is a judgement about what the
   * failure MEANS and this module cannot make it. What this module does is
   * refuse to let a bad abstraction through: minimization, evidence count and
   * shape are all checked below.
   */
  proposed: {
    title: string;
    description: string;
    failureClass: string;
    applicableComponents: readonly string[];
    applicableContracts?: readonly string[];
    preconditions: readonly string[];
    recommendedResponse: string;
    forbiddenResponses: readonly string[];
  };
  proposedBy: string;
  proposedAt: string;
  constitutionVersion: string;
  charterVersions?: Readonly<Record<string, string>>;
}

/**
 * Runs a case through the pipeline.
 *
 * Order is the directive's: eligibility, then Governance, then minimization,
 * then abstraction shape, then validation. Governance sits before minimization
 * deliberately — asking permission to generalize should not require first
 * producing the generalization, or the refusal arrives after the work.
 */
export function generalize(input: GeneralizeInput): GeneralizationResult {
  // ── Eligibility ───────────────────────────────────────────────────────────
  const eligibility = checkEligibility(input.repairCase);
  if (!eligibility.eligible) {
    return { generalized: false, stage: "eligibility", reason: eligibility.reasons.join(" ") };
  }

  // ── Governance ────────────────────────────────────────────────────────────
  const decision = input.authority.mayGeneralize({
    caseId: input.repairCase.caseId,
    components: input.repairCase.applicabilityScope.components,
    crossTenant: input.repairCase.applicabilityScope.crossTenantLearningApproved,
  });

  if (!decision.permitted) {
    return {
      generalized: false,
      stage: "governance",
      reason: `Governance refused generalization: ${decision.reason}`,
    };
  }

  // ── De-identify / minimize ────────────────────────────────────────────────
  const minimization = checkMinimization(input.proposed);
  if (!minimization.clean) {
    return {
      generalized: false,
      stage: "minimization",
      reason:
        `The proposed lesson still contains ${minimization.found.join(", ")}. ` +
        "A lesson carrying identifying material is tenant data reclassified as knowledge, and the Knowledge Core is readable by everything that reads knowledge.",
    };
  }

  // ── Abstraction shape ─────────────────────────────────────────────────────
  //
  // A "lesson" that names one component instance has not been abstracted, it
  // has been reworded. The check is crude but catches the common case: a
  // component list that is just the case's own component ids.
  const caseComponents = new Set(input.repairCase.applicabilityScope.components);
  const allInstanceSpecific = input.proposed.applicableComponents.every((c) => caseComponents.has(c));
  if (allInstanceSpecific && input.proposed.applicableComponents.length > 0) {
    return {
      generalized: false,
      stage: "abstraction",
      reason:
        `The lesson applies only to the exact components the case involved (${input.proposed.applicableComponents.join(", ")}). ` +
        "That is the case restated, not a generalization. Name the KIND of component the rule governs.",
    };
  }

  // ── Validate the rule ─────────────────────────────────────────────────────
  const supportingCases = [input.repairCase, ...(input.corroboratingCases ?? [])];
  const evidenceCount = supportingCases.length;
  const confidence: GeneralizedRule["confidence"] =
    evidenceCount >= 3 ? "confirmed" : evidenceCount === 2 ? "probable" : "suspected";

  const parsed = generalizedRuleSchema.safeParse({
    ruleId: input.ruleId,
    title: input.proposed.title,
    description: input.proposed.description,
    failureClass: input.proposed.failureClass,
    repairClass: input.repairCase.repairClass,
    applicableComponents: input.proposed.applicableComponents,
    applicableContracts: input.proposed.applicableContracts ?? [],
    preconditions: input.proposed.preconditions,
    recommendedResponse: input.proposed.recommendedResponse,
    forbiddenResponses: input.proposed.forbiddenResponses,
    confidence,
    evidenceCount,
    provenance: {
      derivedFromCaseIds: supportingCases.map((c) => c.caseId),
      proposedBy: input.proposedBy,
      proposedAt: input.proposedAt,
      governanceReference: decision.decisionId,
    },
    constitutionVersion: input.constitutionVersion,
    charterVersions: input.charterVersions ?? {},
    // PROPOSED, never APPROVED. Generalization produces a proposal; approval is
    // a separate act by somebody else. A pipeline that emitted APPROVED rules
    // would be approving its own output.
    status: "PROPOSED",
  });

  if (!parsed.success) {
    return {
      generalized: false,
      stage: "validation",
      reason: `The proposed rule is malformed: ${JSON.stringify(parsed.error.flatten())}`,
    };
  }

  return { generalized: true, rule: parsed.data };
}
