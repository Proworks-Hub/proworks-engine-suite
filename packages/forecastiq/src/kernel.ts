// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { rational, type MethodRef, type Rational } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ForecastIQ kernel — §16. Built under DEC-026 with the CHARTER-TEXT FLAG
// OPEN: the registry's ratified hash refers to ForecastIQ_Charter_V1_0.docx,
// which is absent from disk; a charter document must be developed (or the
// original located), hash-verified, and reconciled against this kernel.
//
// The engine's spine: SEASONAL NAIVE IS THE PERMANENT BENCHMARK. Every
// published forecast carries FVA against it and a verdict that is allowed to
// be bad — `no-better-than-naive` and `worse-than-naive` are real, visible
// outcomes, and `insufficient-history-to-judge` never renders as adds-value.
// Intervals carry a declared basis, and observed coverage is null ("not yet
// measured") until enough origins exist — never a number, never an implied
// success; the nominal level is never presented as the achieved level.
// Accuracy comes only from rolling-origin backtests (a single split is one
// draw, refused); selection contaminates the origins it selected on and the
// flag says so. Coherence is proven POST-quantization with a required
// residual rule. Overrides retain the forecast they replaced and are scored
// against it. Detected bias is published, never auto-corrected — an engine
// that silently de-biases itself makes its own accuracy record
// uninterpretable. Seasonality is supplied, never silently inferred.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const FORECAST_METHODS = {
  naiveSeasonal: method("method.forecast.naive.seasonal"),
  naiveRandomWalk: method("method.forecast.naive.random-walk"),
  naiveDrift: method("method.forecast.naive.drift"),
  mean: method("method.forecast.mean"),
  intermittency: method("method.forecast.intermittency.classify"),
  croston: method("method.forecast.croston"),
  mase: method("method.accuracy.mase"),
  fva: method("method.forecast.fva"),
  selection: method("method.forecast.selection.backtest"),
  bias: method("method.accuracy.bias.tracking-signal"),
  reconcile: method("method.forecast.reconcile.bottom-up"),
  quantize: method("method.forecast.quantize"),
  interval: method("method.forecast.interval.empirical"),
  override: method("method.forecast.override"),
} as const satisfies Record<string, MethodRef>;

export const FORECAST_REFUSAL_KINDS = [
  "insufficient_history",
  "insufficient_origins",
  "multiple_seasonality_unsupported",
  "seasonal_period_not_supplied",
  "residual_rule_required",
  "coherence_unproven_not_publishable",
  "interval_basis_required",
  "override_missing_pre_override",
  "croston_correction_unselected",
] as const;
export type ForecastRefusalKind = (typeof FORECAST_REFUSAL_KINDS)[number];

