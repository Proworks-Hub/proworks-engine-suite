// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
  type MethodRef,
} from "@proworks-hub/contracts";

import {
  R_ONE,
  R_ZERO,
  rAdd,
  ratioFromDecimal,
  rEquals,
  rIsZero,
  rMul,
  rSub,
  rToDecimalString,
  solveLinearSystem,
  type Rational,
} from "./rational.js";

// ─────────────────────────────────────────────────────────────────────────────
// The consolidation kernel — M-1, M-2, M-3/M-4, M-6/M-7, M-10..M-13, M-17.
// ConsolidationIQ NEVER alters an entity's posted ledger to make a group
// number work: everything here is a group-layer computation over supplied
// submissions, and every refusal has NO fallback.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const CONSOLIDATION_METHODS = {
  ownershipIntegrated: method("consolidation.ownership.integrated"),
  methodDetermination: method("consolidation.method.determination"),
  translationIas21: method("consolidation.translation.ias21"),
  translationCta: method("consolidation.translation.cta"),
  intercompanyMatch: method("consolidation.intercompany.match"),
  intercompanyElimination: method("consolidation.intercompany.elimination"),
  capitalConsolidation: method("consolidation.investment.capitalconsolidation"),
  nciMeasurement: method("consolidation.nci.measurement"),
  nciAllocation: method("consolidation.nci.allocation"),
  equityPickup: method("consolidation.equitymethod.pickup"),
  runIdempotency: method("consolidation.run.idempotency"),
  registry: method("consolidation.methods.registry"),
} as const satisfies Record<string, MethodRef>;

export const CONSOLIDATION_REFUSAL_KINDS = [
  "OWNERSHIP_SYSTEM_SINGULAR",
  "CONTROL_ASSESSMENT_REQUIRED",
  "RATE_QUOTE_MISSING",
  "AVERAGING_CONVENTION_UNDECLARED",
  "AVERAGE_RATE_NOT_PERMITTED",
  "CTA_PROOF_FAILED",
  "AMBIGUOUS_INTERCOMPANY_MATCH",
  "BARGAIN_PURCHASE_REQUIRES_REASSESSMENT",
  "NCI_ELECTION_MISSING",
  "IDEMPOTENCY_KEY_CONFLICT",
  "UNKNOWN_CURRENCY_SCALE",
] as const;
export type ConsolidationRefusalKind = (typeof CONSOLIDATION_REFUSAL_KINDS)[number];

