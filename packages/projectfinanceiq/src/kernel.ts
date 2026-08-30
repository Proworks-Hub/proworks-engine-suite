// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { divideAndRound, type MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ProjectFinanceIQ kernel — §16. The EAC problem stated plainly: three
// defensible formulas answer 1,100,000 / 1,250,000 / 1,437,500 on one golden
// case — 33.75% of BAC (K-2). The formula is therefore a REQUIRED argument
// with no default, every result names its formula, and the earned-value
// measures honour their defined-ness traps: CPI with zero actual cost is
// UNDEFINED, not infinity and not zero.
//
// ProjectFinanceIQ never recognises revenue (percentage-of-completion
// revenue is RevenueRecognitionIQ's judgement even though the input measure
// comes from here) and never rewrites a prior baseline.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const PROJECT_METHODS = {
  eacTypical: method("EAC-AC-PLUS-REMAINING"),
  eacCpi: method("EAC-BAC-OVER-CPI"),
  eacCpiSpi: method("EAC-COMBINED-CPI-SPI"),
  earnedValue: method("EV-MEASURES"),
  baseline: method("BASELINE-VERSION"),
  registry: method("PF-METHOD-REGISTRY"),
} as const satisfies Record<string, MethodRef>;

export const PROJECT_REFUSAL_KINDS = [
  "EAC_FORMULA_UNSELECTED",
  "MEASURE_UNDEFINED",
  "METHOD_CIRCULARITY",
  "BASELINE_IMMUTABLE",
] as const;
export type ProjectRefusalKind = (typeof PROJECT_REFUSAL_KINDS)[number];