export interface ForecastRefusal {
  readonly kind: ForecastRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ForecastRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ForecastRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// Series values are exact minor units.
export type Series = readonly bigint[];

// ── §16.16 · insufficient history: the typed refusal with minimums ──────────

export interface HistoryRequirement {
  readonly methodRef: MethodRef;
  readonly minimumObservations: number;
  readonly minimumSeasonalCycles: number; // 0 for non-seasonal methods
}

export function checkHistory(
  series: Series,
  requirement: HistoryRequirement,
  seasonalPeriod: number,
  allRequirements: readonly HistoryRequirement[],
): Result<{ sufficient: true }> {
  const cyclesSupplied = seasonalPeriod > 0 ? Math.floor(series.length / seasonalPeriod) : 0;
  if (series.length < requirement.minimumObservations || cyclesSupplied < requirement.minimumSeasonalCycles) {
    const servable = allRequirements
      .filter((r) => series.length >= r.minimumObservations && cyclesSupplied >= r.minimumSeasonalCycles)
      .map((r) => r.methodRef.methodId);
    // A forecast from three data points is the failure this rule exists to
    // prevent, and there is no configuration that permits it. The refusal
    // names what WOULD be servable — possibly nothing.
    return refuse(
      "insufficient_history",
      requirement.methodRef,
      `${series.length} observations supplied, ${requirement.minimumObservations} required (${cyclesSupplied}/${requirement.minimumSeasonalCycles} seasonal cycles at m=${seasonalPeriod}). Servable with this history: ${servable.length > 0 ? servable.join(", ") : "none"}.`,
    );
  }
  return ok({ sufficient: true });
}

// ── §16.1 · the naive family — THE BENCHMARK lives here ─────────────────────

/** ŷ(h) = observation from the same point in the previous cycle. This is the
 * permanent benchmark: cheap (a lookup), always computed, never optional. */
export function naiveSeasonal(series: Series, seasonalPeriod: number | undefined, horizons: number): Result<Series> {
  const M = FORECAST_METHODS.naiveSeasonal;
  if (seasonalPeriod === undefined || seasonalPeriod < 1) {
    // Supplied, never silently inferred: m=12 on a 4-4-5 calendar is
    // confidently seasonal in the wrong phase.
    return refuse("seasonal_period_not_supplied", M, "SeasonalPeriod is supplied; the engine may suggest a candidate but never applies one silently.");
  }
  if (series.length < seasonalPeriod) {
    return refuse("insufficient_history", M, `Seasonal naive needs one full cycle (${seasonalPeriod}); ${series.length} supplied.`);
  }
  const out: bigint[] = [];
  for (let h = 1; h <= horizons; h++) {
    const index = series.length - seasonalPeriod + ((h - 1) % seasonalPeriod);
    out.push(series[index]!);
  }
  return ok(out);
}

export function naiveRandomWalk(series: Series, horizons: number): Result<Series> {
  if (series.length === 0) return refuse("insufficient_history", FORECAST_METHODS.naiveRandomWalk, "Empty series.");
  return ok(Array.from({ length: horizons }, () => series[series.length - 1]!));
}

/** Random walk with drift over the full history: ŷ(h) = last + h·(last−first)/(n−1),
 * exact rational, rounded half-even per horizon. */
export function naiveDrift(series: Series, horizons: number): Result<Series> {
  const M = FORECAST_METHODS.naiveDrift;
  if (series.length < 2) return refuse("insufficient_history", M, "Drift needs at least two observations.");
  const last = series[series.length - 1]!;
  const perStepNum = last - series[0]!;
  const perStepDen = BigInt(series.length - 1);
  const out: bigint[] = [];
  for (let h = 1; h <= horizons; h++) {
    const numerator = last * perStepDen + BigInt(h) * perStepNum;
    const q = numerator / perStepDen;
    const rem = numerator % perStepDen;
    const twice = 2n * (rem < 0n ? -rem : rem);
    const bump = numerator < 0n ? -1n : 1n;
    out.push(twice > perStepDen ? q + bump : twice < perStepDen ? q : q % 2n === 0n ? q : q + bump);
  }
  return ok(out);
}

// ── §16.5 · intermittency classification and Croston/SBA ────────────────────

export type IntermittencyClass = "smooth" | "intermittent" | "erratic" | "lumpy";

/** ADI (average demand interval) and CV² of non-zero sizes against DECLARED
 * thresholds — the classification gates Croston. */
export function classifyIntermittency(
  series: Series,
  adiThresholdTimes100: bigint,
  cv2ThresholdTimes100: bigint,
): Result<{ class: IntermittencyClass; adiTimes100: bigint; cv2Times100: bigint }> {
  const M = FORECAST_METHODS.intermittency;
  const nonZero = series.filter((v) => v !== 0n);
  if (nonZero.length < 2) return refuse("insufficient_history", M, "Intermittency needs at least two non-zero demands.");
  const adiTimes100 = (BigInt(series.length) * 100n) / BigInt(nonZero.length);
  const mean = nonZero.reduce((a, v) => a + v, 0n) / BigInt(nonZero.length);
  if (mean === 0n) return refuse("insufficient_history", M, "Zero mean demand size.");
  const varianceNumerator = nonZero.reduce((a, v) => a + (v - mean) * (v - mean), 0n);
  const cv2Times100 = (varianceNumerator * 100n) / (BigInt(nonZero.length) * mean * mean);
  const highAdi = adiTimes100 >= adiThresholdTimes100;
  const highCv2 = cv2Times100 >= cv2ThresholdTimes100;
  const cls: IntermittencyClass = highAdi ? (highCv2 ? "lumpy" : "intermittent") : highCv2 ? "erratic" : "smooth";
  return ok({ class: cls, adiTimes100, cv2Times100 });
}

/**
 * Croston: sizes and intervals smoothed separately with declared α (permille),
 * forecast = size/interval. Classical Croston is biased upward; SBA applies
 * (1 − α/2). BOTH are registered, NEITHER is a default — the correction is
 * right on average, the uncorrected form is right for some inventory
 * objectives, and the choice is the caller's.
 */
export function croston(
  series: Series,
  alphaPermille: bigint,
  correction: "classical" | "sba" | undefined,
): Result<{ forecastPerPeriod: Rational; correction: "classical" | "sba" }> {
  const M = FORECAST_METHODS.croston;
  if (correction === undefined) {
    return refuse("croston_correction_unselected", M, "Classical (biased upward) and SBA (bias-corrected) are both registered; silently picking one is the unstated choice the registry exists to prevent.");
  }
  const sizes: bigint[] = [];
  const intervals: bigint[] = [];
  let sinceLast = 0n;
  for (const v of series) {
    sinceLast += 1n;
    if (v !== 0n) {
      sizes.push(v);
      intervals.push(sinceLast);
      sinceLast = 0n;
    }
  }
  if (sizes.length < 2) return refuse("insufficient_history", M, "Croston needs at least two non-zero demands.");
  const smooth = (values: readonly bigint[]): Rational => {
    // SES at declared α, exact rationals: s ← s + α(v − s).
    let stateNum = values[0]! * 1000n;
    let stateDen = 1000n;
    for (let i = 1; i < values.length; i++) {
      stateNum = stateNum * 1000n + alphaPermille * (values[i]! * stateDen - stateNum);
      stateDen = stateDen * 1000n;
      const r = rational(stateNum, stateDen);
      stateNum = r.num;
      stateDen = r.den;
    }
    return rational(stateNum, stateDen);
  };
  const size = smooth(sizes);
  const interval = smooth(intervals);
  let forecast = rational(size.num * interval.den, size.den * interval.num);
  if (correction === "sba") {
    forecast = rational(forecast.num * (2000n - alphaPermille), forecast.den * 2000n);
  }
  return ok({ forecastPerPeriod: forecast, correction });
}

// ── §16.13 · accuracy: MASE over rolling origins, never pooled in storage ───

export interface BacktestError {
  readonly origin: number; // index of the forecast origin in the series
  readonly horizon: number;
  readonly absErrorMinor: bigint;
}

/** In-sample seasonal-naive MAE denominator (scale of the series), exact. */
export function seasonalNaiveDenominator(series: Series, seasonalPeriod: number): Rational | null {
  if (series.length <= seasonalPeriod) return null;
  let sum = 0n;
  for (let i = seasonalPeriod; i < series.length; i++) {
    const e = series[i]! - series[i - seasonalPeriod]!;
    sum += e < 0n ? -e : e;
  }
  const count = BigInt(series.length - seasonalPeriod);
  if (sum === 0n) return null; // degenerate: MASE undefined, not infinite-and-informative
  return rational(sum, count);
}

/** MASE per horizon: mean |error| at that horizon over origins, scaled.
 * Errors are RETAINED per (origin, horizon); pooling is presentation only. */
export function masePerHorizon(
  errors: readonly BacktestError[],
  denominator: Rational,
  horizon: number,
): Rational | null {
  const at = errors.filter((e) => e.horizon === horizon);
  if (at.length === 0) return null;
  const meanAbs = rational(at.reduce((a, e) => a + e.absErrorMinor, 0n), BigInt(at.length));
  return rational(meanAbs.num * denominator.den, meanAbs.den * denominator.num);
}

/** MAPE with a definedness count — reported only, NEVER used for selection:
 * undefined at zero actuals, asymmetric (over-forecast unbounded, under
 * capped at 100%), meaningless on zero-crossing series. */
export function mapeWithDefinedness(
  pairs: readonly { actualMinor: bigint; forecastMinor: bigint }[],
): { mapePermille: bigint | null; definedOver: number; undefinedCount: number; selectionEligible: false } {
  const defined = pairs.filter((p) => p.actualMinor !== 0n);
  if (defined.length === 0) return { mapePermille: null, definedOver: 0, undefinedCount: pairs.length, selectionEligible: false };
  let sumPermille = 0n;
  for (const p of defined) {
    const e = p.actualMinor - p.forecastMinor;
    const absE = e < 0n ? -e : e;
    const absA = p.actualMinor < 0n ? -p.actualMinor : p.actualMinor;
    sumPermille += (absE * 1000n) / absA;
  }
  return {
    mapePermille: sumPermille / BigInt(defined.length),
    definedOver: defined.length,
    undefinedCount: pairs.length - defined.length,
    selectionEligible: false,
  };
}

// ── §16.12 · FVA: required, permanent, allowed to be bad ────────────────────

export type FvaVerdict = "adds-value" | "no-better-than-naive" | "worse-than-naive" | "insufficient-history-to-judge";

export interface FvaResult {
  readonly horizon: number;
  /** accuracy(naive) − accuracy(method): positive means the method added value. */
  readonly fva: Rational | null;
  readonly verdict: FvaVerdict;
  readonly origins: number;
  readonly methodRef: MethodRef;
}

const rCmp = (a: Rational, b: Rational): -1 | 0 | 1 => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
};

