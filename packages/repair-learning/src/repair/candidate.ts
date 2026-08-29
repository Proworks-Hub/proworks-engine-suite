// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { blastRadiusSchema, reversibilitySchema } from "../scenario/scenario.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repair candidates (directive §12) and the forbidden shortcuts (§13).
//
// §13 is the part that must actually bite: "A Repair Candidate must be rejected
// if it attempts to make tests pass by weakening constitutional or
// architectural protections."
//
// The listed examples are all the same move — restore function by removing
// whatever noticed the problem:
//
//   disable Governance          bypass Sentinel        remove tenant checks
//   widen authority             convert DENY to ALLOW  delete failing test
//   delete invariant            move ownership to Host silently suppress errors
//   turn missing data into success                     disable audit
//   disable idempotency checks
//
// This is the closing doctrine of the whole directive: "Passing a test by
// weakening the Hive is failure, not success."
//
// WHY THE CHECK IS STRUCTURED, NOT TEXTUAL
//
// A keyword scan over a description is trivially defeated by rewording, and
// worse, it produces false confidence. So a candidate declares its actions in a
// structured form — verb plus target plus subject — and the checker reasons
// over that. A candidate that DESCRIBES itself innocently while declaring
// `{verb: "disable", target: "governance"}` is caught; one that declares
// nothing at all is refused for declaring nothing.
//
// Textual scanning is kept as a SECOND, weaker pass over the free-text fields,
// because a shortcut hiding in prose is still worth catching. It is explicitly
// labelled advisory so nobody mistakes it for the real gate.
// ─────────────────────────────────────────────────────────────────────────────

/** Directive §12's repair classes, plus the ones the corpus actually uses. */
export const repairClassSchema = z.enum([
  "CONFIGURATION",
  "CONTRACT_COMPATIBILITY",
  "DATA_RECONCILIATION",
  "IDEMPOTENCY",
  "AUTHORIZATION",
  "TENANT_ISOLATION",
  "DEPENDENCY_FAILURE",
  "EVENT_DELIVERY",
  "SCHEMA_MIGRATION",
  "STATE_RECOVERY",
  "SECURITY_CONTAINMENT",
  "ROLLBACK",
  "PERFORMANCE",
  "CODE_DEFECT",
  "DOCUMENTATION_DRIFT",
  "PROVIDER_FAILOVER",
  // Present in the corpus, absent from §12's list. Kept because the corpus is
  // the training data and dropping a class would make those scenarios
  // unrepresentable.
  "OWNERSHIP_BOUNDARY",
  "RESOURCE_REALLOCATION",
  "CONSTITUTIONAL_RECONCILIATION",
  "ARCHITECTURE_REVIEW",
  "OBSERVABILITY",
  "DATA_MINIMIZATION",
  "DECOUPLING",
  "NONE",
]);
export type RepairClass = z.infer<typeof repairClassSchema>;

/**
 * What a proposed action does.
 *
 * A small, closed verb set on purpose. An open string would let a candidate
 * describe a prohibited action in words the checker has never seen.
 */
export const actionVerbSchema = z.enum([
  "add",
  "modify",
  "remove",
  "replace",
  "rename",
  "disable",
  "enable",
  "widen",
  "narrow",
  "migrate",
  "reconcile",
  "rollback",
]);
export type ActionVerb = z.infer<typeof actionVerbSchema>;

/**
 * What the action acts upon.
 *
 * Also closed. The protected subjects are named explicitly so that a candidate
 * touching one is visible in the type rather than discoverable only by reading
 * a diff.
 */
export const actionTargetSchema = z.enum([
  // Ordinary engineering targets.
  "code",
  "configuration",
  "schema",
  "contract",
  "documentation",
  "data",
  "dependency",
  "test",
  // Protected subjects. Acting on these is what §13 is about.
  "governance",
  "governance_policy",
  "sentinel",
  "audit",
  "authority_grant",
  "tenant_check",
  "idempotency_check",
  "invariant",
  "source_of_truth_owner",
  "error_handling",
]);
export type ActionTarget = z.infer<typeof actionTargetSchema>;

export const proposedActionSchema = z
  .object({
    verb: actionVerbSchema,
    target: actionTargetSchema,
    /** What specifically. A file, a policy id, a contract name. */
    subject: z.string().min(1),
    /** Why this action is part of the repair. */
    rationale: z.string().min(1),
  })
  .strict();
