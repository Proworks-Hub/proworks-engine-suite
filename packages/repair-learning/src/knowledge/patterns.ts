// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { repairClassSchema } from "../repair/candidate.js";
import type { FailureSignature } from "../evidence/signature.js";
import type { ExperienceStore, RepairCase, SimilarCase } from "./experience.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Repair Pattern Library (§29) and the reuse loop (§§30-31).
//
// §29: "Patterns are templates, not unrestricted auto-fixes."
//
// So a pattern carries `preconditions` that must hold and `doesNotApplyWhen`
// conditions that disqualify it — and applying one produces a CANDIDATE, which
// still goes through Phase D like any other. A pattern that could be applied
// without validation would be an auto-fix with a nicer name.
//
// §31: "A repair valid for EventIQ 1.2 may be unsafe for EventIQ 3.0... Do not
// blindly reuse historical repairs."
//
// The version gate below is the enforcement. It refuses on a major-version
// difference rather than warning, because the whole point of recording
// compatibility is that somebody will otherwise reuse a repair across it.
// ─────────────────────────────────────────────────────────────────────────────

export const patternFamilySchema = z.enum([
  "RETRY_WITH_BACKOFF",
  "IDEMPOTENT_CONSUMER_REPAIR",
  "DEPENDENCY_FAILOVER",
  "SCHEMA_COMPATIBILITY_ADAPTER",
  "STATE_RECONCILIATION",
  "ROLLBACK",
  "CONFIGURATION_DRIFT_CORRECTION",
  "CREDENTIAL_ROTATION",
  "QUEUE_RECOVERY",
  "DEAD_LETTER_RECOVERY",
  "DATA_REPAIR",
  "CACHE_REBUILD",
  "PROJECTION_REBUILD",
  "PROVIDER_FAILOVER",
  "TENANT_BOUNDARY_REPAIR",
  "CONTRACT_MIGRATION",
]);
export type PatternFamily = z.infer<typeof patternFamilySchema>;

export const repairPatternSchema = z
  .object({
    patternId: z.string().min(1),
    family: patternFamilySchema,
    title: z.string().min(1),
    description: z.string().min(1),
    repairClass: repairClassSchema,

    /** All must hold. A pattern with no preconditions applies everywhere. */
    preconditions: z.array(z.string().min(1)).min(1),
    /**
     * Conditions that disqualify it.
     *
     * Required and non-empty. Every real pattern has a situation where it is
     * the wrong answer, and a pattern that claims none has not been thought
     * about — retry-with-backoff against a non-idempotent consumer being the
     * classic example of a good pattern applied where it does harm.
     */
    doesNotApplyWhen: z.array(z.string().min(1)).min(1),

    /** The template. Shapes a candidate; is not itself one. */
    templateActions: z
      .array(
        z
          .object({
            verb: z.string().min(1),
            target: z.string().min(1),
            guidance: z.string().min(1),
          })
          .strict(),
      )
      .min(1),

    /** Versions this pattern is known to be safe for. §31. */
    knownSafeFor: z.record(z.string(), z.string()).default({}),
    /** Versions it is known to be unsafe for. */
    knownUnsafeFor: z.record(z.string(), z.string()).default({}),

    derivedFromRuleIds: z.array(z.string().min(1)).default([]),
    status: z.enum(["PROPOSED", "VALIDATED", "APPROVED", "DEPRECATED"]),
  })
  .strict();
export type RepairPattern = z.infer<typeof repairPatternSchema>;

export type VersionCompatibility =
  | { readonly compatible: true; readonly checked: readonly string[] }
  | { readonly compatible: false; readonly reason: string };

/** The major part of a version string, or null when it has none. */
function majorOf(version: string): string | null {
  const match = /^(\d+)/.exec(version.trim());
  return match ? match[1]! : null;
}