export function computeFva(
  methodErrors: readonly BacktestError[],
  naiveErrors: readonly BacktestError[],
  denominator: Rational | null,
  horizon: number,
  minimumOrigins: number,
  marginPermille: bigint,
): FvaResult {
  const M = FORECAST_METHODS.fva;
  const origins = methodErrors.filter((e) => e.horizon === horizon).length;
  if (denominator === null || origins < minimumOrigins) {
    // A degenerate scaling denominator or too few origins: the verdict is
    // insufficient-history-to-judge, NEVER rendered as adds-value.
    return { horizon, fva: null, verdict: "insufficient-history-to-judge", origins, methodRef: M };
  }
  const methodMase = masePerHorizon(methodErrors, denominator, horizon);
  const naiveMase = masePerHorizon(naiveErrors, denominator, horizon);
  if (methodMase === null || naiveMase === null) {
    return { horizon, fva: null, verdict: "insufficient-history-to-judge", origins, methodRef: M };
  }
  const fva = rational(naiveMase.num * methodMase.den - methodMase.num * naiveMase.den, naiveMase.den * methodMase.den);
  const margin = rational(marginPermille * naiveMase.num, 1000n * naiveMase.den);
  const negMargin = rational(-margin.num, margin.den);
  const verdict: FvaVerdict =
    rCmp(fva, margin) > 0 ? "adds-value" : rCmp(fva, negMargin) < 0 ? "worse-than-naive" : "no-better-than-naive";
  return { horizon, fva, verdict, origins, methodRef: M };
}

