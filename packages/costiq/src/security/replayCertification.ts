/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/security/replayCertification.ts
 * Module:   cost-iq-engine / security
 * Purpose:  Proving a cost can be reproduced, rather than asserting it.
 */

import { type Decimal, toString as decToString } from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// "DETERMINISTIC" IS A CLAIM UNTIL SOMETHING CHECKS IT
//
// Every engine claims its calculations are reproducible. The claim survives
// until somebody adds a `Date.now()` for a freshness check, a `Math.random()`
// for a sample, or an object iteration whose order depends on insertion. None
// of those break a test. They break the ability to answer "why did we quote
// that?" eighteen months later, which is when it matters and when it is far
// too late to fix.
//
// So determinism here is CERTIFIED: a replay bundle captures the inputs, the
// method version and the result digest; re-running must produce the same
// digest; and a mismatch reports WHICH field diverged rather than just failing.
//
// A DIGEST MISMATCH IS NOT ALWAYS A BUG
//
// It has three quite different causes and they need different responses:
//
//   - The method version changed. Expected — the bundle records the version so
//     this is distinguishable from the others, and the answer is "recompute
//     under the old version if you need the old number".
//   - An input changed. Also expected, and the reason inputs are captured
//     rather than referenced: a bundle that pointed at a rate which has since
//     moved would replay to a different number and look like a bug.
//   - Neither changed and the number still differs. That is the real defect,
//     and it is the one this exists to make loud.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayBundle {
  readonly bundleId: string;
  /** The method and version that produced the result. Both, always. */
  readonly methodId: string;
  readonly methodVersion: string;
  /**
   * The inputs, captured by VALUE.
   *
   * Not by reference. A bundle that pointed at a cost basis which has since
   * been superseded would replay to a different number and look like a
   * determinism failure, when the engine had done exactly the right thing.
   */
  readonly inputs: Readonly<Record<string, string>>;
  /** The time the computation was told it was. Captured because it is an input. */
  readonly asOf: string;
  /** The result, as canonical strings. */
  readonly outputs: Readonly<Record<string, string>>;
  /** Digest of the canonical form of everything above. */
  readonly digest: string;
  readonly capturedAt: string;
}

/**
 * The canonical text a digest is taken over.
 *
 * Keys are sorted, so a bundle built by two code paths that happened to insert
 * fields in different orders still digests identically. Without this, a
 * refactor that reorders two assignments looks like a determinism failure.
 */
export function canonicalBundleForm(bundle: Omit<ReplayBundle, "digest" | "bundleId" | "capturedAt">): string {
  const section = (name: string, record: Readonly<Record<string, string>>) =>
    `${name}\n${Object.keys(record)
      .sort()
      .map((key) => `  ${key}=${record[key]}`)
      .join("\n")}`;

  return [
    `method ${bundle.methodId}@${bundle.methodVersion}`,
    `asOf ${bundle.asOf}`,
    section("inputs", bundle.inputs),
    section("outputs", bundle.outputs),
  ].join("\n");
}

/** Turns decimals into the canonical strings a bundle holds. */
export function canonicalizeDecimals(values: Readonly<Record<string, Decimal>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = decToString(value);
  return out;
}

export const DIVERGENCE_CAUSES = ["METHOD_VERSION_CHANGED", "INPUTS_CHANGED", "UNEXPLAINED"] as const;
export type DivergenceCause = (typeof DIVERGENCE_CAUSES)[number];

export interface FieldDivergence {
  readonly field: string;
  readonly recorded: string | undefined;
  readonly replayed: string | undefined;
}

export type ReplayVerdict =
  | { readonly reproduced: true; readonly digest: string }
  | {
      readonly reproduced: false;
      readonly cause: DivergenceCause;
      readonly inputDivergences: readonly FieldDivergence[];
      readonly outputDivergences: readonly FieldDivergence[];
      readonly explanation: string;
    };