/**
 * Whether historical repair knowledge may be reused at these versions.
 *
 * §31, enforced. Three outcomes and all three matter:
 *
 *   refuse   a known-unsafe version, or a major-version difference
 *   refuse   a component with no recorded version at all — an unrecorded
 *            version is not a matching one, and "we do not know what version
 *            this was validated against" is the situation the rule exists for
 *   allow    same major version, or explicitly known-safe
 *
 * Minor differences pass. That is a judgement, and it is the one that makes the
 * gate usable rather than a blanket refusal — but a major difference is exactly
 * the EventIQ 1.2 versus 3.0 case the directive names.
 */
export function versionsCompatibleForReuse(input: {
  knownSafeFor: Readonly<Record<string, string>>;
  knownUnsafeFor?: Readonly<Record<string, string>>;
  currentVersions: Readonly<Record<string, string>>;
}): VersionCompatibility {
  const checked: string[] = [];

  for (const [component, unsafeVersion] of Object.entries(input.knownUnsafeFor ?? {})) {
    const current = input.currentVersions[component];
    if (current !== undefined && majorOf(current) === majorOf(unsafeVersion)) {
      return {
        compatible: false,
        reason: `This knowledge is recorded as UNSAFE for ${component} ${unsafeVersion}, and the current version is ${current}.`,
      };
    }
  }

  for (const [component, safeVersion] of Object.entries(input.knownSafeFor)) {
    const current = input.currentVersions[component];

    if (current === undefined) {
      return {
        compatible: false,
        reason:
          `No current version recorded for ${component}, which this knowledge was validated against at ${safeVersion}. ` +
          "An unrecorded version is not a matching one — this is precisely the case §31 exists for.",
      };
    }

    const safeMajor = majorOf(safeVersion);
    const currentMajor = majorOf(current);

    if (safeMajor === null || currentMajor === null) {
      return {
        compatible: false,
        reason: `Cannot compare ${component} versions "${safeVersion}" and "${current}". An uncomparable version is not a compatible one.`,
      };
    }

    if (safeMajor !== currentMajor) {
      return {
        compatible: false,
        reason:
          `This knowledge was validated against ${component} ${safeVersion} and the current version is ${current}. ` +
          "A repair valid for one major version may be unsafe for another (directive §31), so it is not reused across the boundary.",
      };
    }

    checked.push(`${component} ${current} ~ ${safeVersion}`);
  }

  return { compatible: true, checked };
}

export interface PatternLibrary {
  add(input: unknown): { added: true; pattern: RepairPattern } | { added: false; reason: string };
  /**
   * Patterns whose preconditions the caller says hold.
   *
   * Preconditions are prose and cannot be mechanically evaluated, so the caller
   * declares which hold and which disqualifiers apply. This returns what is
   * left — it does not pretend to have judged the prose itself.
   */
  applicable(input: {
    repairClass?: string;
    satisfiedPreconditions: readonly string[];
    presentDisqualifiers: readonly string[];
    currentVersions: Readonly<Record<string, string>>;
  }): readonly { pattern: RepairPattern; compatibility: VersionCompatibility }[];
  all(): readonly RepairPattern[];
}