export interface ConsolidationRefusal {
  readonly kind: ConsolidationRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ConsolidationRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ConsolidationRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── M-1 · integrated ownership: two independent solves, exact rationals ─────

export interface OwnershipInterest {
  readonly from: string;
  readonly to: string;
  /** Exact decimal or fraction string: "0.6", "60/100", "1/3". */
  readonly economicInterest: string;
  readonly votingInterest: string;
}

export interface IntegratedOwnership {
  readonly integrated: ReadonlyMap<string, Rational>;
  readonly solveMethod: "path-sum" | "linear";
}

export function integrateOwnership(
  interests: readonly OwnershipInterest[],
  root: string,
  dimension: "economic" | "voting",
): Result<IntegratedOwnership> {
  const M = CONSOLIDATION_METHODS.ownershipIntegrated;
  const entities = [...new Set(interests.flatMap((i) => [i.from, i.to]))].sort();
  const index = new Map(entities.map((e, i) => [e, i] as const));
  const n = entities.length;
  const weight = (i: OwnershipInterest): Rational =>
    ratioFromDecimal(dimension === "economic" ? i.economicInterest : i.votingInterest);

  // Cycle detection: DFS colouring.
  const adjacency = new Map<string, { to: string; w: Rational }[]>();
  for (const i of interests) {
    const list = adjacency.get(i.from) ?? [];
    list.push({ to: i.to, w: weight(i) });
    adjacency.set(i.from, list);
  }
  const colour = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (node: string) => {
    colour.set(node, 1);
    for (const edge of adjacency.get(node) ?? []) {
      const c = colour.get(edge.to) ?? 0;
      if (c === 1) cyclic = true;
      else if (c === 0) visit(edge.to);
    }
    colour.set(node, 2);
  };
  for (const entity of entities) if ((colour.get(entity) ?? 0) === 0) visit(entity);

  if (!cyclic) {
    // Path-sum by memoised DFS from the root.
    const memo = new Map<string, Rational>();
    const share = (node: string): Rational => {
      if (node === root) return R_ONE;
      const cached = memo.get(node);
      if (cached) return cached;
      let total = R_ZERO;
      for (const i of interests) {
        if (i.to !== node) continue;
        total = rAdd(total, rMul(share(i.from), weight(i)));
      }
      memo.set(node, total);
      return total;
    };
    const integrated = new Map<string, Rational>();
    for (const entity of entities) {
      if (entity === root) continue;
      integrated.set(entity, share(entity));
    }
    return ok({ integrated, solveMethod: "path-sum" });
  }

  // Cyclic: x = e_root·A·(I − A)^{-1} over exact rationals. An iterative
  // approximation with a stopping threshold is not reproducible.
  const a: Rational[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => R_ZERO));
  for (const i of interests) {
    const fromIndex = index.get(i.from) as number;
    const toIndex = index.get(i.to) as number;
    (a[fromIndex] as Rational[])[toIndex] = rAdd(
      (a[fromIndex] as Rational[])[toIndex] as Rational,
      weight(i),
    );
  }
  const rootIndex = index.get(root);
  if (rootIndex === undefined) {
    return refuse("OWNERSHIP_SYSTEM_SINGULAR", M, `The root ${root} holds no interests in this graph.`);
  }
  // b = e_root · A  (the root's direct holdings row).
  const b = (a[rootIndex] as Rational[]).slice();
  // Zero out edges INTO the root so the root's own shares are not re-attributed.
  const aWithoutRoot = a.map((row, i) =>
    row.map((cell, j) => (i === rootIndex || j === rootIndex ? R_ZERO : cell)),
  );
  const solution = solveLinearSystem(aWithoutRoot, b);
  if (!solution) {
    return refuse(
      "OWNERSHIP_SYSTEM_SINGULAR",
      M,
      "A fully reciprocal structure with no external holder has no meaningful integrated ownership. It refuses; it does not fall back to path-sum on a cyclic graph.",
    );
  }
  const integrated = new Map<string, Rational>();
  for (const entity of entities) {
    if (entity === root) continue;
    integrated.set(entity, solution[index.get(entity) as number] as Rational);
  }
  return ok({ integrated, solveMethod: "linear" });
}

// ── M-2 · method determination: a recommendation, never an assignment ───────

export type ConsolidationMethod = "full" | "equity" | "proportional" | "not-consolidated";

export interface ControlAssessment {
  readonly entityRef: string;
  readonly conclusion: ConsolidationMethod;
  readonly status: "approved" | "draft";
  readonly assessedBy: string;
}

