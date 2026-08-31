// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Architecture rules, and what evaluating one produces.
//
// These mirror `architecture_rule.schema.json` and
// `conformance_finding.schema.json` from the Manifesto Implementation Build
// Package V1, field for field. They live here rather than in the Architecture
// Engine because a subject must be able to describe its own conformance
// without importing the thing that judges it — see ARCH-DEP-ENGINE-ISOLATION.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much authority a rule carries.
 *
 * The three-way split is load-bearing. Only deterministic, reproducible rules
 * may block a build automatically; a subjective judgement that breaks CI
 * teaches people to bypass CI. And a GOVERNED_GATE is not something the
 * Architecture Engine may enforce on its own — it reports, and Governance
 * decides, which is what stops conformance from becoming a second authority.
 */
export const ruleSeveritySchema = z.enum([
  /** Reported, never blocks. Judgement, style, or a rule still earning trust. */
  "ADVISORY",
  /** Deterministic and reproducible. May block a build on its own. */
  "ENGINEERING_GATE",
  /** Consequential enough that Governance, not CI, decides. */
  "GOVERNED_GATE",
]);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

/**
 * One architecture rule with a stable identity.
 *
 * `id` is `ARCH-*` and permanent. Findings reference it, waivers reference it,
 * and history stays readable only if the id outlives every rewording of the
 * rule text. Renaming a rule orphans every finding ever filed against it.
 */
export const architectureRuleSchema = z
  .object({
    id: z.string().regex(/^ARCH-[A-Z0-9.-]+$/, "rule id looks like ARCH-DEP-NO-CONTROL-CENTER"),
    /** Where the rule comes from — a TR-* traceability id, a §, or an ADR. */
    source: z.string().min(1),
    rule: z.string().min(1),
    severity: ruleSeveritySchema,
    owner: z.array(z.string().min(1)).min(1),
    /** How it is checked. Prose here, code elsewhere; this is the claim. */
    verification: z.array(z.string().min(1)).min(1),
    evidence: z.array(z.string().min(1)).min(1),
    remediation: z.string().min(1).optional(),
    /**
     * The policy under which Governance blocks. Null for rules Governance does
     * not gate — which is most of them, and saying so beats leaving it absent.
     */
    blockingPolicyId: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.severity === "GOVERNED_GATE" && r.blockingPolicyId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockingPolicyId"],
        message:
          "a GOVERNED_GATE must name the policy Governance blocks under; otherwise it is a gate nobody owns",
      });
    }
  });
export type ArchitectureRule = z.infer<typeof architectureRuleSchema>;

/**
 * The outcome of evaluating one rule against one subject.
 *
 * Five values, and the two that are not PASS/FAIL carry the weight:
 *
 *   UNKNOWN         The rule applies and could not be evaluated. This is a
 *                   FAILURE OF THE EVALUATOR, not a pass. Collapsing it into
 *                   PASS is how a conformance report certifies a component
 *                   nobody actually checked.
 *   NOT_APPLICABLE  The rule genuinely does not apply. Different from UNKNOWN
 *                   in the only way that matters: somebody established it.
 */
export const conformanceStatusSchema = z.enum([
  "PASS",
  "WARN",
  "FAIL",
  "UNKNOWN",
  "NOT_APPLICABLE",
]);
export type ConformanceStatus = z.infer<typeof conformanceStatusSchema>;

export const conformanceFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    subjectId: z.string().min(1),
    subjectVersion: z.string().min(1).optional(),
    status: conformanceStatusSchema,
    severity: ruleSeveritySchema.optional(),
    observedAt: z.string().min(1),
    evidenceRefs: z.array(z.string()).default([]),
    /** What was actually observed. The facts a reader needs to disagree. */
    facts: z.array(z.string()).default([]),
    expected: z.string().min(1).optional(),
    remediation: z.array(z.string()).default([]),
    /** An ADR that knowingly accepts this failure. Never a silent suppression. */
    waiverAdrId: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((f, ctx) => {
    // A failure nobody can act on is noise, and noise trains people to skip
    // the report. Facts are what make a finding arguable rather than merely
    // asserted.
    if ((f.status === "FAIL" || f.status === "WARN") && f.facts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `a ${f.status} finding must state the facts observed`,
      });
    }
    // The distinction NOT_APPLICABLE earns over UNKNOWN is that somebody
    // decided. Without a reason it is UNKNOWN wearing a better label, and it
    // would silently shrink the denominator of every conformance summary.
    if (f.status === "NOT_APPLICABLE" && f.facts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: "NOT_APPLICABLE must say why the rule does not apply, or it is UNKNOWN",
      });
    }
  });
export type ConformanceFinding = z.infer<typeof conformanceFindingSchema>;

/**
 * Whether a set of findings may block a build.
 *
 * Only `ENGINEERING_GATE` failures block. ADVISORY never blocks by
 * construction, and GOVERNED_GATE is Governance's call rather than CI's —
 * returning true for it here would be the Architecture Engine enforcing
 * constitutional authority it does not hold.
 *
 * A finding with a waiver does not block: the failure is still reported, still
 * visible, and knowingly accepted by a named ADR. That is the difference
 * between an exception and a suppression.
 */
export function blocksBuild(findings: readonly ConformanceFinding[]): boolean {
  return findings.some(
    (f) => f.status === "FAIL" && f.severity === "ENGINEERING_GATE" && f.waiverAdrId === null,
  );
}

/**
 * Counts by status, with UNKNOWN kept separate from everything else.
 *
 * Deliberately not reduced to a percentage. "94% conformant" hides whether the
 * remaining 6% was checked and failed or was never checked at all, and those
 * are different problems with different owners.
 */
export function summarize(
  findings: readonly ConformanceFinding[],
): Readonly<Record<ConformanceStatus, number>> {
  const out: Record<ConformanceStatus, number> = {
    PASS: 0,
    WARN: 0,
    FAIL: 0,
    UNKNOWN: 0,
    NOT_APPLICABLE: 0,
  };
  for (const f of findings) out[f.status] += 1;
  return out;
}
