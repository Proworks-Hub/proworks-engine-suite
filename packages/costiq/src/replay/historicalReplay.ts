/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/replay/historicalReplay.ts
 * Module:   cost-iq-engine / replay
 * Purpose:  Rebuilding an old estimate as it stood, not as it would stand today.
 */

import type { CostRate } from "../domain/costModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// "WHY DID WE QUOTE THAT?" — EIGHTEEN MONTHS LATER
//
// This is the question a costing engine is ultimately for, and the one almost
// no system can answer. Everything needed is usually still there: the rates,
// the method, the estimate. What is missing is the discipline to select the
// rates that were IN FORCE THEN rather than the ones in force now.
//
// `replayCertification` answers a different question — "does this computation
// reproduce" — and takes the inputs as given. This module produces those
// inputs: given a rate history and a date, it picks what the engine would have
// seen, so the recomputation is of the past rather than of today.
//
// THE HALF-OPEN INTERVAL IS THE WHOLE THING
//
// A rate is in force from `effectiveFrom` INCLUSIVE to `effectiveTo`
// EXCLUSIVE. Get that wrong and on the boundary day two rates are both in
// force, or neither is. Both are silent: the estimate still computes, and it
// is either double-counting or falling back to something weaker.
//
// The convention is enforced here rather than trusted, and the ambiguous case
// is REFUSED rather than resolved by picking the first match. A replay that
// quietly chose between two equally valid rates would be a replay that returns
// a different answer depending on the order rows came back from a database.
// ─────────────────────────────────────────────────────────────────────────────

export type RateSelection =
  | { readonly found: true; readonly rate: CostRate }
  | { readonly found: false; readonly reason: string; readonly candidatesConsidered: number };

/**
 * Whether a rate was in force at an instant.
 *
 * Half-open: `effectiveFrom <= at < effectiveTo`. ISO-8601 strings compare
 * correctly as strings when they carry the same offset, which every timestamp
 * in this engine does — they are produced as UTC with `toISOString`.
 */
export function inForceAt(rate: CostRate, at: string): boolean {
  if (rate.effectiveFrom > at) return false;
  if (rate.effectiveTo !== undefined && rate.effectiveTo <= at) return false;
  return true;
}

/**
 * The rate that was in force at a moment.
 *
 * Refuses ambiguity. Two rates covering the same instant is a data problem, and
 * resolving it by taking the first would make the answer depend on row order.
 */
export function rateInForceAt(history: readonly CostRate[], at: string): RateSelection {
  const inForce = history.filter((r) => inForceAt(r, at));

  if (inForce.length === 0) {
    return {
      found: false,
      candidatesConsidered: history.length,
      reason:
        history.length === 0
          ? `No rate history was supplied, so nothing can be said about ${at}. This is not "the rate was zero".`
          : `None of the ${history.length} rates in this history was in force at ${at}. The estimate made then rested on something this history does not contain — a rate since deleted, or a different basis entirely.`,
    };
  }

  if (inForce.length > 1) {
    return {
      found: false,
      candidatesConsidered: history.length,
      reason: `${inForce.length} rates were in force at ${at}, which cannot be true. Their intervals overlap, and picking one would make this replay depend on the order the rates arrived in. Fix the overlap; the effective intervals are half-open, so a rate ending on the same instant another begins is correct and does not overlap.`,
    };
  }

  return { found: true, rate: inForce[0]! };
}

export interface HistoricalInputs {
  /** The rates the engine would have selected, keyed by basis. */
  readonly rates: ReadonlyMap<string, CostRate>;
  /** Bases whose rate could not be established, and why. Never silently dropped. */
  readonly unresolved: readonly { readonly basisId: string; readonly reason: string }[];
  readonly asOf: string;
  /** True only when every basis resolved. A partial replay is not a replay. */
  readonly complete: boolean;
  readonly note: string;
}

/**
 * Reconstructs the rate set an estimate was built on.
 *
 * Reports rather than throws on an unresolved basis, because a partial answer
 * is genuinely useful here — "eleven of twelve rates reconstruct, and the
 * twelfth is the one that changed" is exactly the finding somebody is after.
 * What it must never do is present that as a complete replay, so `complete`
 * is a separate field and the note says which it is.
 */