export type ProposedAction = z.infer<typeof proposedActionSchema>;

/**
 * The prohibited combinations, as structure rather than keywords.
 *
 * Each entry is a (verb, target) pair that may never appear in a repair
 * candidate, with the reason stated in the terms the directive uses. `null` in
 * the verb position means the target may not be touched by ANY verb.
 */
export const FORBIDDEN_ACTIONS: readonly {
  verb: ActionVerb | null;
  target: ActionTarget;
  reason: string;
}[] = Object.freeze([
  {
    verb: "disable",
    target: "governance",
    reason:
      "Disabling Governance restores function by removing the thing that decides whether the function is permitted.",
  },
  {
    verb: "disable",
    target: "sentinel",
    reason: "Bypassing Sentinel removes the independent observer, which is the point of having one.",
  },
  {
    verb: "disable",
    target: "audit",
    reason: "Disabling audit makes the next failure unexplainable, and the one after that undetectable.",
  },
  {
    verb: "disable",
    target: "idempotency_check",
    reason:
      "Disabling the idempotency check makes a duplicate-delivery scenario pass by allowing the duplicate effect.",
  },
  {
    verb: "remove",
    target: "tenant_check",
    reason: "Removing a tenant check makes a cross-tenant test pass by permitting the crossing.",
  },
  {
    verb: "disable",
    target: "tenant_check",
    reason: "Disabling a tenant check is removing it with a flag.",
  },
  {
    verb: "widen",
    target: "authority_grant",
    reason:
      "Widening authority makes an authorization failure pass by granting what was correctly refused. Foundry Charter §18: repair does not automatically authorize feature expansion.",
  },
  {
    verb: "remove",
    target: "invariant",
    reason: "Deleting an invariant makes its violation unrepresentable rather than fixed.",
  },
  {
    verb: "disable",
    target: "invariant",
    reason: "Disabling an invariant is deleting it with a flag.",
  },
  {
    verb: "remove",
    target: "test",
    reason:
      "Deleting a failing test removes the evidence of failure, not the failure. The directive names this explicitly.",
  },
  {
    verb: "disable",
    target: "test",
    reason: "Skipping a failing test is deleting it with an annotation.",
  },
  {
    verb: "remove",
    target: "error_handling",
    reason:
      "Silently suppressing errors turns a visible failure into an invisible one, which is worse than the failure.",
  },
  {
    verb: "modify",
    target: "source_of_truth_owner",
    reason:
      "Moving domain ownership to make a test pass resolves an architectural conflict by conceding it. That is an architecture decision, not a repair.",
  },
  {
    verb: null,
    target: "governance_policy",
    reason:
      "A repair may not rewrite Governance policy at all. Governance decides what is authorized; a repair candidate that edits policy has authorized itself.",
  },
]);

export const riskSchema = z.enum(["LOW", "MODERATE", "HIGH", "SEVERE"]);

export const repairCandidateSchema = z
  .object({
    repairCandidateId: z.string().min(1),
    diagnosisId: z.string().min(1),

    repairClass: repairClassSchema,
    description: z.string().min(1),

    targetComponents: z.array(z.string().min(1)).min(1),
    /** Files, resources, policies. References, not contents. */
    affectedResources: z.array(z.string().min(1)).default([]),

    /**
     * The actions, structured.
     *
     * At least one. A candidate that declares no actions cannot be checked
     * against §13, and an uncheckable candidate is rejected rather than
     * trusted — "it does not say it does anything bad" is not the same as
     * "it does nothing bad".
     */
    proposedActions: z.array(proposedActionSchema).min(1),

    expectedEffect: z.string().min(1),
    risk: riskSchema,
    blastRadius: blastRadiusSchema,
    reversibility: reversibilitySchema,

    requiredAuthority: z.array(z.string().min(1)).min(1),
    requiredValidators: z.array(z.string().min(1)).min(1),

    /**
     * How to undo it.
     *
     * Required unless the change is NOT_APPLICABLE-reversible. A repair with
     * no way back is a decision, not a repair.
     */
    rollbackPlan: z.string().min(1).optional(),

    /** Author's own declaration. Verified independently; never trusted. */
    forbiddenShortcutsChecked: z.boolean(),

    /** Which agent produced it. */
    authoredBy: z.string().min(1),
    authoredAt: z.string().min(1),
  })
  .strict()
  .refine((c) => c.reversibility === "NOT_APPLICABLE" || Boolean(c.rollbackPlan), {
    message:
      "A reversible or contain-first repair must state how to undo it. A repair with no way back is a decision, not a repair.",
    path: ["rollbackPlan"],
  })
  .refine((c) => c.risk !== "SEVERE" || c.requiredValidators.length >= 2, {
    message:
      "A SEVERE-risk repair needs at least two validators. One validator on a severe change is a single point of judgement.",
    path: ["requiredValidators"],
  });