/**
 * Compares a recorded bundle with a fresh replay.
 *
 * Reports the CAUSE, not just the fact. "The digest differs" sends somebody
 * looking for a bug in the arithmetic when the actual answer is that the
 * method was versioned up last Tuesday.
 */
export function verifyReplay(recorded: ReplayBundle, replayed: ReplayBundle): ReplayVerdict {
  if (recorded.digest === replayed.digest) {
    return { reproduced: true, digest: recorded.digest };
  }

  const inputDivergences = diffRecords(recorded.inputs, replayed.inputs);
  const outputDivergences = diffRecords(recorded.outputs, replayed.outputs);

  if (recorded.methodId !== replayed.methodId || recorded.methodVersion !== replayed.methodVersion) {
    return {
      reproduced: false,
      cause: "METHOD_VERSION_CHANGED",
      inputDivergences,
      outputDivergences,
      explanation: `Computed under ${recorded.methodId}@${recorded.methodVersion}, replayed under ${replayed.methodId}@${replayed.methodVersion}. This is expected when a method is versioned; to reproduce the original number, replay under the original version.`,
    };
  }

  if (inputDivergences.length > 0) {
    return {
      reproduced: false,
      cause: "INPUTS_CHANGED",
      inputDivergences,
      outputDivergences,
      explanation: `The inputs differ in ${inputDivergences.length} field${
        inputDivergences.length === 1 ? "" : "s"
      }: ${inputDivergences.map((d) => d.field).join(", ")}. The engine is behaving correctly — different inputs give a different answer. Replay with the recorded inputs to test the engine itself.`,
    };
  }

  if (recorded.asOf !== replayed.asOf) {
    return {
      reproduced: false,
      cause: "INPUTS_CHANGED",
      inputDivergences,
      outputDivergences,
      explanation: `The as-of time differs: ${recorded.asOf} vs ${replayed.asOf}. Time is an input here, so this is a changed input rather than a defect.`,
    };
  }

  return {
    reproduced: false,
    cause: "UNEXPLAINED",
    inputDivergences,
    outputDivergences,
    explanation: `Same method, same version, same inputs, same as-of time — and a different answer. This is a real determinism defect, and the likely causes are a clock read inside the calculation, an unordered iteration, or a mutable value shared between runs. Diverged outputs: ${outputDivergences
      .map((d) => `${d.field} (${d.recorded ?? "absent"} → ${d.replayed ?? "absent"})`)
      .join(", ")}.`,
  };
}

function diffRecords(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): readonly FieldDivergence[] {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  const divergences: FieldDivergence[] = [];
  // Sorted so two runs of the report list divergences in the same order — a
  // determinism check whose own output is non-deterministic is a poor joke.
  for (const field of [...fields].sort()) {
    if (a[field] !== b[field]) divergences.push({ field, recorded: a[field], replayed: b[field] });
  }
  return divergences;
}

/**
 * Runs a computation twice and reports whether it agreed with itself.
 *
 * The cheapest determinism check there is, and it catches the most common
 * cause: a clock or a random read inside the calculation. It cannot catch
 * drift across versions — that is what a stored bundle is for.
 */
export function certifySelfConsistency<T>(
  compute: () => T,
  canonicalize: (value: T) => string,
  runs = 3,
): { readonly consistent: boolean; readonly forms: readonly string[]; readonly note: string } {
  const forms: string[] = [];
  for (let i = 0; i < runs; i += 1) forms.push(canonicalize(compute()));

  const first = forms[0]!;
  const differing = forms.findIndex((f) => f !== first);

  if (differing === -1) {
    return {
      consistent: true,
      forms,
      note: `${runs} runs agreed. This rules out a clock or a random read inside the calculation; it does not rule out drift between versions, which is what a stored replay bundle is for.`,
    };
  }
  return {
    consistent: false,
    forms,
    note: `Run ${differing + 1} of ${runs} disagreed with run 1. The calculation is reading something that changes between calls — most likely a clock, a random source, or an iteration over an unordered collection.`,
  };
}
