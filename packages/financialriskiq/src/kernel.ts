// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// FinancialRiskIQ kernel — §16. The defining premise: an aggregate exposure
// computed from an incomplete set of positions is not a smaller exposure —
// it is an UNKNOWN one. Coverage is a set difference expressed as named
// sources, never a percentage (the denominator is the unknown thing). A
// partial aggregate's field is `contributedExposureMinor`, not `exposure`,
// so a consumer rendering `exposure` renders nothing rather than a partial
// figure under a complete-sounding name. The one-sided determinacy rule: a
// MONOTONE limit can be proven breached on partial data — adding the missing
// positions cannot cure it — but never proven within limit; a non-monotone
// or undeclared limit is indeterminate always. VaR cannot be aggregated
// (VAR-AGG-1: it is not subadditive, so the sum can UNDERSTATE) and resolves
// only behind gates; ES combines only over an identical scenario set.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const RISK_METHODS = {
  coverage: method("risk.coverage.assemble"),
  determinacy: method("risk.coverage.determinacy"),
  fxTransaction: method("risk.fx.transaction"),
  dv01: method("risk.rate.dv01"),
  settlement: method("risk.counterparty.settlementExposure"),
  varHistorical: method("risk.var.historical"),
  esHistorical: method("risk.es.historical"),
  limitTest: method("risk.limit.test"),
  stress: method("risk.stress.deterministic"),
} as const satisfies Record<string, MethodRef>;

export const RISK_REFUSAL_KINDS = [
  "fx_exposure_kind_mismatch",
  "economic_exposure_not_measurable_from_positions",
  "distribution_assumption_undocumented",
  "var_gates_not_met",
  "var_aggregation_forbidden",
  "scenario_set_mismatch",
  "disclosure_limitations_block_required",
  "shock_beyond_linear_validity",
] as const;
export type RiskRefusalKind = (typeof RISK_REFUSAL_KINDS)[number];

