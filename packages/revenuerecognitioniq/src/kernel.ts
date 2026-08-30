// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { divideAndRound, type MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// RevenueRecognitionIQ kernel — §16. The boundary lock: BILLING IS NOT
// REVENUE. An invoice raised is a BillingIQ fact; revenue earned is this
// engine's fact; cash received is ReceivablesIQ's. Three engines, three
// truths, deliberately never merged.
//
// The recurring shape here: every judgement the standard reserves arrives as
// an evidenced Finding, and an ABSENT finding refuses — it never defaults to
// met, to "no risk", or to ratable. The constraint refusal (M-6) is the most
// consequential in the engine: the alternative is a system that fully
// includes variable consideration because nobody filled in a form.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const REVREC_METHODS = {
  contractIdentification: method("revrec.contract.identification"),
  pobIdentification: method("revrec.pob.identification"),
  transactionPrice: method("revrec.price.transaction"),
  variableExpectedValue: method("revrec.variable.expected-value"),
  variableMostLikely: method("revrec.variable.most-likely-amount"),
  variableConstraint: method("revrec.variable.constraint"),
  sspObservable: method("revrec.ssp.observable"),
  sspResidual: method("revrec.ssp.residual"),
  allocationRelativeSsp: method("revrec.allocation.relative-ssp"),
  allocationDiscount: method("revrec.allocation.discount"),
  allocationVariable: method("revrec.allocation.variable"),
  satisfactionClassification: method("revrec.satisfaction.classification"),
  progressCostToCost: method("revrec.progress.input.cost-to-cost"),
  progressZeroProfit: method("revrec.progress.zero-profit"),
  registry: method("revrec.methods.registry"),
} as const satisfies Record<string, MethodRef>;

export const REVREC_REFUSAL_KINDS = [
  "contract-criteria-incomplete",
  "distinctness-undetermined",
  "estimation-method-unselected",
  "constraint-evidence-insufficient",
  "royalty-exception-unlicensed",
  "ssp-corridor-coverage-insufficient",
  "residual-conditions-unmet",
  "residual-result-implausible",
  "no-ssp-evidence",
  "ssp-sum-zero",
  "allocation-assertion-failed",
  "over-time-criterion-unevidenced",
  "progress-unmeasurable",
] as const;
export type RevRecRefusalKind = (typeof REVREC_REFUSAL_KINDS)[number];