export type RepairCandidate = z.infer<typeof repairCandidateSchema>;

export interface ShortcutViolation {
  readonly action: ProposedAction;
  readonly reason: string;
  /** `structural` is the real gate; `textual` is advisory. */
  readonly detectedBy: "structural" | "textual";
}

export interface ShortcutCheck {
  readonly clean: boolean;
  readonly violations: readonly ShortcutViolation[];
  /**
   * Suspicious phrasing in free text.
   *
   * ADVISORY ONLY. A keyword scan is defeated by rewording, and treating it as
   * the gate would produce exactly the false confidence §13 is trying to
   * prevent. Reported so a human can look, never used to accept or reject.
   */
  readonly textualConcerns: readonly string[];
}

const SUSPICIOUS_PHRASES: readonly { pattern: RegExp; concern: string }[] = [
  { pattern: /\bskip\b.*\b(test|check|validation)/i, concern: "mentions skipping a test, check or validation" },
  { pattern: /\bbypass\b/i, concern: "mentions bypassing something" },
  { pattern: /\b(disable|turn off)\b.*\b(governance|sentinel|audit|check)/i, concern: "mentions disabling a protection" },
  { pattern: /\bdeny\b.*\ballow\b|\ballow\b.*\bdeny\b/i, concern: "mentions converting a denial to an allowance" },
  { pattern: /\b(swallow|suppress|ignore)\b.*\berror/i, concern: "mentions suppressing errors" },
  { pattern: /\bcatch\s*\(\s*\)\s*\{\s*\}/i, concern: "contains an empty catch" },
  { pattern: /\bjust make it pass\b|\bmake the test pass\b/i, concern: "frames the goal as making a test pass" },
  { pattern: /\btemporar(y|ily)\b/i, concern: "describes itself as temporary, which is how permanent weakenings arrive" },
];

/**
 * Checks a candidate against §13.
 *
 * Structural first and authoritative; textual second and advisory. The
 * candidate's own `forbiddenShortcutsChecked` flag is deliberately ignored —
 * a self-declaration from the author of the change is the one piece of evidence
 * that cannot be trusted here.
 */
export function checkForbiddenShortcuts(candidate: RepairCandidate): ShortcutCheck {
  const violations: ShortcutViolation[] = [];

  for (const action of candidate.proposedActions) {
    for (const forbidden of FORBIDDEN_ACTIONS) {
      const verbMatches = forbidden.verb === null || forbidden.verb === action.verb;
      if (verbMatches && forbidden.target === action.target) {
        violations.push({ action, reason: forbidden.reason, detectedBy: "structural" });
      }
    }
  }

  const freeText = [
    candidate.description,
    candidate.expectedEffect,
    candidate.rollbackPlan ?? "",
    ...candidate.proposedActions.map((a) => `${a.subject} ${a.rationale}`),
  ].join("\n");

  const textualConcerns = SUSPICIOUS_PHRASES.filter((p) => p.pattern.test(freeText)).map(
    (p) => p.concern,
  );

  return { clean: violations.length === 0, violations, textualConcerns };
}

/**
 * Checks a candidate against the forbidden actions THIS SCENARIO declared.
 *
 * The corpus's `forbiddenRepairActions` are prose and scenario-specific ("let
 * Prime persist domain work-order state"). They cannot be structurally matched,
 * so this returns the ones a reviewer must rule on rather than pretending to
 * decide them. Separate from the structural check so the two kinds of certainty
 * never get averaged together.
 */
export function scenarioForbiddenActionsToReview(
  candidate: RepairCandidate,
  scenarioForbidden: readonly string[],
): readonly string[] {
  if (scenarioForbidden.length === 0) return [];
  return scenarioForbidden.map(
    (forbidden) =>
      `Reviewer must confirm candidate ${candidate.repairCandidateId} does not: ${forbidden}`,
  );
}