// ── §16.11 · selection: best that beats seasonal naive, else naive itself ───

export interface CandidateScore {
  readonly methodId: string;
  readonly maseTimes1000: bigint; // horizon-weighted, precomputed by the backtest
}

export interface MethodSelection {
  readonly selectedMethodId: string;
  readonly fvaVerdict: "adds-value" | "no-better-than-naive";
  readonly candidateScores: readonly CandidateScore[];
  /** Accuracy reported on the origins the selection used is contaminated;
   * an uncontaminated figure needs post-selection origins. Rendered at L1. */
  readonly selectionContaminated: true;
  readonly methodRef: MethodRef;
}

export function selectMethod(
  candidates: readonly CandidateScore[],
  naiveSeasonalScore: CandidateScore,
  originCount: number,
  minimumOrigins: number,
): Result<MethodSelection> {
  const M = FORECAST_METHODS.selection;
  if (originCount < minimumOrigins) {
    // A single train/test split is one draw; refused.
    return refuse("insufficient_origins", M, `${originCount} rolling origins supplied; ${minimumOrigins} required. A single split is refused.`);
  }
  const beatingNaive = candidates
    .filter((c) => c.maseTimes1000 < naiveSeasonalScore.maseTimes1000)
    .sort((a, b) => (a.maseTimes1000 !== b.maseTimes1000 ? (a.maseTimes1000 < b.maseTimes1000 ? -1 : 1) : a.methodId < b.methodId ? -1 : 1));
  if (beatingNaive.length === 0) {
    // The selection is seasonal naive ITSELF — permanently visible, not
    // hidden behind a fallback.
    return ok({
      selectedMethodId: naiveSeasonalScore.methodId,
      fvaVerdict: "no-better-than-naive",
      candidateScores: candidates,
      selectionContaminated: true,
      methodRef: M,
    });
  }
  return ok({
    selectedMethodId: beatingNaive[0]!.methodId,
    fvaVerdict: "adds-value",
    candidateScores: candidates,
    selectionContaminated: true,
    methodRef: M,
  });
}