export interface RiskRefusal {
  readonly kind: RiskRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: RiskRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: RiskRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.2 · the coverage manifest ───────────────────────────────────────────

export type SourceGapReason =
  | "port-unbound"
  | "port-error"
  | "port-timeout"
  | "source-refused"
  | "stale-beyond-tolerance"
  | "partially-answered"
  | "identity-unresolved";

export interface SourceExpectation {
  readonly sourceRef: string;
  readonly materiality: "required" | "contributory";
}

export interface SourceContribution {
  readonly sourceRef: string;
  readonly positionAsOf: string;
  readonly positionCount: number;
  readonly exposureMinor: bigint;
}

export interface SourceGap {
  readonly sourceRef: string;
  readonly reason: SourceGapReason;
  readonly lastKnownAsOf?: string;
  readonly detail: string;
}

export type CoverageState = "complete" | "incomplete" | "unknown";

export interface CoverageManifest {
  readonly declaredSources: readonly SourceExpectation[];
  readonly contributed: readonly SourceContribution[];
  readonly unreachable: readonly SourceGap[];
  readonly coverageState: CoverageState;
  readonly methodRef: MethodRef;
}

/**
 * The state rule: `unknown` when any REQUIRED source is unreachable (we
 * cannot characterise what we are missing); `incomplete` when only
 * contributory sources are missing (we know exactly what is missing and it
 * was declared non-essential); `complete` only when nothing is missing.
 * Partial answers are unreachable, not contributed. Stale answers are
 * unreachable, with lastKnownAsOf recorded for a human — the figure does not
 * enter the aggregate. NO coverage percentage exists anywhere.
 */
export function assembleCoverage(
  declaredSources: readonly SourceExpectation[],
  contributed: readonly SourceContribution[],
  unreachable: readonly SourceGap[],
): CoverageManifest {
  const unreachableRefs = new Set(unreachable.map((g) => g.sourceRef));
  const requiredMissing = declaredSources.some((s) => s.materiality === "required" && unreachableRefs.has(s.sourceRef));
  const coverageState: CoverageState = requiredMissing ? "unknown" : unreachable.length > 0 ? "incomplete" : "complete";
  return { declaredSources, contributed, unreachable, coverageState, methodRef: RISK_METHODS.coverage };
}

/** §16.2.4: a complete aggregate carries `exposureMinor`; anything less
 * carries `contributedExposureMinor` — different field names on different
 * variants, so nothing partial renders under a complete-sounding name. */
export type ExposureAggregate =
  | { readonly basis: "complete"; readonly exposureMinor: bigint; readonly coverage: CoverageManifest }
  | { readonly basis: "partial"; readonly contributedExposureMinor: bigint; readonly coverage: CoverageManifest };

export function aggregateExposure(coverage: CoverageManifest): ExposureAggregate {
  const total = coverage.contributed.reduce((a, c) => a + c.exposureMinor, 0n);
  return coverage.coverageState === "complete"
    ? { basis: "complete", exposureMinor: total, coverage }
    : { basis: "partial", contributedExposureMinor: total, coverage };
}

// ── §16.2.5 · the one-sided determinacy rule ────────────────────────────────

export type LimitOutcome = "within-limit" | "breached" | "indeterminate";

export interface CoverageDeficiency {
  readonly missingSources: readonly string[];
  readonly explanation: string;
}

export interface LimitTestResult {
  readonly limitId: string;
  readonly outcome: LimitOutcome;
  readonly determinacy: { readonly coverageState: CoverageState; readonly monotone: boolean | undefined };
  /** LIM-1: indeterminate REQUIRES a populated deficiency. */
  readonly deficiency: CoverageDeficiency | null;
  /** LIM-2 as data: which event a publisher may emit. `risk.limit.breached`
   * only for breached; indeterminate gets its own event, because a consumer
   * must not read "we could not tell" as "we are fine". */
  readonly publishableEvent: "risk.limit.breached" | "risk.limit.indeterminate" | null;
  readonly methodRef: MethodRef;
}

export function testLimit(
  limitId: string,
  aggregate: ExposureAggregate,
  thresholdMinor: bigint,
  monotone: boolean | undefined,
  suspended = false,
): LimitTestResult {
  const M = RISK_METHODS.limitTest;
  const coverage = aggregate.coverage;
  const missing = coverage.unreachable.map((g) => g.sourceRef);
  const indeterminate = (explanation: string): LimitTestResult => ({
    limitId,
    outcome: "indeterminate",
    determinacy: { coverageState: coverage.coverageState, monotone },
    deficiency: { missingSources: missing, explanation },
    publishableEvent: "risk.limit.indeterminate",
    methodRef: M,
  });
  if (suspended) {
    // LIM-3: a suspended limit yields indeterminate, never within-limit.
    return indeterminate("Limit suspended; suspension is not compliance.");
  }
  if (aggregate.basis === "complete") {
    const breached = aggregate.exposureMinor > thresholdMinor;
    return {
      limitId,
      outcome: breached ? "breached" : "within-limit",
      determinacy: { coverageState: coverage.coverageState, monotone },
      deficiency: null,
      publishableEvent: breached ? "risk.limit.breached" : null,
      methodRef: M,
    };
  }
  if (monotone === undefined) {
    // A limit whose monotonicity is undeclared is indeterminate ALWAYS.
    return indeterminate("monotone undeclared: the limit cannot be tested on partial coverage in either direction.");
  }
  if (monotone && aggregate.contributedExposureMinor > thresholdMinor) {
    // Proven breached on partial data: adding the missing positions cannot
    // cure a monotone measure already over its threshold.
    return {
      limitId,
      outcome: "breached",
      determinacy: { coverageState: coverage.coverageState, monotone },
      deficiency: null,
      publishableEvent: "risk.limit.breached",
      methodRef: M,
    };
  }
  // Never proven within limit on partial coverage; a missing position could
  // push a monotone measure over, and could move a net measure either way.
  return indeterminate(
    monotone
      ? "Monotone measure under threshold on partial coverage: missing positions can only add, so within-limit cannot be proven."
      : "Non-monotone measure on partial coverage: a missing position could offset or add.",
  );
}

// ── §16.3 · FX: three kinds, never summed ───────────────────────────────────

export interface FxExposureFigure {
  readonly fxKind: "transaction" | "translation";
  readonly entityRef: string;
  readonly currencyPair: string;
  readonly netMinor: bigint;
}

/** Rule FX-1: transaction and translation results may not be summed, netted
 * or presented as one figure — hedging a translation exposure with a forward
 * creates a CASH obligation to protect a NON-CASH equity balance. */
export function combineFxExposures(figures: readonly FxExposureFigure[]): Result<{ combinedNetMinor: bigint; fxKind: string }> {
  const M = RISK_METHODS.fxTransaction;
  const kinds = new Set(figures.map((f) => f.fxKind));
  if (kinds.size > 1) {
    return refuse(
      "fx_exposure_kind_mismatch",
      M,
      "Transaction and translation FX are different exposures with different hedge types (IFRS 9 6.5.2); no operation sums them.",
    );
  }
  const entities = new Set(figures.map((f) => f.entityRef));
  if (entities.size > 1) {
    return refuse(
      "fx_exposure_kind_mismatch",
      M,
      "Cross-entity netting requires an explicit domain-definition declaration: two subsidiaries' offsetting positions do not offset in either subsidiary's books.",
    );
  }
  return ok({ combinedNetMinor: figures.reduce((a, f) => a + f.netMinor, 0n), fxKind: [...kinds][0] ?? "transaction" });
}

/** §16.3.4: economic exposure is not computable from positions. The engine
 * refuses and emits the assumption slots an analyst must fill for ScenarioIQ. */
export function economicExposure(currencyPairs: readonly string[]): Result<never> & { readonly scenarioInputSpec?: never } {
  return refuse(
    "economic_exposure_not_measurable_from_positions",
    RISK_METHODS.fxTransaction,
    `Requires demand elasticities, competitor pass-through and a market-structure model — none held as evidence. Assumption slots for ScenarioIQ: ${currencyPairs
      .map((p) => `elasticity(${p}), pass-through(${p})`)
      .join("; ")}. A product reporting "economic exposure: 8.4m" is reporting an assumption set; this engine reports the assumption set.`,
  ) as Result<never>;
}

// ── §16.4 · DV01 with the approximation block ───────────────────────────────

export interface Dv01Result {
  readonly dv01Minor: bigint;
  /** RATE-2: the limitation in the output, not a footnote. */
  readonly approximation: {
    readonly kind: "linear";
    readonly assumesParallelShift: true;
    readonly validForShockBpsUpTo: number;
  };
  readonly methodRef: MethodRef;
}

export function dv01(
  modifiedDurationE8: bigint,
  priceMinor: bigint,
  validForShockBpsUpTo: number,
  requestedShockBps: number,
): Result<Dv01Result> {
  const M = RISK_METHODS.dv01;
  if (requestedShockBps > validForShockBpsUpTo) {
    return refuse(
      "shock_beyond_linear_validity",
      M,
      `Shock of ${requestedShockBps}bps exceeds the linear validity range (${validForShockBpsUpTo}bps); route to convexity-adjusted or refuse. A sensitivity presented without its validity range is the number that gets used outside it.`,
    );
  }
  // DV01 = modified duration × price × 0.0001
  const dv = (modifiedDurationE8 * priceMinor) / (100_000_000n * 10_000n);
  return ok({
    dv01Minor: dv,
    approximation: { kind: "linear", assumesParallelShift: true, validForShockBpsUpTo },
    methodRef: M,
  });
}

// ── §16.6.3 · settlement exposure: gross, always ────────────────────────────

export interface SettlementExposure {
  readonly kind: "settlement-exposure"; // its own field; never enters netting
  readonly counterpartyRef: string;
  readonly grossMinor: bigint;
  readonly monotone: true;
  readonly methodRef: MethodRef;
}

/** CP-1: on a settlement date the full gross principal is at risk in the
 * window BEFORE net settlement occurs — no netting agreement changes that.
 * G-20: no code path passes a settlement exposure into a netting function. */
export function settlementExposure(counterpartyRef: string, deliveredLegsMinor: readonly bigint[]): SettlementExposure {
  return {
    kind: "settlement-exposure",
    counterpartyRef,
    grossMinor: deliveredLegsMinor.reduce((a, v) => a + (v < 0n ? -v : v), 0n),
    monotone: true,
    methodRef: RISK_METHODS.settlement,
  };
}

// ── §16.9 · VaR and ES: gated, and VaR never aggregates ─────────────────────

export interface DistributionAssumption {
  readonly family: string;
  readonly estimationMethod: string;
  readonly estimationWindow: string;
  readonly dataSetRef: string;
  readonly goodnessOfFit: { readonly test: string; readonly statistic: string; readonly outcome: string };
  readonly governanceAcceptanceRef: string;
}

/** Nominal VaR result: the brand field means two of these cannot be summed by
 * arithmetic on their contents without going through combineVar — which
 * refuses (G-22). */
export interface VarResult {
  readonly __brand: "var-result-no-arithmetic";
  readonly lossAtQuantileMinor: bigint;
  readonly scenarioSetRef: { readonly setId: string; readonly digest: string };
  readonly horizon: string;
  readonly confidencePermille: number;
  readonly observationCount: number;
  readonly revaluation: "full" | "delta" | "delta-gamma";
  readonly limitations: readonly string[];
  readonly methodRef: MethodRef;
}

export function historicalVar(inputs: {
  readonly coverageState: CoverageState;
  readonly scenarioSet: { readonly setId: string; readonly digest: string; readonly lossesMinor: readonly bigint[] } | undefined;
  readonly horizon: string | undefined;
  readonly confidencePermille: number | undefined;
  readonly revaluation: "full" | "delta" | "delta-gamma" | undefined;
  /** Required, populated, not defaulted. */
  readonly limitations: readonly string[] | undefined;
}): Result<VarResult> {
  const M = RISK_METHODS.varHistorical;
  const gates: string[] = [];
  if (inputs.coverageState !== "complete") gates.push("coverageState must be complete: VaR depends on offsets, so partial positions make it meaningless");
  if (inputs.scenarioSet === undefined) gates.push("a named, versioned scenario set with a digest");
  if (inputs.horizon === undefined) gates.push("stated horizon");
  if (inputs.confidencePermille === undefined) gates.push("stated confidence level");
  if (inputs.revaluation === undefined) gates.push("full revaluation or a declared approximation");
  if (inputs.limitations === undefined || inputs.limitations.length === 0) gates.push("a populated limitations block");
  if (gates.length > 0) {
    return refuse("var_gates_not_met", M, `Ungated VaR is not produced. Missing: ${gates.join("; ")}.`);
  }
  const losses = [...inputs.scenarioSet!.lossesMinor].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = Math.min(
    losses.length - 1,
    Math.max(0, Math.ceil((inputs.confidencePermille! / 1000) * losses.length) - 1),
  );
  return ok({
    __brand: "var-result-no-arithmetic",
    lossAtQuantileMinor: losses[index]!,
    scenarioSetRef: { setId: inputs.scenarioSet!.setId, digest: inputs.scenarioSet!.digest },
    horizon: inputs.horizon!,
    confidencePermille: inputs.confidencePermille!,
    observationCount: losses.length,
    revaluation: inputs.revaluation!,
    limitations: inputs.limitations!,
    methodRef: M,
  });
}

/** §16.9.4: parametric VaR resolves ONLY with a documented distribution;
 * registered so a caller receives a typed refusal explaining why rather than
 * building one outside the engine. */
export function parametricVar(assumption: DistributionAssumption | undefined): Result<never> {
  return refuse(
    "distribution_assumption_undocumented",
    RISK_METHODS.varHistorical,
    assumption === undefined
      ? "No DistributionAssumption: family, estimation method, window, data set, goodness-of-fit result and a Governance acceptance are all required. An assumed normal is not a statistical distribution."
      : "Parametric VaR is registered but not implemented in kernel scope; historical simulation is the supported form.",
  ) as Result<never>;
}

/** VAR-AGG-1: NO operation combines two VaR figures — VaR is not subadditive,
 * so the sum can be LESS than the true portfolio VaR. A portfolio VaR is
 * computed from the joint position set or it is not computed. */
export function combineVar(_a: VarResult, _b: VarResult): Result<never> {
  return refuse(
    "var_aggregation_forbidden",
    RISK_METHODS.varHistorical,
    "Summing desk-level VaRs is not conservative: VaR violates subadditivity, so the sum can understate the portfolio VaR. Compute from the joint position set.",
  ) as Result<never>;
}

/** ES-AGG-1: expected shortfall IS coherent, so combining is sound — but only
 * over an identical scenario set. Digest equality is required. */
export function combineEs(
  figures: readonly { esMinor: bigint; scenarioSetDigest: string }[],
): Result<{ combinedEsMinor: bigint; scenarioSetDigest: string }> {
  const M = RISK_METHODS.esHistorical;
  const digests = new Set(figures.map((f) => f.scenarioSetDigest));
  if (digests.size > 1) {
    return refuse("scenario_set_mismatch", M, "Two ES figures over different scenario sets are two answers to different questions.");
  }
  return ok({
    combinedEsMinor: figures.reduce((a, f) => a + f.esMinor, 0n),
    scenarioSetDigest: [...digests][0] ?? "",
  });
}

/** §16.9.8: a 7.41-route disclosure with an empty limitations block does not
 * render — the standard makes the disclosure conditional on the explanation,
 * and so does the engine. */
export function disclosureIfrs741(
  varResult: VarResult,
  methodologyDescription: string,
): Result<{ disclosure: { methodology: string; limitations: readonly string[]; lossAtQuantileMinor: bigint } }> {
  const M = RISK_METHODS.varHistorical;
  if (varResult.limitations.length === 0 || methodologyDescription.trim() === "") {
    return refuse("disclosure_limitations_block_required", M, "IFRS 7.41 permits the VaR route only with methodology AND limitations disclosed.");
  }
  return ok({
    disclosure: {
      methodology: methodologyDescription,
      limitations: varResult.limitations,
      lossAtQuantileMinor: varResult.lossAtQuantileMinor,
    },
  });
}

// ── §16.11 · deterministic stress: named, immutable, honest over coverage ───

export interface StressScenarioSet {
  readonly setId: string;
  readonly version: string;
  readonly digest: string;
  readonly rationale: string;
  readonly authoredBy: string;
  readonly shocks: readonly { riskFactorRef: string; shockBps: number; liquidityHorizonDays: number }[];
}

export type StressResult =
  | { readonly basis: "complete"; readonly stressLossMinor: bigint; readonly scenarioSetRef: string }
  | {
      /** STRESS-1: over incomplete coverage the field is contributedStressLoss,
       * never stressLoss. */
      readonly basis: "partial";
      readonly contributedStressLossMinor: bigint;
      readonly scenarioSetRef: string;
    };

export function deterministicStress(
  scenarioSet: StressScenarioSet,
  coverageState: CoverageState,
  positionLossesMinor: readonly bigint[],
): StressResult {
  const loss = positionLossesMinor.reduce((a, v) => a + v, 0n);
  return coverageState === "complete"
    ? { basis: "complete", stressLossMinor: loss, scenarioSetRef: `${scenarioSet.setId}@${scenarioSet.version}` }
    : { basis: "partial", contributedStressLossMinor: loss, scenarioSetRef: `${scenarioSet.setId}@${scenarioSet.version}` };
}