export function reconstructInputs(
  histories: ReadonlyMap<string, readonly CostRate[]>,
  asOf: string,
): HistoricalInputs {
  const rates = new Map<string, CostRate>();
  const unresolved: { basisId: string; reason: string }[] = [];

  // Sorted, so the unresolved list and therefore the note are identical across
  // runs regardless of Map insertion order.
  for (const basisId of [...histories.keys()].sort()) {
    const selection = rateInForceAt(histories.get(basisId) ?? [], asOf);
    if (selection.found) rates.set(basisId, selection.rate);
    else unresolved.push({ basisId, reason: selection.reason });
  }

  const complete = unresolved.length === 0;
  return {
    rates,
    unresolved,
    asOf,
    complete,
    note: complete
      ? `All ${rates.size} bases resolved to the rate in force at ${asOf}. Recomputing from these reproduces what the engine would have seen, which is a stronger claim than recomputing from today's rates.`
      : `${rates.size} of ${rates.size + unresolved.length} bases resolved at ${asOf}; ${unresolved.length} did not. This is NOT a replay — it is a partial reconstruction, and any total computed from it is a different number from the one that was quoted.`,
  };
}

export type HistoricalComparison =
  | {
      readonly reproduced: true;
      readonly note: string;
    }
  | {
      readonly reproduced: false;
      readonly cause: "INPUTS_UNAVAILABLE" | "METHOD_VERSION_UNKNOWN" | "RATES_CHANGED" | "UNEXPLAINED";
      readonly note: string;
      readonly changedBases: readonly { readonly basisId: string; readonly then: string; readonly now: string }[];
    };

/**
 * Explains why a historical estimate does or does not reproduce.
 *
 * Separates the causes for the same reason the replay certification does: only
 * one of them is a defect, and reporting them together sends people looking for
 * arithmetic bugs that are not there.
 */
export function explainHistoricalDifference(input: {
  readonly reconstructed: HistoricalInputs;
  readonly currentRates: ReadonlyMap<string, CostRate>;
  /** The version recorded against the estimate. Null for anything pre-versioning. */
  readonly recordedMethodVersion: string | null;
  readonly recordedTotal: string;
  readonly replayedTotal: string;
}): HistoricalComparison {
  if (!input.reconstructed.complete) {
    return {
      reproduced: false,
      cause: "INPUTS_UNAVAILABLE",
      changedBases: [],
      note: `${input.reconstructed.unresolved.length} basis${input.reconstructed.unresolved.length === 1 ? "" : "es"} could not be reconstructed at ${input.reconstructed.asOf}, so there is nothing to compare. The first reason given was: ${input.reconstructed.unresolved[0]?.reason ?? "(none recorded)"}`,
    };
  }

  if (input.recordedMethodVersion === null) {
    // The common case for anything migrated from v1, and worth saying plainly
    // rather than letting a matching total imply reproducibility.
    return {
      reproduced: false,
      cause: "METHOD_VERSION_UNKNOWN",
      changedBases: [],
      note: `No method version was recorded against this estimate, so what computed it is unknown. Even a total that matches would not prove reproduction — it would prove that today's method happens to agree, which is a different and much weaker claim.`,
    };
  }

  const changedBases: { basisId: string; then: string; now: string }[] = [];
  for (const basisId of [...input.reconstructed.rates.keys()].sort()) {
    const then = input.reconstructed.rates.get(basisId)!;
    const now = input.currentRates.get(basisId);
    if (now === undefined || now.amount !== then.amount) {
      changedBases.push({ basisId, then: then.amount, now: now?.amount ?? "(no current rate)" });
    }
  }

  if (input.recordedTotal === input.replayedTotal) {
    return {
      reproduced: true,
      note: `The estimate reproduces exactly at ${input.recordedTotal}, from the ${input.reconstructed.rates.size} rates in force at ${input.reconstructed.asOf}${changedBases.length > 0 ? ` — ${changedBases.length} of which have since changed, which is why replaying against today's rates would not have matched` : ""}.`,
    };
  }

  if (changedBases.length > 0) {
    return {
      reproduced: false,
      cause: "RATES_CHANGED",
      changedBases,
      note: `The replayed total ${input.replayedTotal} differs from the recorded ${input.recordedTotal}, and ${changedBases.length} rate${changedBases.length === 1 ? " has" : "s have"} changed since. Check whether the reconstruction picked the right ones before suspecting the arithmetic — the boundary of an effective interval is the usual culprit.`,
    };
  }

  return {
    reproduced: false,
    cause: "UNEXPLAINED",
    changedBases: [],
    note: `Same method version, same rates, and a different total: ${input.recordedTotal} recorded against ${input.replayedTotal} replayed. Nothing about the inputs explains this, which makes it a real defect rather than history behaving as it should.`,
  };
}