// ── §16.14 · bias: detected, published, never auto-corrected ────────────────

export interface BiasFinding {
  readonly horizon: number;
  readonly meanErrorMinor: bigint; // signed
  readonly trackingSignalTimes100: bigint; // cumulative error / MAD
  readonly thresholdCrossed: boolean;
  readonly publishes: "forecast.bias.detected" | null;
  /** The engine NEVER applies a correction: that changes the method, and
   * changing the method is a decision with a version. A bias-corrected
   * method is offered as a CANDIDATE at the next re-selection. */
  readonly autoCorrectionApplied: false;
}

export function trackBias(
  signedErrorsMinor: readonly bigint[],
  horizon: number,
  thresholdTimes100: bigint,
): BiasFinding {
  const n = BigInt(Math.max(signedErrorsMinor.length, 1));
  const sum = signedErrorsMinor.reduce((a, e) => a + e, 0n);
  const meanError = sum / n;
  const mad = signedErrorsMinor.reduce((a, e) => a + (e < 0n ? -e : e), 0n) / n;
  const signal = mad === 0n ? 0n : (sum * 100n) / mad;
  const absSignal = signal < 0n ? -signal : signal;
  const crossed = absSignal > thresholdTimes100;
  return {
    horizon,
    meanErrorMinor: meanError,
    trackingSignalTimes100: signal,
    thresholdCrossed: crossed,
    publishes: crossed ? "forecast.bias.detected" : null,
    autoCorrectionApplied: false,
  };
}

// ── §16.6 · intervals: declared basis, honest coverage ──────────────────────

export type IntervalBasis = "model-residual" | "empirical-backtest" | "conformal-split" | "simulated-path";

export interface PredictionInterval {
  readonly basis: IntervalBasis;
  readonly nominalPermille: number;
  readonly lowerMinor: bigint;
  readonly upperMinor: bigint;
  /** null until minimum origins exist; null renders "not yet measured" —
   * never a number, never an implied success. */
  readonly coverageObservedPermille: number | null;
  readonly coverageObservedOrigins: number;
  /** The nominal level is never presented as the achieved level. */
  readonly renderedAs: string;
}

