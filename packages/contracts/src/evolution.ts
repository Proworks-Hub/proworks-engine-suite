// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";
import { migrationSchema } from "./migration.js";

// ─────────────────────────────────────────────────────────────────────────────
// HOW A SHOP'S IMPROVEMENT BECOMES EVERYBODY'S ENGINE.
//
// One instance discovers that a nesting heuristic is wrong, or that a retry
// policy thrashes, or that a prompt produces better plans. That discovery is
// worth having everywhere. The path from there to a collective release is
// where the whole architecture can quietly invert, in two specific ways:
//
//   THE DATA WAY. The evidence for "this is better" is drawn from one tenant's
//   jobs, customers and prices. A candidate that carried that evidence would
//   make the collective repository a place where one shop's business ends up
//   readable by everyone running the engine.
//
//   THE AUTHORITY WAY. An engine that can propose a change to itself, and
//   whose proposal is accepted automatically because it validated, has been
//   granted the ability to widen its own authority one small commit at a time.
//
// So a candidate is GENERALIZED, and it is a PROPOSAL. Neither of those is a
// promise made in a comment: generalization is enforced by a schema that
// refuses tenant identifiers, and proposing is enforced by there being no
// method here that promotes anything.
//
// AND ONE THING THIS IS NOT
//
// Publishing a release into the collective repository is not deploying it.
// Foundry's promotion wall is unchanged and still admits SIMULATION and
// VALIDATION only. An artifact in the repository is a thing an instance may
// later choose to pin to; nothing here installs anything anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/** How consequential a proposed change is. Drives who must approve it. */
export const changeClassSchema = z.enum([
  /** A fix with no behavioural change. */
  "maintenance",
  /** New behaviour, backward compatible. */
  "minor",
  /** Breaking, or a contract change other engines rely on. */
  "major",
  /** Touches a charter, a Core Protection, or a constitutional boundary. */
  "constitutional",
  /** An engine that did not exist before. */
  "new_engine",
]);
export type ChangeClass = z.infer<typeof changeClassSchema>;

/**
 * Whether a class of change may proceed without a named human.
 *
 * Only `maintenance` and `minor`, and even those go through Governance — this
 * says whether a PERSON is additionally required, not whether policy is.
 *
 * `major` is included on the human side deliberately. A breaking contract
 * change is exactly the kind of thing that validates cleanly and then costs
 * every other engine a release.
 */
export function requiresHumanAuthorization(cls: ChangeClass): boolean {
  return cls === "major" || cls === "constitutional" || cls === "new_engine";
}

/**
 * Evidence that a change is worth making, with the tenant taken out.
 *
 * MEASUREMENTS AND SHAPES, never records. "p95 fell from 900ms to 240ms across
 * 4,100 runs" is the whole of what the collective needs; which customer, which
 * job and which price are what it must not have.
 */
export const generalizedEvidenceSchema = z
  .object({
    /** What was measured. */
    metric: z.string().min(1),
    baseline: z.number(),
    observed: z.number(),
    /** How many runs it rests on. A number, never a list of them. */
    sampleSize: z.number().int().positive(),
    /** How the improvement was established, in words. */
    method: z.string().min(1),
    /**
     * How many DISTINCT instances have seen it.
     *
     * One instance's improvement may be one instance's configuration. This is
     * the field that lets a reviewer tell a general truth from a local one,
     * and it is required for exactly that reason.
     */
    instancesObserved: z.number().int().positive(),
  })
  .strict();
export type GeneralizedEvidence = z.infer<typeof generalizedEvidenceSchema>;

/**
 * Patterns that mean tenant data has leaked into a candidate.
 *
 * A guardrail rather than a boundary, and the difference matters: the real
 * boundary is that evidence carries numbers instead of records. This catches
 * the case where somebody pastes a justification into a free-text field.
 */
const TENANT_MARKERS: readonly RegExp[] = Object.freeze([
  /\btenant[_-]?id\b/i,
  /\borganization[_-]?id\b/i,
  /\bcustomer\b/i,
  /\bwork[_-]?order[_-]?\d+/i,
  // An email address, loosely. Precise enough to catch a pasted one.
  /[\w.+-]+@[\w-]+\.[\w.]+/,
]);

