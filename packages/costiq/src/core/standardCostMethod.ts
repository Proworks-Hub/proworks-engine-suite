/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/standardCostMethod.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Frozen standard costs and mutable planned ones, and the line
 *           between them.
 */

import {
  type Decimal,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD AND PLANNED ARE DIFFERENT THINGS THAT LOOK THE SAME
//
// Both are "what we think this costs". The difference is what they are FOR.
//
//   STANDARD  is approved and FROZEN for a period. Everything measures against
//             it, so it must not move — a standard that drifted would make
//             every variance in the period meaningless, and nobody would know
//             when it happened.
//
//   PLANNED   is a simulation. It exists to be changed: what if steel is 10%
//             higher next quarter, what if we move the operation in-house.
//             Freezing it would defeat the purpose.
//
// The failure mode is treating one as the other. A planned cost quietly
// becoming the measurement baseline means variances are computed against a
// guess somebody made while exploring; a standard cost that can be edited
// means the baseline moved and every historical variance is now wrong.
//
// So the type carries which it is, and the operations refuse the wrong one.
//
// COSTIQ DOES NOT POST ACCOUNTING ENTRIES
//
// A standard cost changing has inventory revaluation consequences. Those are
// Finance IQ's, and the directive says so explicitly. CostIQ produces the
// cost and the evidence; posting the journal is somebody else's authority.
// ─────────────────────────────────────────────────────────────────────────────

export type CostVersionKind = "STANDARD" | "PLANNED";
export type CostVersionStatus = "DRAFT" | "CANDIDATE" | "APPROVED" | "RETIRED";

export interface CostVersion {
  readonly versionId: string;
  readonly kind: CostVersionKind;
  readonly status: CostVersionStatus;
  readonly label: string;
  /** The costed subject. */
  readonly objectId: string;
  readonly unitCost: Decimal;
  readonly currency: string;
  /** The period this version applies to. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** Which estimate produced it, so the number is traceable. */
  readonly sourceEstimateId: string;
  readonly sourceEstimateVersion: number;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

export type VersionChangeResult =
  | { readonly ok: true; readonly version: CostVersion }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a version's numbers may still change.
 *
 * A STANDARD is frozen once approved. A PLANNED version is never frozen — it
 * exists to be varied, and approving one only means "this is the planning
 * assumption we are using", not "this can no longer change".
 */
export function isFrozen(version: CostVersion): boolean {
  return version.kind === "STANDARD" && version.status === "APPROVED";
}

/**
 * Changes a version's cost.
 *
 * REFUSES on an approved standard. That is the whole point of a standard: if
 * it can be edited, every variance measured against it in the period is
 * measured against a moving target, and nothing records when it moved.
 */
export function reviseCost(version: CostVersion, unitCost: Decimal): VersionChangeResult {
  if (isFrozen(version)) {
    return {
      ok: false,
      reason: `${version.versionId} is an APPROVED STANDARD cost and cannot be changed. Every variance in its period is measured against it, so editing it would silently invalidate all of them. Supersede it with a new version whose effective period starts where this one ends.`,
    };
  }
  return { ok: true, version: { ...version, unitCost } };
}

/**
 * Moves a version through its lifecycle.
 *
 * The transitions mirror the estimate's, for the same reason: there is no path
 * from APPROVED back to DRAFT, because a correction is a new version rather
 * than an edit to the old one.
 */
export function transitionStatus(
  version: CostVersion,
  to: CostVersionStatus,
  by: string,
  at: string,
): VersionChangeResult {
  const permitted: Readonly<Record<CostVersionStatus, readonly CostVersionStatus[]>> = {
    DRAFT: ["CANDIDATE", "RETIRED"],
    CANDIDATE: ["APPROVED", "DRAFT", "RETIRED"],
    APPROVED: ["RETIRED"],
    RETIRED: [],
  };

  if (!permitted[version.status].includes(to)) {
    return {
      ok: false,
      reason:
        to === "DRAFT" && version.status === "APPROVED"
          ? `Refusing APPROVED -> DRAFT for ${version.versionId}. An approved cost version is what a period's variances are measured against; making it editable rewrites that history rather than correcting it.`
          : `${version.versionId} cannot move from ${version.status} to ${to}.`,
    };
  }

  return {
    ok: true,
    version: {
      ...version,
      status: to,
      ...(to === "APPROVED" ? { approvedBy: by, approvedAt: at } : {}),
    },
  };
}

/**
 * The version in force for an object at an instant.
 *
 * Effective periods are half-open — start inclusive, end exclusive — so two
 * consecutive versions meet without overlapping or leaving a gap. Overlapping
 * standards would make "what does this cost" have two answers.
 */
export function versionInForce(
  versions: readonly CostVersion[],
  objectId: string,
  kind: CostVersionKind,
  asOf: Date,
): CostVersion | null {
  const candidates = versions.filter((v) => {
    if (v.objectId !== objectId || v.kind !== kind || v.status !== "APPROVED") return false;
    const from = Date.parse(v.effectiveFrom);
    if (Number.isNaN(from) || from > asOf.getTime()) return false;
    if (v.effectiveTo !== null) {
      const to = Date.parse(v.effectiveTo);
      if (!Number.isNaN(to) && to <= asOf.getTime()) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  // The latest-starting one wins. Two approved standards covering the same
  // instant is a data problem rather than a question with two answers, and the
  // most recent is the least surprising resolution — but it is a resolution,
  // so `overlappingVersions` exists to find them.
  return [...candidates].sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0]!;
}

/**
 * Approved versions of the same kind whose periods overlap.
 *
 * A detector rather than a guard, because the overlap usually arrives through
 * data rather than through this module — and finding it is more useful than
 * refusing to answer.
 */
export function overlappingVersions(
  versions: readonly CostVersion[],
): readonly { readonly a: string; readonly b: string; readonly objectId: string }[] {
  const approved = versions.filter((v) => v.status === "APPROVED");
  const found: { a: string; b: string; objectId: string }[] = [];

  for (let i = 0; i < approved.length; i += 1) {
    for (let j = i + 1; j < approved.length; j += 1) {
      const a = approved[i]!;
      const b = approved[j]!;
      if (a.objectId !== b.objectId || a.kind !== b.kind) continue;

      const aFrom = Date.parse(a.effectiveFrom);
      const aTo = a.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(a.effectiveTo);
      const bFrom = Date.parse(b.effectiveFrom);
      const bTo = b.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(b.effectiveTo);

      // Half-open intervals overlap when each starts before the other ends.
      if (aFrom < bTo && bFrom < aTo) {
        found.push({ a: a.versionId, b: b.versionId, objectId: a.objectId });
      }
    }
  }
  return found.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

/**
 * The difference between two versions, for a revaluation conversation.
 *
 * REPORTS the difference and the quantity it applies to. It does NOT compute a
 * journal entry, post anything, or decide what should happen — that is Finance
 * IQ's, and CostIQ producing "the revaluation amount" would be CostIQ deciding
 * an accounting treatment it does not own.
 */
export function standardCostChange(
  from: CostVersion,
  to: CostVersion,
  quantityOnHand: Decimal,
  scale: number,
  mode: Parameters<typeof divide>[3],
): {
  readonly perUnit: Decimal;
  readonly percentChange: Decimal;
  readonly extendedAtQuantity: Decimal;
  readonly note: string;
} {
  if (from.currency !== to.currency) {
    throw new TypeError(
      `Cannot compare a ${from.currency} standard with a ${to.currency} one. Converting needs a rate, a date and a source.`,
    );
  }
  const perUnit = subtract(to.unitCost, from.unitCost);
  return {
    perUnit,
    percentChange:
      compare(from.unitCost, ZERO) === 0
        ? ZERO
        : divide(multiply(perUnit, fromString("100")), from.unitCost, scale, mode),
    extendedAtQuantity: multiply(perUnit, quantityOnHand),
    note: "Reported as economic evidence. Any inventory revaluation or journal entry arising from this change is Finance IQ's to decide and post; CostIQ does not own accounting treatment.",
  };
}

/** Sums version costs. Small helper so callers avoid importing arithmetic. */
export function totalOfVersions(versions: readonly CostVersion[]): Decimal {
  return versions.reduce<Decimal>((acc, v) => add(acc, v.unitCost), ZERO);
}

/** The version's cost as a plain decimal string. */
export const versionCostString = (v: CostVersion): string => decToString(v.unitCost);