export function buildInterval(
  basis: IntervalBasis | undefined,
  nominalPermille: number,
  lowerMinor: bigint,
  upperMinor: bigint,
  observedHits: number,
  observedOrigins: number,
  minimumOriginsForCoverage: number,
): Result<PredictionInterval> {
  const M = FORECAST_METHODS.interval;
  if (basis === undefined) {
    return refuse("interval_basis_required", M, "Four bases with different assumptions and coverage properties; no default.");
  }
  const measured = observedOrigins >= minimumOriginsForCoverage;
  const coverage = measured ? Math.floor((observedHits * 1000) / observedOrigins) : null;
  return ok({
    basis,
    nominalPermille,
    lowerMinor,
    upperMinor,
    coverageObservedPermille: coverage,
    coverageObservedOrigins: observedOrigins,
    renderedAs:
      coverage === null
        ? `${nominalPermille / 10}% interval (coverage not yet measured)`
        : `${nominalPermille / 10}% interval (observed coverage ${coverage / 10}% over ${observedOrigins} origins)`,
  });
}

// ── §16.10 · coherence: proven post-quantization, or not publishable ────────

export interface StructureNode {
  readonly nodeRef: string;
  readonly childRefs: readonly string[]; // empty = bottom-level
}

/**
 * Bottom-up reconciliation with quantization: bottom values are exact minor
 * units; every aggregate is the exact sum of its children, so I-COH holds by
 * construction — and is then PROVEN, not assumed, because a future edit that
 * breaks the construction must fail loudly. The residual rule is required
 * because quantizing a working-domain forecast produces a remainder, and
 * silently dropping it onto whichever node rounds last is the actual
 * mechanism by which coherence breaks in shipped software.
 */
export function reconcileBottomUp(
  nodes: readonly StructureNode[],
  bottomForecastsWorkingDomain: ReadonlyMap<string, Rational>,
  residualRule: "largest-remainder" | "assign-to-designated-node" | undefined,
  designatedNodeRef?: string,
): Result<{ quantized: ReadonlyMap<string, bigint>; coherence: "proven" }> {
  const M = FORECAST_METHODS.reconcile;
  if (residualRule === undefined) {
    return refuse("residual_rule_required", M, "Quantization produces a remainder; the rule that assigns it is required and recorded, never emergent.");
  }
  const bottomRefs = nodes.filter((n) => n.childRefs.length === 0).map((n) => n.nodeRef);
  // Quantize the bottom level with the residual against the exact total.
  const floors = bottomRefs.map((nodeRef) => {
    const r = bottomForecastsWorkingDomain.get(nodeRef) ?? rational(0n, 1n);
    const floor = r.num >= 0n ? r.num / r.den : (r.num - r.den + 1n) / r.den;
    return { nodeRef, floor, frac: rational(r.num - floor * r.den, r.den) };
  });
  const exactTotal = bottomRefs.reduce(
    (acc, nodeRef) => {
      const r = bottomForecastsWorkingDomain.get(nodeRef) ?? rational(0n, 1n);
      return rational(acc.num * r.den + r.num * acc.den, acc.den * r.den);
    },
    rational(0n, 1n),
  );
  const targetTotal = ((): bigint => {
    const floor = exactTotal.num >= 0n ? exactTotal.num / exactTotal.den : (exactTotal.num - exactTotal.den + 1n) / exactTotal.den;
    const twiceRem = 2n * (exactTotal.num - floor * exactTotal.den);
    return twiceRem > exactTotal.den ? floor + 1n : twiceRem < exactTotal.den ? floor : floor % 2n === 0n ? floor : floor + 1n;
  })();
  let residual = targetTotal - floors.reduce((a, f) => a + f.floor, 0n);
  const quantized = new Map<string, bigint>(floors.map((f) => [f.nodeRef, f.floor]));
  if (residualRule === "assign-to-designated-node") {
    const target = designatedNodeRef ?? bottomRefs[0]!;
    quantized.set(target, (quantized.get(target) ?? 0n) + residual);
  } else {
    const order = [...floors].sort((a, b) => {
      const cmp = rCmp(b.frac, a.frac);
      return cmp !== 0 ? cmp : a.nodeRef < b.nodeRef ? -1 : 1;
    });
    for (const f of order) {
      if (residual <= 0n) break;
      quantized.set(f.nodeRef, quantized.get(f.nodeRef)! + 1n);
      residual -= 1n;
    }
  }
  // Aggregates are exact sums of quantized children (bottom-up over the DAG;
  // a grouped structure may share a bottom cell across paths).
  const resolve = (nodeRef: string): bigint => {
    if (quantized.has(nodeRef)) return quantized.get(nodeRef)!;
    const node = nodes.find((n) => n.nodeRef === nodeRef)!;
    const value = node.childRefs.reduce((a, c) => a + resolve(c), 0n);
    quantized.set(nodeRef, value);
    return value;
  };
  for (const node of nodes) resolve(node.nodeRef);
  // I-COH proven POST-quantization on the values a user will see: a set
  // whose invariant cannot be established is not publishable. TRIPWIRE:
  // with aggregates constructed as exact sums of the same quantized children
  // this check cannot fire today (mutation F8-M4 is equivalent) — it exists
  // so a future edit that breaks the construction (e.g. computing aggregates
  // from working-domain rationals and quantizing them independently) refuses
  // instead of publishing an incoherent set.
  for (const node of nodes) {
    if (node.childRefs.length === 0) continue;
    const childSum = node.childRefs.reduce((a, c) => a + quantized.get(c)!, 0n);
    if (childSum !== quantized.get(node.nodeRef)!) {
      return refuse("coherence_unproven_not_publishable", M, `I-COH fails at ${node.nodeRef}: children sum ${childSum} != ${quantized.get(node.nodeRef)!}.`);
    }
  }
  return ok({ quantized, coherence: "proven" });
}