export interface ProjectRefusal {
  readonly kind: ProjectRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ProjectRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ProjectRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── Earned-value measures with defined-ness traps honoured ──────────────────

export interface EvInputs {
  /** Budget at completion, minor units. */
  readonly bacMinor: bigint;
  /** Earned value = budgeted cost of work performed. */
  readonly evMinor: bigint;
  /** Actual cost of work performed. */
  readonly acMinor: bigint;
  /** Planned value = budgeted cost of work scheduled. */
  readonly pvMinor: bigint;
}

export type Index =
  | { readonly state: "defined"; readonly valueBps: number }
  | { readonly state: "undefined"; readonly reason: string };

export function costPerformanceIndex(inputs: EvInputs): Index {
  if (inputs.acMinor === 0n) {
    // EV over zero cost is not infinity and not 1.0 — it is a project on
    // which no cost has been recorded, and the index does not exist yet.
    return { state: "undefined", reason: "AC is zero: CPI = EV/AC does not exist yet." };
  }
  return { state: "defined", valueBps: Number((inputs.evMinor * 10000n) / inputs.acMinor) };
}

export function schedulePerformanceIndex(inputs: EvInputs): Index {
  if (inputs.pvMinor === 0n) {
    return { state: "undefined", reason: "PV is zero: SPI = EV/PV does not exist yet." };
  }
  return { state: "defined", valueBps: Number((inputs.evMinor * 10000n) / inputs.pvMinor) };
}

// ── EAC: the formula is a required argument (K-2, 33.75% of BAC) ────────────

export type EacFormula = "ac-plus-remaining" | "bac-over-cpi" | "combined-cpi-spi";

export function estimateAtCompletion(
  inputs: EvInputs,
  formula: EacFormula | undefined,
): Result<{ eacMinor: bigint; methodRef: MethodRef }> {
  if (formula === undefined) {
    return refuse(
      "EAC_FORMULA_UNSELECTED",
      PROJECT_METHODS.registry,
      "Three defensible formulas answer 1,100,000 / 1,250,000 / 1,437,500 on one golden case — 33.75% of BAC (K-2). The formula is the caller's to name; the engine records which produced every figure.",
    );
  }
  switch (formula) {
    case "ac-plus-remaining":
      // EAC = AC + (BAC − EV): past variance is not expected to recur.
      return ok({
        eacMinor: inputs.acMinor + (inputs.bacMinor - inputs.evMinor),
        methodRef: PROJECT_METHODS.eacTypical,
      });
    case "bac-over-cpi": {
      const cpi = costPerformanceIndex(inputs);
      if (cpi.state === "undefined") {
        return refuse("MEASURE_UNDEFINED", PROJECT_METHODS.eacCpi, cpi.reason);
      }
      // EAC = BAC / CPI = BAC × AC / EV, exact then rounded once.
      if (inputs.evMinor === 0n) {
        return refuse("MEASURE_UNDEFINED", PROJECT_METHODS.eacCpi, "EV is zero: BAC/CPI divides by it.");
      }
      return ok({
        eacMinor: divideAndRound(inputs.bacMinor * inputs.acMinor, inputs.evMinor, "half-even"),
        methodRef: PROJECT_METHODS.eacCpi,
      });
    }
    case "combined-cpi-spi": {
      const cpi = costPerformanceIndex(inputs);
      const spi = schedulePerformanceIndex(inputs);
      if (cpi.state === "undefined" || spi.state === "undefined") {
        return refuse(
          "MEASURE_UNDEFINED",
          PROJECT_METHODS.eacCpiSpi,
          [cpi, spi].filter((x): x is Extract<Index, { state: "undefined" }> => x.state === "undefined").map((x) => x.reason).join(" "),
        );
      }
      // EAC = AC + (BAC − EV) / (CPI × SPI), exact rational then rounded once.
      const denominator = inputs.evMinor * inputs.evMinor; // (EV/AC)(EV/PV) => AC·PV/EV²
      if (denominator === 0n) {
        return refuse("MEASURE_UNDEFINED", PROJECT_METHODS.eacCpiSpi, "EV is zero.");
      }
      const remaining = divideAndRound(
        (inputs.bacMinor - inputs.evMinor) * inputs.acMinor * inputs.pvMinor,
        denominator,
        "half-even",
      );
      return ok({ eacMinor: inputs.acMinor + remaining, methodRef: PROJECT_METHODS.eacCpiSpi });
    }
  }
}

/**
 * The degenerate pairing (16.7): measuring progress by cost-incurred AND
 * estimating EAC by CPI makes EV a function of AC, so CPI ≡ 1 and the
 * estimate can never signal an overrun. Detected and refused, not warned.
 */
export function detectCircularity(
  progressMeasure: "cost-incurred" | "physical-output" | "milestones",
  formula: EacFormula,
): Result<"independent"> {
  if (progressMeasure === "cost-incurred" && (formula === "bac-over-cpi" || formula === "combined-cpi-spi")) {
    return refuse(
      "METHOD_CIRCULARITY",
      PROJECT_METHODS.registry,
      "Progress measured by cost incurred makes EV a function of AC; CPI is then identically 1 and a CPI-based EAC can never signal an overrun. The pairing is refused.",
    );
  }
  return ok("independent");
}

// ── Baselines: immutable versions, never rewrites ───────────────────────────

export interface Baseline {
  readonly version: number;
  readonly bacMinor: bigint;
  readonly authorizationRef?: string;
  readonly supersedes?: number;
}

export function reviseBaseline(
  history: readonly Baseline[],
  next: { bacMinor: bigint; authorizationRef?: string },
): Result<readonly Baseline[]> {
  const M = PROJECT_METHODS.baseline;
  if (history.length > 0 && next.authorizationRef === undefined) {
    return refuse("BASELINE_IMMUTABLE", M, "A baseline revision needs an authorization reference; the prior baseline is never rewritten.");
  }
  const latest = history[history.length - 1];
  const revision: Baseline = {
    version: (latest?.version ?? 0) + 1,
    bacMinor: next.bacMinor,
    ...(next.authorizationRef !== undefined ? { authorizationRef: next.authorizationRef } : {}),
    ...(latest !== undefined ? { supersedes: latest.version } : {}),
  };
  return ok([...history, revision]);
}