export type SanitizationVerdict =
  | { readonly clean: true }
  | { readonly clean: false; readonly reason: string };

/**
 * Whether a candidate's free text is free of tenant traces.
 *
 * Refuses on a match rather than stripping it. A stripped candidate is one
 * somebody has to trust was stripped correctly, and the reviewer downstream
 * cannot tell a sanitized field from one that never had anything in it.
 */
export function sanitizationOf(text: string): SanitizationVerdict {
  for (const pattern of TENANT_MARKERS) {
    if (pattern.test(text)) {
      return {
        clean: false,
        reason:
          `The text matches ${pattern.source}, which reads as tenant data. A collective candidate carries ` +
          "measurements and shapes, never records — and this is refused rather than stripped, because a " +
          "stripped field is one a reviewer cannot distinguish from one that was always empty.",
      };
    }
  }
  return { clean: true };
}

export const evolutionCandidateSchema = z
  .object({
    candidateId: identifierSchema,
    /** Which engine it proposes to change. */
    engineId: identifierSchema,
    /** What kind of change, as the proposer classifies it. Governance may reclassify. */
    changeClass: changeClassSchema,
    /** Where the idea came from. */
    source: z.enum([
      "engine_self_observation",
      "aria_recommendation",
      "sentinel_finding",
      "foundry_agent",
      "telemetry_pattern",
      "human_proposal",
      "validated_knowledge",
    ]),
    /**
     * Which instance noticed it.
     *
     * The INSTANCE, not the tenant. A candidate needs to be traceable to where
     * it came from so a bad one can be investigated; it does not need to name
     * whose jobs produced the numbers.
     */
    originatingInstanceId: identifierSchema,
    title: z.string().min(1),
    rationale: z.string().min(1),
    evidence: z.array(generalizedEvidenceSchema).min(1),
    /** Contracts this would change. Empty is a claim, and a checkable one. */
    contractsTouched: z.array(z.string().min(1)).default([]),
    /** Engines that would need to move with it. */
    blastRadius: z.array(identifierSchema).default([]),
    /**
     * Whether this would give the engine authority it does not have.
     *
     * Declared by the proposer and checked by Governance. Declaring `true` does
     * not make it permitted — it makes it visible, which is the only thing a
     * self-declaration can honestly do.
     */
    expandsAuthority: z.boolean(),
    migrations: z.array(migrationSchema).default([]),
    proposedAt: z.string().min(1),
  })
  .strict()
  .refine((c) => !c.expandsAuthority || requiresHumanAuthorization(c.changeClass), {
    message:
      "A change that expands an engine's authority cannot be classified as maintenance or minor. Engines may propose; they may not grant themselves new authority, and a self-classification that lowered the bar would be exactly that.",
    path: ["changeClass"],
  })
  .refine((c) => c.contractsTouched.length === 0 || c.changeClass !== "maintenance", {
    message:
      "A change that touches a contract is not maintenance. Other engines rely on contracts, and a contract change that skipped review would cost them a release each.",
    path: ["changeClass"],
  })
  .refine(
    (c) => sanitizationOf(`${c.title} ${c.rationale}`).clean,
    (c) => ({
      message: sanitizationOf(`${c.title} ${c.rationale}`).clean
        ? ""
        : (sanitizationOf(`${c.title} ${c.rationale}`) as { reason: string }).reason,
      path: ["rationale"],
    }),
  );
export type EvolutionCandidate = z.infer<typeof evolutionCandidateSchema>;

/**
 * Whether a validated candidate is thereby approved.
 *
 * Always false. Validation says the change works. Approval says it may ship,
 * and the gap between those is the whole of governance — an engine whose
 * proposals were accepted because they passed their own tests would be
 * widening its own authority one green build at a time.
 */
export function validationImpliesApproval(): false {
  return false;
}

/**
 * Whether publishing a release into the collective repository deploys it.
 *
 * Always false. The repository holds artifacts an instance may later choose to
 * pin to. Foundry's promotion wall is untouched and still admits SIMULATION
 * and VALIDATION only; building a road does not open the gate.
 */
export function publishingIsDeploying(): false {
  return false;
}