// ── §16.15 · overrides: the replaced forecast is retained and scored ────────

export interface OverrideRecord {
  readonly overrideId: string;
  readonly appliedBy: string; // human.
  readonly reason: string;
  /** REQUIRED — the whole point: without it nobody can compute what the
   * adjustment cost. */
  readonly preOverrideForecastMinor: Series;
  readonly postOverrideForecastMinor: Series;
  readonly producesNewVersion: true; // LOCK-3: never edits one
  /** null until realized actuals exist — a handful of overrides is not
   * evidence about a person (KL-08). */
  readonly scoredFva: Rational | null;
}

export function recordOverride(
  overrideId: string,
  appliedBy: string,
  reason: string,
  preOverrideForecastMinor: Series | undefined,
  postOverrideForecastMinor: Series,
): Result<OverrideRecord> {
  const M = FORECAST_METHODS.override;
  if (preOverrideForecastMinor === undefined) {
    return refuse("override_missing_pre_override", M, "An override whose pre-override forecast cannot be retained is refused: retaining it is what makes the adjustment's cost computable.");
  }
  if (!appliedBy.startsWith("human.") || reason.trim() === "") {
    return refuse("override_missing_pre_override", M, "An override needs a human principal and a non-empty reason.");
  }
  return ok({
    overrideId,
    appliedBy,
    reason,
    preOverrideForecastMinor,
    postOverrideForecastMinor,
    producesNewVersion: true,
    scoredFva: null,
  });
}

/** Once actuals realize: FVA(override) = accuracy(pre) − accuracy(post).
 * Positive means the human helped — and the answer is per author, testable. */
export function scoreOverride(record: OverrideRecord, actualsMinor: Series): OverrideRecord {
  const horizons = Math.min(record.preOverrideForecastMinor.length, actualsMinor.length);
  let preAbs = 0n;
  let postAbs = 0n;
  for (let i = 0; i < horizons; i++) {
    const preError = actualsMinor[i]! - record.preOverrideForecastMinor[i]!;
    const postError = actualsMinor[i]! - record.postOverrideForecastMinor[i]!;
    preAbs += preError < 0n ? -preError : preError;
    postAbs += postError < 0n ? -postError : postError;
  }
  return { ...record, scoredFva: rational(preAbs - postAbs, BigInt(Math.max(horizons, 1))) };
}