export interface RevRecRefusal {
  readonly kind: RevRecRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: RevRecRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: RevRecRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

/** An evidenced judgement. Absent findings refuse — never default. */
export interface Finding {
  readonly met: boolean;
  readonly evidenceRef: string;
}

// ── M-1 · contract identification: five criteria, collectibility gate ───────

export interface ContractCriteria {
  readonly approvalAndCommitment?: Finding;
  readonly identifiableRights?: Finding;
  readonly identifiablePaymentTerms?: Finding;
  readonly commercialSubstance?: Finding;
  /** The ONLY point at which credit enters this engine — once, at inception. */
  readonly collectibilityProbable?: Finding;
}

export function identifyContract(
  criteria: ContractCriteria,
): Result<{ state: "contract" | "not-a-contract" }> {
  const M = REVREC_METHODS.contractIdentification;
  const entries = Object.entries(criteria) as [string, Finding | undefined][];
  const names = [
    "approvalAndCommitment",
    "identifiableRights",
    "identifiablePaymentTerms",
    "commercialSubstance",
    "collectibilityProbable",
  ];
  const missing = names.filter((n) => criteria[n as keyof ContractCriteria] === undefined);
  if (missing.length > 0) {
    return refuse(
      "contract-criteria-incomplete",
      M,
      `Missing findings: ${missing.join(", ")}. A missing finding does NOT default to met.`,
    );
  }
  const allMet = entries.every(([, f]) => f === undefined || f.met);
  // Failure → not-a-contract; consideration received is a liability (25-7).
  return ok({ state: allMet ? "contract" : "not-a-contract" });
}

// ── M-4/M-5/M-6 · variable consideration and THE constraint ─────────────────

export type EstimationMethod = "expected-value" | "most-likely-amount";

export function estimateVariable(input: {
  readonly method: EstimationMethod | undefined;
  /** Outcomes with probability in basis points; probabilities must sum to 10000. */
  readonly outcomes: readonly { amountMinor: bigint; probabilityBps: number }[];
}): Result<{ rawEstimateMinor: bigint; methodRef: MethodRef }> {
  const M =
    input.method === "expected-value"
      ? REVREC_METHODS.variableExpectedValue
      : REVREC_METHODS.variableMostLikely;
  if (input.method === undefined) {
    // The selection is exactly what an SEC comment letter asks about; the
    // engine will not choose for the entity.
    return refuse(
      "estimation-method-unselected",
      REVREC_METHODS.variableExpectedValue,
      "expected-value or most-likely-amount is the entity's selection with a recorded basis. Nothing is derived.",
    );
  }
  if (input.method === "expected-value") {
    const totalBps = input.outcomes.reduce((a, o) => a + o.probabilityBps, 0);
    if (totalBps !== 10000) {
      return refuse(
        "constraint-evidence-insufficient",
        M,
        `Probabilities sum to ${totalBps} bps, not 10000. A distribution that does not sum to one is not a distribution.`,
      );
    }
    const weighted = input.outcomes.reduce(
      (a, o) => a + o.amountMinor * BigInt(o.probabilityBps),
      0n,
    );
    return ok({ rawEstimateMinor: divideAndRound(weighted, 10000n, "half-even"), methodRef: M });
  }
  const mostLikely = [...input.outcomes].sort(
    (a, b) => b.probabilityBps - a.probabilityBps || Number(a.amountMinor - b.amountMinor),
  )[0];
  if (!mostLikely) {
    return refuse("constraint-evidence-insufficient", M, "An empty outcome set estimates nothing.");
  }
  return ok({ rawEstimateMinor: mostLikely.amountMinor, methodRef: M });
}

export interface ConstraintFactors {
  readonly outsideInfluence?: Finding;
  readonly longResolutionPeriod?: Finding;
  readonly limitedExperience?: Finding;
  readonly concessionPractice?: Finding;
  readonly broadRange?: Finding;
}

/**
 * M-6: include variable consideration only to the extent a significant
 * reversal is probable NOT to occur. ANY absent factor finding refuses —
 * absence is never "no risk". The policy expresses magnitude sensitivity:
 * the more risk factors met, the smaller the includable fraction.
 */
export function applyConstraint(
  rawEstimateMinor: bigint,
  factors: ConstraintFactors,
  /** Includable fraction in bps per count of risk factors met, index 0..5. */
  policyIncludableBpsByRiskCount: readonly number[],
): Result<{ constrainedMinor: bigint; riskFactorsMet: number }> {
  const M = REVREC_METHODS.variableConstraint;
  const names = [
    "outsideInfluence",
    "longResolutionPeriod",
    "limitedExperience",
    "concessionPractice",
    "broadRange",
  ] as const;
  const missing = names.filter((n) => factors[n] === undefined);
  if (missing.length > 0) {
    return refuse(
      "constraint-evidence-insufficient",
      M,
      `Missing factor findings: ${missing.join(", ")}. Absence is not 'no risk' — the alternative is full inclusion because nobody filled in a form.`,
    );
  }
  const riskFactorsMet = names.filter((n) => factors[n]?.met === true).length;
  const bps = policyIncludableBpsByRiskCount[riskFactorsMet];
  if (bps === undefined) {
    return refuse("constraint-evidence-insufficient", M, "The policy does not cover this risk count.");
  }
  const constrained = divideAndRound(rawEstimateMinor * BigInt(bps), 10000n, "half-even");
  return ok({
    constrainedMinor: constrained <= rawEstimateMinor ? constrained : rawEstimateMinor,
    riskFactorsMet,
  });
}

/** 606-10-55-65: the royalty exception applies to IP LICENCES only — gated on a recorded licence finding. */
export function royaltyException(licenceFinding: Finding | undefined): Result<"defer-to-usage"> {
  const M = REVREC_METHODS.variableConstraint;
  if (licenceFinding === undefined || !licenceFinding.met) {
    return refuse(
      "royalty-exception-unlicensed",
      M,
      "The sales/usage-based royalty exception is narrow — IP licences only — and needs a recorded licence finding.",
    );
  }
  return ok("defer-to-usage");
}

// ── M-7/M-10 · SSP: observable corridor and the gated residual ──────────────

export interface CorridorPolicy {
  readonly minimumObservations: number;
  readonly toleranceBps: number;
  readonly requiredCoverageBps: number;
}

export function observableSsp(
  observations: readonly bigint[],
  policy: CorridorPolicy,
): Result<{ sspMinor: bigint }> {
  const M = REVREC_METHODS.sspObservable;
  if (observations.length < policy.minimumObservations) {
    return refuse(
      "ssp-corridor-coverage-insufficient",
      M,
      `${observations.length} observations against a minimum of ${policy.minimumObservations}.`,
    );
  }
  const sorted = [...observations].sort((a, b) => (a < b ? -1 : 1));
  const median = sorted[Math.floor(sorted.length / 2)] as bigint;
  const tolerance = divideAndRound(median * BigInt(policy.toleranceBps), 10000n, "half-even");
  const inside = observations.filter(
    (o) => (o >= median ? o - median : median - o) <= tolerance,
  ).length;
  const coverageBps = Math.floor((inside * 10000) / observations.length);
  if (coverageBps < policy.requiredCoverageBps) {
    // The method does NOT return a wider band; a failure is a refusal, not a
    // "suggested invalid" status a user can click past.
    return refuse(
      "ssp-corridor-coverage-insufficient",
      M,
      `Coverage ${coverageBps} bps inside the tolerance band, below the required ${policy.requiredCoverageBps}.`,
    );
  }
  return ok({ sspMinor: median });
}

export function residualSsp(input: {
  readonly transactionPriceMinor: bigint;
  readonly observableOtherSspsMinor: readonly bigint[];
  readonly highlyVariableFinding?: Finding;
  readonly priceNotEstablishedFinding?: Finding;
}): Result<{ sspMinor: bigint }> {
  const M = REVREC_METHODS.sspResidual;
  const gate =
    input.highlyVariableFinding?.met === true || input.priceNotEstablishedFinding?.met === true;
  if (!gate) {
    // The residual approach always produces a number, which is why it is the
    // most abused SSP method in practice. The narrow conditions are an
    // evidenced gate, not a formality.
    return refuse(
      "residual-conditions-unmet",
      M,
      "32-34(c): the residual approach needs an evidenced finding of a highly-variable price or a not-yet-established price.",
    );
  }
  const residual =
    input.transactionPriceMinor - input.observableOtherSspsMinor.reduce((a, b) => a + b, 0n);
  if (residual <= 0n) {
    return refuse(
      "residual-result-implausible",
      M,
      `The residual is ${residual} minor units. A zero-or-negative residual is reassessed, not accepted.`,
    );
  }
  return ok({ sspMinor: residual });
}

// ── M-11 · relative-SSP allocation: exact, order-independent, monotone ──────

export interface AllocationResult {
  readonly allocations: readonly { obligationId: string; allocatedMinor: bigint }[];
}

export function allocateRelativeSsp(
  transactionPriceMinor: bigint,
  obligations: readonly { obligationId: string; sspMinor: bigint; ordinal: number }[],
): Result<AllocationResult> {
  const M = REVREC_METHODS.allocationRelativeSsp;
  if (obligations.some((o) => o.sspMinor < 0n)) {
    return refuse("no-ssp-evidence", M, "A negative SSP is not evidence of anything.");
  }
  const total = obligations.reduce((a, o) => a + o.sspMinor, 0n);
  if (total === 0n) {
    return refuse("ssp-sum-zero", M, "Σ SSP is zero; nothing can be allocated proportionately.");
  }
  const rows = obligations.map((o) => {
    const numerator = transactionPriceMinor * o.sspMinor;
    return {
      obligationId: o.obligationId,
      ordinal: o.ordinal,
      floor: numerator / total,
      remainderNumerator: numerator % total,
    };
  });
  let residue = transactionPriceMinor - rows.reduce((a, r) => a + r.floor, 0n);
  const byRemainder = [...rows].sort(
    (a, b) =>
      (b.remainderNumerator > a.remainderNumerator
        ? 1
        : b.remainderNumerator < a.remainderNumerator
          ? -1
          : 0) || a.ordinal - b.ordinal,
  );
  const bonus = new Map<string, bigint>();
  for (const row of byRemainder) {
    if (residue === 0n) break;
    bonus.set(row.obligationId, 1n);
    residue -= 1n;
  }
  const allocations = rows.map((r) => ({
    obligationId: r.obligationId,
    allocatedMinor: r.floor + (bonus.get(r.obligationId) ?? 0n),
  }));
  // By construction the largest-remainder distribution sums exactly, so this
  // assertion is a TRIPWIRE against a future edit to the distribution, not a
  // reachable branch today — mutation `allocation-assertion-tautologised`
  // survives as an equivalent mutant, recorded here honestly (the same
  // classification as ReceivablesIQ's R2 and R-1 tripwires).
  const sum = allocations.reduce((a, r) => a + r.allocatedMinor, 0n);
  if (sum !== transactionPriceMinor) {
    return refuse(
      "allocation-assertion-failed",
      M,
      `Σ allocated (${sum}) ≠ transaction price (${transactionPriceMinor}). Refused rather than emitted unbalanced.`,
    );
  }
  return ok({ allocations });
}

// ── M-12/M-13 · discount and variable allocation: fallback RECORDED ─────────

export function allocateDiscount(input: {
  readonly regularStandaloneSales?: Finding;
  readonly regularBundleSales?: Finding;
  readonly substantiallySameDiscount?: Finding;
}): { target: "specific-obligations" | "proportionate"; fallbackRecorded?: string } {
  const allThree =
    input.regularStandaloneSales?.met === true &&
    input.regularBundleSales?.met === true &&
    input.substantiallySameDiscount?.met === true;
  if (allThree) return { target: "specific-obligations" };
  // Proportionate allocation is the standard's own default — not a refusal —
  // but the fallback is RECORDED, not silent.
  const missing = (["regularStandaloneSales", "regularBundleSales", "substantiallySameDiscount"] as const)
    .filter((k) => input[k]?.met !== true)
    .join(", ");
  return {
    target: "proportionate",
    fallbackRecorded: `32-37 conditions not all met (${missing}); allocated proportionately per the standard's default.`,
  };
}

export function allocateVariableToObligation(input: {
  readonly relatesSpecifically?: Finding;
  readonly consistentWithObjective?: Finding;
}): { path: "specific-allocation" | "into-transaction-price"; recorded: string } {
  const both = input.relatesSpecifically?.met === true && input.consistentWithObjective?.met === true;
  return both
    ? { path: "specific-allocation", recorded: "32-40 criteria both evidenced." }
    : {
        path: "into-transaction-price",
        recorded:
          "32-40 criteria not both evidenced: the variable amount enters the transaction price and allocates on relative SSP — a materially different answer, recorded.",
      };
}

// ── M-14 · satisfaction classification: NO default to ratable ───────────────

export interface SatisfactionEvidence {
  readonly simultaneousConsumption?: Finding;
  readonly customerControlsAsset?: Finding;
  /** Criterion (c) needs BOTH halves. */
  readonly noAlternativeUse?: Finding;
  readonly enforceableRightToPayment?: Finding;
  /** Point-in-time control transfer event (25-30 indicators). */
  readonly controlTransferEvidenced?: Finding;
}

export function classifySatisfaction(
  evidence: SatisfactionEvidence,
): Result<{ pattern: "over-time" | "point-in-time" }> {
  const M = REVREC_METHODS.satisfactionClassification;
  const overTime =
    evidence.simultaneousConsumption?.met === true ||
    evidence.customerControlsAsset?.met === true ||
    (evidence.noAlternativeUse?.met === true && evidence.enforceableRightToPayment?.met === true);
  if (overTime) return ok({ pattern: "over-time" });
  if (evidence.controlTransferEvidenced?.met === true) return ok({ pattern: "point-in-time" });
  // Defaulting to ratable is the most common shortcut in subscription
  // products — often right for the subscription, wrong for everything else
  // in the same contract.
  return refuse(
    "over-time-criterion-unevidenced",
    M,
    "No over-time criterion is evidenced and no control-transfer event is evidenced. It does NOT default to ratable.",
  );
}

// ── M-15/M-17 · progress and the zero-profit method ─────────────────────────

export function costToCostProgress(input: {
  readonly costIncurredMinor: bigint;
  readonly uninstalledMaterialsMinor: bigint;
  readonly wastedCostsMinor: bigint;
  readonly totalEstimatedCostMinor: bigint;
}): Result<{ progressBps: number; uninstalledAtCostMinor: bigint }> {
  const M = REVREC_METHODS.progressCostToCost;
  const adjustedIncurred =
    input.costIncurredMinor - input.uninstalledMaterialsMinor - input.wastedCostsMinor;
  const adjustedTotal = input.totalEstimatedCostMinor - input.uninstalledMaterialsMinor;
  if (adjustedTotal <= 0n) {
    return refuse("progress-unmeasurable", M, "The adjusted total estimated cost is not positive.");
  }
  const bps = Number((adjustedIncurred * 10000n) / adjustedTotal);
  return ok({
    // Uninstalled materials: revenue AT COST, zero margin (55-21) — failing
    // this systematically overstates early construction revenue.
    progressBps: bps > 10000 ? 10000 : bps,
    uninstalledAtCostMinor: input.uninstalledMaterialsMinor,
  });
}

/** Over-time revenue with cumulative catch-up. Rounded once per measurement. */
export function recognizeOverTime(input: {
  readonly allocatedMinor: bigint;
  readonly progressBps: number;
  readonly previouslyRecognizedMinor: bigint;
  readonly uninstalledAtCostMinor?: bigint;
}): { cumulativeMinor: bigint; catchUpMinor: bigint } {
  const cumulative =
    divideAndRound(input.allocatedMinor * BigInt(input.progressBps), 10000n, "half-even") +
    (input.uninstalledAtCostMinor ?? 0n);
  return { cumulativeMinor: cumulative, catchUpMinor: cumulative - input.previouslyRecognizedMinor };
}
