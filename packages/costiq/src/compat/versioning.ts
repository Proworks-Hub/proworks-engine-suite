/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/compat/versioning.ts
 * Module:   cost-iq-engine / compat
 * Purpose:  Moving from v1 to v2 without silently changing anybody's numbers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THE DANGEROUS MIGRATION IS THE ONE THAT COMPILES
//
// v1 of this engine is in production. KSix quotes from it. A migration that
// breaks the build is a nuisance; a migration that compiles and returns a
// slightly different number is a business problem, because nobody looks for a
// bug in code that still works.
//
// Two of the v2 changes do exactly that if they are not handled deliberately:
//
//   - v1 computed in JavaScript floats. v2 computes in exact decimal. For most
//     inputs the answers agree to the penny; for some they differ in the last
//     place, and v2 is the correct one. That is still a CHANGED NUMBER on a
//     quote somebody may already have sent.
//
//   - v1 had no method versioning, so "the direct job cost method" meant
//     whatever the code did that day. v2 pins `id@version`. An estimate
//     migrated without a version recorded cannot be replayed, and the honest
//     thing is to say so rather than to guess which version it was.
//
// So migration is EXPLICIT, per estimate, and it records that a recomputation
// happened rather than quietly overwriting.
//
// V1 IS NOT DELETED
//
// It stays exported and working. An engine that removed the old path on the
// day the new one shipped would force every consumer to migrate on the
// engine's schedule instead of their own, and rushed migrations are how the
// silently-changed-number problem actually happens.
// ─────────────────────────────────────────────────────────────────────────────

export const COSTIQ_API_VERSION = "2.0.0" as const;

/** What a change to the public surface does to somebody depending on it. */
export type CompatibilityImpact =
  | "NONE"
  | "SOURCE_BREAKING"
  | "BEHAVIOUR_CHANGING"
  | "BOTH";

export interface SurfaceChange {
  readonly since: string;
  readonly what: string;
  readonly impact: CompatibilityImpact;
  /** What a consumer must do. Empty only when the honest answer is "nothing". */
  readonly action: string;
  /**
   * Why the change was worth making.
   *
   * Recorded because "we changed it" invites the reader to work around it,
   * while the reason usually persuades them not to.
   */
  readonly rationale: string;
}

export const SURFACE_CHANGES: readonly SurfaceChange[] = Object.freeze([
  {
    since: "2.0.0",
    what: "Cost arithmetic moved from JavaScript numbers to exact decimal (BigInt fixed-point).",
    impact: "BEHAVIOUR_CHANGING",
    action:
      "Recompute rather than assume. Most results agree to the penny; those that differ do so in the last place, and v2 is the correct one. Compare before and after on a sample of real estimates so a changed quote is discovered by you rather than by a customer.",
    rationale:
      "0.1 + 0.2 is not 0.3 in binary floating point. Over a bill of materials with hundreds of lines, the error accumulates and the total does not equal the sum of the parts a customer can see.",
  },
  {
    since: "2.0.0",
    what: "Costing methods are addressed as `id@version`; there is no 'latest' lookup.",
    impact: "SOURCE_BREAKING",
    action: "Name the version you want. If you do not know which one an old estimate used, record that it is unknown rather than guessing.",
    rationale:
      "An estimate computed by 'whatever the method does today' cannot be replayed, so it cannot be defended eighteen months later when somebody asks why the quote was what it was.",
  },
  {
    since: "2.0.0",
    what: "Division requires an explicit scale and rounding mode.",
    impact: "SOURCE_BREAKING",
    action: "Pass both at every call site. There is deliberately no default.",
    rationale:
      "A default rounding mode is a decision made once by whoever wrote the function and then inherited by every caller who never thought about it. Rounding is a policy question, and half-up versus half-even shifts money in a consistent direction across thousands of lines.",
  },
  {
    since: "2.0.0",
    what: "Currency is refused rather than defaulted when unknown, and cross-currency arithmetic is refused even when one side is zero.",
    impact: "BEHAVIOUR_CHANGING",
    action: "Supply the currency. A zero in GBP and a zero in USD are still different amounts, and adding them silently is how the mixing starts.",
    rationale: "Defaulting an unknown currency to two decimal places is wrong for JPY, KWD and CLF, and wrong silently.",
  },
  {
    since: "2.0.0",
    what: "Approved estimates are immutable; there is no transition back to draft.",
    impact: "BEHAVIOUR_CHANGING",
    action: "Correct by creating a new version. The old one stays readable.",
    rationale: "Editing an approved estimate rewrites what a past decision was made on, rather than correcting it going forward.",
  },
  {
    since: "2.0.0",
    what: "v1 entry points (`createCostIqEngine`, `calculateJobCost`, `calculateJobPricing`) remain exported and unchanged.",
    impact: "NONE",
    action: "",
    rationale:
      "Removing the old path on the day the new one ships forces every consumer to migrate on the engine's schedule rather than their own, and a rushed migration is how a silently changed number reaches a customer.",
  },
]);

/** Changes a consumer must act on, worst first. */
export function breakingChangesSince(version: string): readonly SurfaceChange[] {
  return SURFACE_CHANGES.filter((c) => c.impact !== "NONE" && c.since > version).sort((a, b) =>
    a.impact === b.impact ? a.what.localeCompare(b.what) : rankImpact(b.impact) - rankImpact(a.impact),
  );
}