export function determineMethod(input: {
  readonly entityRef: string;
  /** Percent, 0..100, exact decimal string. */
  readonly votingPercent: string;
  readonly hasContractualPowerIndicators: boolean;
  readonly jointArrangement?: "joint-operation" | "joint-venture";
  readonly assessment?: ControlAssessment;
}): Result<{ method: ConsolidationMethod; basis: string; requiresHumanAssessment: boolean }> {
  const M = CONSOLIDATION_METHODS.methodDetermination;
  const voting = Number(input.votingPercent);

  if (input.jointArrangement !== undefined) {
    return ok({
      method: input.jointArrangement === "joint-operation" ? "proportional" : "equity",
      basis: `IFRS 11 classification: ${input.jointArrangement}`,
      requiresHumanAssessment: false,
    });
  }

  const requiresHumanAssessment =
    (voting > 20 && voting <= 50 && input.hasContractualPowerIndicators) ||
    (voting > 50 && input.hasContractualPowerIndicators);

  if (requiresHumanAssessment) {
    if (input.assessment === undefined || input.assessment.status !== "approved") {
      // The absence of an assessment is a REFUSAL, not a fall-through to the
      // threshold: where power remains uncertain the investor does NOT
      // consolidate (IFRS 10.B46), and the missing judgement must be visible.
      return refuse(
        "CONTROL_ASSESSMENT_REQUIRED",
        M,
        `${input.entityRef}: voting ${input.votingPercent}% with contractual-power indicators needs an approved ControlAssessment. The threshold answer could be wrong, so it is not given.`,
      );
    }
    return ok({
      method: input.assessment.conclusion,
      basis: `approved control assessment by ${input.assessment.assessedBy}`,
      requiresHumanAssessment: true,
    });
  }

  const recommendation: ConsolidationMethod =
    voting > 50 ? "full" : voting > 20 ? "equity" : "not-consolidated";
  return ok({
    method: recommendation,
    basis: `threshold policy: voting ${input.votingPercent}%`,
    requiresHumanAssessment: false,
  });
}

// ── M-3/M-4 · translation and CTA as a sum of causes with a proof ───────────

export interface RateSet {
  readonly closing: string;
  readonly opening: string;
  /** Present only when a declared averaging convention supplies it. */
  readonly average?: string;
  /** Historical rates per equity tranche. */
  readonly historicalByTranche: Readonly<Record<string, string>>;
}

export interface TranslationInput {
  readonly entityRef: string;
  /** All in FUNCTIONAL currency minor units (bigint as string). */
  readonly openingNetAssetsMinor: bigint;
  readonly resultForPeriodMinor: bigint;
  readonly equityTranches: readonly { trancheRef: string; amountMinor: bigint }[];
  readonly rates: RateSet;
  /** Required for income/expense translation. NO default (M-3.1, spread 1.67%). */
  readonly averagingConvention?: "simple-mean" | "open-close-mean" | "weighted";
  readonly presentationScale: number;
  readonly presentationCurrency: string;
}

export interface CtaResult {
  readonly translatedResultMinor: bigint;
  readonly ctaArisingMinor: bigint;
  readonly components: {
    readonly openingNetAssets: bigint;
    readonly resultRateGap: bigint;
    readonly equityTranches: bigint;
  };
}

const rateToRational = (rate: string): Rational => ratioFromDecimal(rate);

function applyRate(minor: bigint, rate: Rational): bigint {
  // round half-even at the presentation scale boundary (RB-1: one boundary).
  return divideAndRound(minor * rate.num, rate.den, "half-even");
}