export function createPatternLibrary(): PatternLibrary {
  const patterns: RepairPattern[] = [];

  return {
    add(input) {
      const parsed = repairPatternSchema.safeParse(input);
      if (!parsed.success) {
        return { added: false, reason: `Not a valid pattern: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (patterns.some((p) => p.patternId === parsed.data.patternId)) {
        return { added: false, reason: `Pattern ${parsed.data.patternId} already exists.` };
      }
      patterns.push(parsed.data);
      return { added: true, pattern: parsed.data };
    },

    applicable(input) {
      const satisfied = new Set(input.satisfiedPreconditions);
      const disqualifiers = new Set(input.presentDisqualifiers);

      return patterns
        .filter((p) => p.status !== "DEPRECATED")
        .filter((p) => input.repairClass === undefined || p.repairClass === input.repairClass)
        .filter((p) => p.preconditions.every((pre) => satisfied.has(pre)))
        .filter((p) => !p.doesNotApplyWhen.some((d) => disqualifiers.has(d)))
        .map((p) => ({
          pattern: p,
          compatibility: versionsCompatibleForReuse({
            knownSafeFor: p.knownSafeFor,
            knownUnsafeFor: p.knownUnsafeFor,
            currentVersions: input.currentVersions,
          }),
        }))
        .filter((r) => r.compatibility.compatible);
    },

    all: () => [...patterns],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The reuse loop (§30).
//
//   Failure → build signature → search prior cases → search repair patterns
//   → check compatibility → reuse/adapt if appropriate → otherwise generate new
//
// "Every reused repair must still be validated against the current environment
// and versions."
// ─────────────────────────────────────────────────────────────────────────────

export interface ReuseFinding {
  /** Prior cases worth looking at, most similar first. */
  readonly priorCases: readonly SimilarCase[];
  /** The single best prior case, when one is clearly ahead. */
  readonly bestPriorCase: RepairCase | null;
  /** Patterns that could apply. */
  readonly patterns: readonly RepairPattern[];
  /** Whether prior knowledge can be reused here at all. */
  readonly reusable: boolean;
  readonly reason: string;
  /**
   * ALWAYS true when something is reused.
   *
   * §30's closing sentence, as a field rather than a footnote. There is no
   * path through this module that produces reusable knowledge exempt from
   * revalidation.
   */
  readonly stillRequiresValidation: true;
}

export function findReusableKnowledge(input: {
  signature: FailureSignature;
  store: ExperienceStore;
  library: PatternLibrary;
  currentVersions: Readonly<Record<string, string>>;
  repairClass?: string;
  satisfiedPreconditions?: readonly string[];
  presentDisqualifiers?: readonly string[];
  minSimilarity?: number;
}): ReuseFinding {
  const priorCases = input.store.similarTo(input.signature, {
    minSimilarity: input.minSimilarity ?? 0.6,
  });

  const patterns = input.library
    .applicable({
      ...(input.repairClass === undefined ? {} : { repairClass: input.repairClass }),
      satisfiedPreconditions: input.satisfiedPreconditions ?? [],
      presentDisqualifiers: input.presentDisqualifiers ?? [],
      currentVersions: input.currentVersions,
    })
    .map((r) => r.pattern);

  // Only cases whose repair actually worked are worth reusing. A case that
  // records a failed attempt is valuable for what NOT to do (§24) — but that
  // is retrieval for a human to read, not knowledge to apply.
  const usable = priorCases.filter((c) =>
    c.case.repairAttempts.some((a) => a.outcome === "APPLIED_SUCCEEDED"),
  );

  const compatible = usable.filter((c) => {
    const check = versionsCompatibleForReuse({
      knownSafeFor: {
        ...c.case.applicabilityScope.engineVersions,
        ...c.case.applicabilityScope.contractVersions,
      },
      currentVersions: input.currentVersions,
    });
    return check.compatible;
  });

  const best = compatible[0]?.case ?? null;

  if (best === null && patterns.length === 0) {
    return {
      priorCases,
      bestPriorCase: null,
      patterns: [],
      reusable: false,
      reason:
        priorCases.length === 0
          ? "No similar prior case and no applicable pattern. Generate a new candidate."
          : `${priorCases.length} similar case(s) found, but none has a successful repair compatible with the current versions. Generate a new candidate.`,
      stillRequiresValidation: true,
    };
  }

  return {
    priorCases,
    bestPriorCase: best,
    patterns,
    reusable: true,
    reason:
      best !== null
        ? `Prior case ${best.caseId} matched with a successful, version-compatible repair.`
        : `${patterns.length} applicable pattern(s), no compatible prior case.`,
    stillRequiresValidation: true,
  };
}