function rankImpact(impact: CompatibilityImpact): number {
  return impact === "BOTH" ? 3 : impact === "BEHAVIOUR_CHANGING" ? 2 : impact === "SOURCE_BREAKING" ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATING A STORED ESTIMATE
// ─────────────────────────────────────────────────────────────────────────────

export interface LegacyEstimate {
  readonly id: string;
  /** v1 stored costs as JavaScript numbers. That is the problem being migrated. */
  readonly totalCost: number;
  readonly currency: string | null;
  /** v1 had no method versioning, so this is usually absent. */
  readonly methodVersion: string | null;
  readonly approvedAt: string | null;
}

export type MigrationOutcome =
  | {
      readonly migrated: true;
      readonly id: string;
      /** The v1 total, as an exact decimal string. Converted, NOT recomputed. */
      readonly totalCost: string;
      readonly warnings: readonly string[];
    }
  | { readonly migrated: false; readonly id: string; readonly reason: string; readonly remedy: string };

/**
 * Converts one v1 estimate into a v2-shaped record.
 *
 * CONVERTS, does not recompute. The distinction matters: recomputing would
 * produce v2's (more correct) number and silently replace what a customer was
 * quoted. Converting preserves the historical figure and flags that it was
 * computed in floating point, so a person decides whether to requote.
 */
export function migrateEstimate(legacy: LegacyEstimate): MigrationOutcome {
  if (legacy.currency === null) {
    return {
      migrated: false,
      id: legacy.id,
      reason: "This estimate has no currency. v2 refuses to guess one, because guessing two decimal places is wrong for JPY, KWD and CLF — and wrong silently.",
      remedy: "Set the currency from the order or the customer record, then migrate again.",
    };
  }

  if (!Number.isFinite(legacy.totalCost)) {
    return {
      migrated: false,
      id: legacy.id,
      reason: `The stored total is ${String(legacy.totalCost)}, which is not a number. In v1 this could arise from a division by zero that nothing refused.`,
      remedy: "Recompute this estimate from its inputs under v2, which refuses the division rather than storing an infinity.",
    };
  }

  const warnings: string[] = [];

  // Round-tripping the float through its shortest decimal representation is
  // the closest thing to "what v1 meant". It is not exact, and saying so is
  // the point of the warning rather than something to hide.
  const asDecimalString = decimalStringFromNumber(legacy.totalCost);
  if (Number(asDecimalString) !== legacy.totalCost) {
    warnings.push(
      `The stored value ${legacy.totalCost} could not be represented exactly and was recorded as ${asDecimalString}. The difference is below a penny; it is reported because a silent conversion is how a migration changes numbers nobody checks.`,
    );
  }

  if (legacy.methodVersion === null) {
    warnings.push(
      "No method version was recorded, because v1 had none. This estimate CANNOT be replayed — the arithmetic that produced it is whatever the code did on the day. Treat the figure as historical evidence rather than as something reproducible.",
    );
  }

  if (legacy.approvedAt !== null) {
    warnings.push(
      "This estimate is approved, so under v2 it is immutable. It has been migrated as-is and will not be recomputed by any basis change; correcting it means creating a new version.",
    );
  }

  return { migrated: true, id: legacy.id, totalCost: asDecimalString, warnings };
}

/**
 * A decimal string for a finite JavaScript number.
 *
 * `toString()` rather than `toFixed()`, because `toFixed` picks a scale and
 * `toString` gives the shortest representation that round-trips — which is as
 * close as anything gets to what v1 intended. Exponential notation is expanded,
 * since the decimal parser does not accept it and a value arriving as "1e-7"
 * would otherwise fail at a confusing place.
 */
export function decimalStringFromNumber(value: number): string {
  const text = value.toString();
  if (!text.includes("e") && !text.includes("E")) return text;

  const [mantissa, exponentText] = text.split(/[eE]/) as [string, string];
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = (negative ? mantissa.slice(1) : mantissa).replace(".", "");
  const pointAt = (mantissa.includes(".") ? mantissa.indexOf(".") - (negative ? 1 : 0) : (negative ? mantissa.length - 1 : mantissa.length)) + exponent;

  let result: string;
  // `<= 0` rather than `< 0`. The `=== 0` case is defensive: JavaScript only
  // formats exponentially below 1e-6 or at/above 1e21, so a point position of
  // exactly zero cannot arise from a real number here. It is kept because the
  // alternative branch would produce ".123" — which the decimal parser rejects
  // — and it is noted because a mutation on this boundary survives for that
  // reason rather than because a test is missing.
  if (pointAt <= 0) result = `0.${"0".repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) result = `${digits}${"0".repeat(pointAt - digits.length)}`;
  else result = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;

  return negative ? `-${result}` : result;
}

/** Migrates a batch, keeping the successes and reporting the failures. */
export function migrateBatch(legacy: readonly LegacyEstimate[]): {
  readonly migrated: readonly Extract<MigrationOutcome, { migrated: true }>[];
  readonly failed: readonly Extract<MigrationOutcome, { migrated: false }>[];
  readonly summary: string;
} {
  const migrated: Extract<MigrationOutcome, { migrated: true }>[] = [];
  const failed: Extract<MigrationOutcome, { migrated: false }>[] = [];

  for (const item of legacy) {
    const outcome = migrateEstimate(item);
    if (outcome.migrated) migrated.push(outcome);
    else failed.push(outcome);
  }

  const withWarnings = migrated.filter((m) => m.warnings.length > 0).length;
  return {
    migrated,
    failed,
    summary: `${migrated.length} migrated (${withWarnings} with warnings), ${failed.length} refused. The refusals are the useful part: each one names an estimate that v1 stored in a state v2 will not pretend is valid.`,
  };
}