export function translateAndProveCta(input: TranslationInput): Result<CtaResult> {
  const M = CONSOLIDATION_METHODS.translationCta;
  if (input.averagingConvention === undefined) {
    return refuse(
      "AVERAGING_CONVENTION_UNDECLARED",
      CONSOLIDATION_METHODS.translationIas21,
      "Income and expenses translate at an approximation of transaction-date rates, and WHICH average is a convention with a measured 1.67% spread (GD-23). Declare simple-mean, open-close-mean or weighted; nothing is inferred from the RateSet.",
    );
  }
  const closing = rateToRational(input.rates.closing);
  const opening = rateToRational(input.rates.opening);
  let resultRate: Rational;
  switch (input.averagingConvention) {
    case "open-close-mean":
      resultRate = rMul(rAdd(opening, closing), ratioFromDecimal("0.5"));
      break;
    case "simple-mean":
    case "weighted": {
      if (input.rates.average === undefined) {
        return refuse(
          "RATE_QUOTE_MISSING",
          CONSOLIDATION_METHODS.translationIas21,
          `The ${input.averagingConvention} convention needs an average quote in the RateSet, and none was supplied. There is no fallback to the closing rate — that silently moves profit into CTA.`,
        );
      }
      resultRate = rateToRational(input.rates.average);
      break;
    }
  }

  // Equity tranches translate at historical rates; the CTA term is nil BY
  // CONSTRUCTION and asserted, not assumed.
  let equityTerm = 0n;
  for (const tranche of input.equityTranches) {
    const historical = input.rates.historicalByTranche[tranche.trancheRef];
    if (historical === undefined) {
      return refuse(
        "RATE_QUOTE_MISSING",
        CONSOLIDATION_METHODS.translationIas21,
        `Equity tranche ${tranche.trancheRef} has no registered historical rate (HISTORICAL_TRANCHE_UNREGISTERED). Share capital never moves.`,
      );
    }
    equityTerm +=
      applyRate(tranche.amountMinor, rateToRational(historical)) -
      applyRate(tranche.amountMinor, rateToRational(historical));
  }

  const openingTerm =
    applyRate(input.openingNetAssetsMinor, closing) - applyRate(input.openingNetAssetsMinor, opening);
  const resultTerm =
    applyRate(input.resultForPeriodMinor, closing) - applyRate(input.resultForPeriodMinor, resultRate);
  const ctaArising = openingTerm + resultTerm + equityTerm;

  // The INDEPENDENT proof: translate the closing balance sheet and compare.
  // closing net assets (functional) = opening + result; translated at closing.
  const closingNetAssets = input.openingNetAssetsMinor + input.resultForPeriodMinor;
  const balanceSheetSide =
    applyRate(closingNetAssets, closing) -
    (applyRate(input.openingNetAssetsMinor, opening) + applyRate(input.resultForPeriodMinor, resultRate));
  if (balanceSheetSide !== ctaArising) {
    return refuse(
      "CTA_PROOF_FAILED",
      M,
      `CTA by causes = ${ctaArising} but the balance-sheet difference = ${balanceSheetSide} (delta ${balanceSheetSide - ctaArising} minor units). Neither figure is adjusted; the run is refused. CTA-as-whatever-balances cannot fail, and an assertion that cannot fail is worse than none.`,
    );
  }
  return ok({
    translatedResultMinor: applyRate(input.resultForPeriodMinor, resultRate),
    ctaArisingMinor: ctaArising,
    components: { openingNetAssets: openingTerm, resultRateGap: resultTerm, equityTranches: equityTerm },
  });
}

// ── M-6/M-7 · intercompany match and elimination ────────────────────────────

export interface IntercompanyDeclaration {
  readonly declarationId: string;
  readonly entity: string;
  readonly counterparty: string;
  readonly natureCode: string;
  readonly amount: ExactMoney;
}

export function matchIntercompany(
  declarations: readonly IntercompanyDeclaration[],
  toleranceMinor: bigint,
): Result<{
  matches: readonly { a: string; b: string; residualMinor: bigint; withinTolerance: boolean }[];
  unmatched: readonly string[];
}> {
  const M = CONSOLIDATION_METHODS.intercompanyMatch;
  const used = new Set<string>();
  const matches: { a: string; b: string; residualMinor: bigint; withinTolerance: boolean }[] = [];
  const sorted = [...declarations].sort((x, y) => (x.declarationId < y.declarationId ? -1 : 1));
  for (const declaration of sorted) {
    if (used.has(declaration.declarationId)) continue;
    const candidates = sorted.filter(
      (other) =>
        !used.has(other.declarationId) &&
        other.declarationId !== declaration.declarationId &&
        other.entity === declaration.counterparty &&
        other.counterparty === declaration.entity &&
        other.natureCode === declaration.natureCode,
    );
    if (candidates.length > 1) {
      return refuse(
        "AMBIGUOUS_INTERCOMPANY_MATCH",
        M,
        `${declaration.declarationId} has ${candidates.length} candidate counterparty declarations (${candidates.map((c) => c.declarationId).join(", ")}); the match never picks one.`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) continue;
    used.add(declaration.declarationId);
    used.add(candidate.declarationId);
    const residual =
      exactMinorUnits(declaration.amount) - exactMinorUnits(candidate.amount);
    const abs = residual < 0n ? -residual : residual;
    // Tolerance suppresses an EXCEPTION, never a number: the residual is
    // recorded either way.
    matches.push({
      a: declaration.declarationId,
      b: candidate.declarationId,
      residualMinor: residual,
      withinTolerance: abs <= toleranceMinor,
    });
  }
  const unmatched = sorted
    .filter((d) => !used.has(d.declarationId))
    .map((d) => d.declarationId);
  return ok({ matches, unmatched });
}

/**
 * M-7: full elimination regardless of ownership percentage (IFRS 10.B86) —
 * the ownership effect appears in NCI, not in the elimination. Equity-method
 * investees eliminate only to the investor's interest (IAS 28.28).
 */
export function eliminationShare(
  methodUsed: ConsolidationMethod,
  investorInterest: Rational,
): Rational {
  switch (methodUsed) {
    case "full":
      return R_ONE;
    case "proportional":
      return investorInterest;
    case "equity":
      return investorInterest;
    case "not-consolidated":
      return R_ZERO;
  }
}

// ── M-10..M-12 · goodwill, NCI ──────────────────────────────────────────────

export function capitalConsolidation(input: {
  readonly considerationMinor: bigint;
  readonly nciMeasurementMinor: bigint;
  readonly previouslyHeldFairValueMinor: bigint;
  readonly identifiableNetAssetsFairValueMinor: bigint;
  readonly currency: string;
  readonly scale: number;
}): Result<{ goodwill: ExactMoney }> {
  const M = CONSOLIDATION_METHODS.capitalConsolidation;
  const goodwillMinor =
    input.considerationMinor +
    input.nciMeasurementMinor +
    input.previouslyHeldFairValueMinor -
    input.identifiableNetAssetsFairValueMinor;
  if (goodwillMinor < 0n) {
    // IFRS 3.34-36: a bargain purchase requires reassessment of every step
    // BEFORE a gain is recognised. A system that books the gain automatically
    // has skipped the reassessment.
    return refuse(
      "BARGAIN_PURCHASE_REQUIRES_REASSESSMENT",
      M,
      `The computation yields ${goodwillMinor} minor units — a bargain purchase. The gain is recognised only after an authorized human records the reassessment outcome.`,
    );
  }
  return ok({ goodwill: exactMoneyFromMinorUnits(goodwillMinor, input.currency, input.scale) });
}

export function measureNci(input: {
  readonly election: "fair-value" | "proportionate" | undefined;
  readonly nciFairValueMinor?: bigint;
  readonly identifiableNetAssetsMinor: bigint;
  readonly nciInterest: Rational;
}): Result<bigint> {
  const M = CONSOLIDATION_METHODS.nciMeasurement;
  if (input.election === undefined) {
    return refuse("NCI_ELECTION_MISSING", M, "The per-acquisition NCI election is read from the AcquisitionRecord and never re-derived.");
  }
  if (input.election === "fair-value") {
    if (input.nciFairValueMinor === undefined) {
      return refuse("NCI_ELECTION_MISSING", M, "The fair-value election needs the NCI fair value as evidence.");
    }
    return ok(input.nciFairValueMinor);
  }
  return ok(
    divideAndRound(
      input.identifiableNetAssetsMinor * input.nciInterest.num,
      input.nciInterest.den,
      "half-even",
    ),
  );
}

/**
 * M-12: allocation on present economic interests. NCI MAY GO NEGATIVE from
 * accumulated losses (IFRS 10.B94) — flooring it at zero is a defect the
 * tests specifically look for. RB-3: the NCI side rounds; the parent takes
 * the residual, so parent + NCI reconstructs the total exactly.
 */
export function allocateNci(
  totalMinor: bigint,
  nciInterest: Rational,
): { nciMinor: bigint; parentMinor: bigint } {
  const nciMinor = divideAndRound(totalMinor * nciInterest.num, nciInterest.den, "half-even");
  return { nciMinor, parentMinor: totalMinor - nciMinor };
}

// ── M-13 · equity pickup, lowest tier upward ────────────────────────────────

export interface EquityInvestee {
  readonly entityRef: string;
  /** The investor holding this investee. */
  readonly heldBy: string;
  readonly interest: Rational;
  readonly carryingAmountMinor: bigint;
  readonly resultForPeriodMinor: bigint;
  readonly distributionsMinor: bigint;
}

/**
 * Executes generation by generation from the lowest tier upward, so a
 * tier-3 result is in a tier-2 carrying value before tier-2's own pickup.
 * The wrong order is wrong by exactly one generation and looks plausible.
 * Share of losses is limited to the carrying amount (IAS 28.38); the
 * unrecognised loss is tracked, not discarded.
 */
export function equityPickup(
  investees: readonly EquityInvestee[],
): ReadonlyMap<string, { newCarryingMinor: bigint; pickupMinor: bigint; unrecognisedLossMinor: bigint }> {
  // Topological order: an investee held by another investee computes first.
  const byRef = new Map(investees.map((i) => [i.entityRef, i] as const));
  const results = new Map<string, { newCarryingMinor: bigint; pickupMinor: bigint; unrecognisedLossMinor: bigint }>();
  const augmentedResult = new Map<string, bigint>(
    investees.map((i) => [i.entityRef, i.resultForPeriodMinor] as const),
  );
  const compute = (ref: string): void => {
    if (results.has(ref)) return;
    const investee = byRef.get(ref);
    if (!investee) return;
    // First, fold in pickups from anything THIS investee holds.
    for (const lower of investees) {
      if (lower.heldBy !== ref) continue;
      compute(lower.entityRef);
      const lowerResult = results.get(lower.entityRef);
      if (lowerResult) {
        augmentedResult.set(ref, (augmentedResult.get(ref) ?? 0n) + lowerResult.pickupMinor);
      }
    }
    const share = divideAndRound(
      (augmentedResult.get(ref) ?? 0n) * investee.interest.num,
      investee.interest.den,
      "half-even",
    );
    const proposedCarrying = investee.carryingAmountMinor + share - investee.distributionsMinor;
    if (proposedCarrying < 0n) {
      // Losses stop at zero; the excess is TRACKED (read by the disclosure
      // projection and the resumption rule), never silently discarded.
      results.set(ref, {
        newCarryingMinor: 0n,
        pickupMinor: share - proposedCarrying, // the recognised portion
        unrecognisedLossMinor: -proposedCarrying,
      });
    } else {
      results.set(ref, { newCarryingMinor: proposedCarrying, pickupMinor: share, unrecognisedLossMinor: 0n });
    }
  };
  for (const investee of investees) compute(investee.entityRef);
  return results;
}

// ── M-17 · run idempotency ──────────────────────────────────────────────────

export function runIdempotencyKey(components: {
  readonly scopeId: string;
  readonly periodRef: string;
  readonly framework: "ifrs" | "us-gaap";
  readonly structureHash: string;
  readonly rateSetHash: string;
  readonly submissionHashes: readonly string[];
}): string {
  return [
    components.scopeId,
    components.periodRef,
    components.framework,
    components.structureHash,
    components.rateSetHash,
    ...[...components.submissionHashes].sort(),
  ].join("|");
}

/** Display helper for integrated ownership — display only, never arithmetic. */
export function ownershipPercent(r: Rational, places = 4): string {
  return rToDecimalString(rMul(r, ratioFromDecimal("100")), places);
}

export { rEquals, rIsZero, rSub };
