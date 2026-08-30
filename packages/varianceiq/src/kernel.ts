// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  R_ZERO,
  rAdd,
  rMul,
  rSub,
  rToDecimalString,
  rational,
  type MethodRef,
  type Rational,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// VarianceIQ kernel — §16. The joint term ΔP·ΔQ belongs to neither price nor
// volume and does not go away; every commercial product assigns it silently,
// and two products can answer "price problem or volume problem?" in opposite
// directions from identical data, both correctly. So the assignment rule — the
// CONVENTION — is a first-class, versioned, REQUIRED argument. No default
// exists anywhere in this source (GUARD-11), the same decomposition is
// re-computed under every convention to report a sensitivity band, and the
// exact reconciliation invariant I-1 holds with zero tolerance: a residual is
// NEVER absorbed into a factor (GUARD-12).
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const VARIANCE_METHODS = {
  compute: method("method.variance.compute"),
  relative: method("method.variance.relative"),
  decompose: method("method.variance.decompose"),
  sensitivity: method("method.variance.sensitivity"),
  materiality: method("method.variance.materiality"),
  fx: method("method.variance.factor.fx"),
  mix: method("method.variance.factor.mix"),
  skeleton: method("method.variance.narrative.skeleton"),
  registry: method("method.variance.registry"),
} as const satisfies Record<string, MethodRef>;

export const VARIANCE_REFUSAL_KINDS = [
  "CONVENTION_UNSELECTED",
  "ORDER_UNDECLARED",
  "FACTOR_SET_UNSUPPORTED_BY_CONVENTION",
  "SHAPLEY_FACTOR_LIMIT",
  "DECOMPOSITION_REQUIRES_FACTORS",
  "DECOMPOSITION_DOES_NOT_RECONCILE",
  "MIX_PORTFOLIO_UNDECLARED",
  "ASYMMETRY_INCOMPLETE",
  "STATISTICAL_BASIS_INVALID",
  "DENOMINATOR_UNSELECTED",
  "FX_KIND_UNSPECIFIED",
] as const;
export type VarianceRefusalKind = (typeof VARIANCE_REFUSAL_KINDS)[number];

export interface VarianceRefusal {
  readonly kind: VarianceRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: VarianceRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: VarianceRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// Rational helpers local to the kernel (dens are >0 by construction).
const rCmp = (a: Rational, b: Rational): -1 | 0 | 1 => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
};
const rAbs = (a: Rational): Rational => (a.num < 0n ? rational(-a.num, a.den) : a);
const rSum = (values: readonly Rational[]): Rational => values.reduce(rAdd, R_ZERO);

// ── §16.2 · the convention registry ─────────────────────────────────────────

export const CONVENTION_IDS = [
  "convention.laspeyres.price-first",
  "convention.paasche.volume-first",
  "convention.joint-explicit",
  "convention.bennet.midpoint",
  "convention.shapley",
  "convention.sequential.declared-order",
] as const;
export type ConventionId = (typeof CONVENTION_IDS)[number];

export interface ConventionRef {
  readonly conventionId: ConventionId;
  readonly semanticVersion: "1.0.0";
  /** Required for sequential.declared-order: the caller-declared factor
   * order. 24 orderings for four factors, up to 24 different answers —
   * making the order a required argument is the minimum honest treatment. */
  readonly declaredOrder?: readonly string[];
}

// ── The factor model ────────────────────────────────────────────────────────

/** A multiplicative factor: the measure is the product of the factor values.
 * Two factors named price and quantity recover the classic P×Q model; rate
 * and hours are the SAME methods under different names, declared aliases,
 * never copies that can drift. */
export interface FactorComparand {
  readonly factorId: string;
  readonly basis: Rational;
  readonly subject: Rational;
}

export interface FactorContribution {
  readonly factorId: string;
  readonly amount: Rational;
}

export type ResidualReason =
  | "fx-unattributable"
  | "mix-portfolio-entrant"
  | "factor-absent-on-one-side"
  | "scale-conversion-boundary"
  | "caller-declared-partial-factor-set";

export interface Decomposition {
  readonly conventionRef: ConventionRef;
  readonly methodRef: MethodRef;
  readonly factors: readonly FactorContribution[];
  readonly totalVariance: Rational;
  /** ALWAYS present; usually exactly zero. Never absorbed into a factor. */
  readonly unassignedResidual: Rational;
  readonly residualReason: ResidualReason | null;
  /** False whenever factor.mix is in the set — product-level mix does not sum
   * to category-level mix, mathematically, and the result says so. */
  readonly additiveAcrossLevels: boolean;
}

/** f(S) = Π_{i∈S} subject_i × Π_{i∉S} basis_i — the measure with the factors
 * in S moved to their subject values. Every convention is an assignment of
 * marginal steps through this lattice, which is why each is exactly additive
 * by construction. */
const evaluate = (factors: readonly FactorComparand[], moved: ReadonlySet<string>): Rational =>
  factors.reduce((acc, f) => rMul(acc, moved.has(f.factorId) ? f.subject : f.basis), rational(1n, 1n));

/** Contributions for ONE ordering: factor i's step is f(prefix ∪ {i}) − f(prefix). */
function sequentialContributions(
  factors: readonly FactorComparand[],
  order: readonly string[],
): Map<string, Rational> {
  const out = new Map<string, Rational>();
  const moved = new Set<string>();
  let previous = evaluate(factors, moved);
  for (const factorId of order) {
    moved.add(factorId);
    const next = evaluate(factors, moved);
    out.set(factorId, rSub(next, previous));
    previous = next;
  }
  return out;
}

function permutations(items: readonly string[]): string[][] {
  if (items.length <= 1) return [Array.from(items)];
  const out: string[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

// ── §16.3 · decompose — the convention is required, no default exists ───────

export function decomposeVariance(
  factors: readonly FactorComparand[],
  convention: ConventionRef | undefined,
  options?: { readonly includesMixFactor?: boolean },
): Result<Decomposition> {
  const M = VARIANCE_METHODS.decompose;
  if (convention === undefined) {
    // GUARD-11: this refusal is the ONLY behaviour for an absent convention.
    // The price effect in the worked case moves 40% with the choice; in the
    // 40%/40% case the joint term is 20% of the whole answer. SR-04: Steven
    // chooses a house convention, or it stays required forever.
    return refuse(
      "CONVENTION_UNSELECTED",
      M,
      "Six registered conventions assign the joint term differently and none is a default. The £2,000–£2,800 spread on one worked price effect is the reason.",
    );
  }
  if (factors.length === 0) {
    return refuse("DECOMPOSITION_REQUIRES_FACTORS", M, "A decomposition needs at least one factor comparand.");
  }
  const ids = factors.map((f) => f.factorId);
  if (new Set(ids).size !== ids.length) {
    return refuse("DECOMPOSITION_REQUIRES_FACTORS", M, "Duplicate factorIds in the factor set.");
  }
  const total = rSub(evaluate(factors, new Set(ids)), evaluate(factors, new Set()));

  const finish = (contributions: Map<string, Rational>, extra?: FactorContribution): Result<Decomposition> => {
    const list: FactorContribution[] = ids.map((factorId) => ({
      factorId,
      amount: contributions.get(factorId) ?? R_ZERO,
    }));
    if (extra) list.push(extra);
    // I-1: Σ(factors) + residual == total, in exact rationals, zero tolerance.
    // Every registered convention is exactly additive by construction, so the
    // residual here is exactly zero and this check is a tripwire: it can only
    // fire if a future edit breaks a construction, and then the decomposition
    // is refused rather than returned wrong (rule 4: no partial decomposition).
    const sum = rSum(list.map((c) => c.amount));
    if (rCmp(sum, total) !== 0) {
      return refuse(
        "DECOMPOSITION_DOES_NOT_RECONCILE",
        M,
        `Σ(factors) ${rToDecimalString(sum, 6)} != ΔTotal ${rToDecimalString(total, 6)} under ${convention.conventionId}.`,
      );
    }
    return ok({
      conventionRef: convention,
      methodRef: M,
      factors: list,
      totalVariance: total,
      unassignedResidual: R_ZERO,
      residualReason: null,
      additiveAcrossLevels: options?.includesMixFactor === true ? false : true,
    });
  };

  switch (convention.conventionId) {
    case "convention.laspeyres.price-first": {
      if (factors.length !== 2) {
        return refuse(
          "FACTOR_SET_UNSUPPORTED_BY_CONVENTION",
          M,
          "laspeyres.price-first is defined for exactly two factors; for n >= 3 declare an order with sequential.declared-order.",
        );
      }
      return finish(sequentialContributions(factors, ids));
    }
    case "convention.paasche.volume-first": {
      if (factors.length !== 2) {
        return refuse(
          "FACTOR_SET_UNSUPPORTED_BY_CONVENTION",
          M,
          "paasche.volume-first is defined for exactly two factors; for n >= 3 declare an order with sequential.declared-order.",
        );
      }
      return finish(sequentialContributions(factors, [ids[1]!, ids[0]!]));
    }
    case "convention.joint-explicit": {
      if (factors.length !== 2) {
        return refuse(
          "FACTOR_SET_UNSUPPORTED_BY_CONVENTION",
          M,
          "joint-explicit names ONE joint term, which exists only for two factors; for n >= 3 use shapley.",
        );
      }
      const [p, q] = [factors[0]!, factors[1]!];
      const dP = rSub(p.subject, p.basis);
      const dQ = rSub(q.subject, q.basis);
      const contributions = new Map<string, Rational>([
        [p.factorId, rMul(dP, q.basis)],
        [q.factorId, rMul(dQ, p.basis)],
      ]);
      return finish(contributions, { factorId: "joint", amount: rMul(dP, dQ) });
    }
    case "convention.bennet.midpoint": {
      // Bennet coincides with Shapley for exactly two factors and DIVERGES at
      // three — a reader who verifies n=2 and assumes equivalence is wrong at
      // n=3. This engine ships Bennet only where it is classical (n=2); for
      // n >= 3 the order-independent convention is shapley.
      if (factors.length !== 2) {
        return refuse(
          "FACTOR_SET_UNSUPPORTED_BY_CONVENTION",
          M,
          "bennet.midpoint ships for exactly two factors, where it equals shapley; for n >= 3 use shapley, which is order-independent by construction.",
        );
      }
      const [p, q] = [factors[0]!, factors[1]!];
      const half = rational(1n, 2n);
      const contributions = new Map<string, Rational>([
        [p.factorId, rMul(rSub(p.subject, p.basis), rMul(half, rAdd(q.basis, q.subject)))],
        [q.factorId, rMul(rSub(q.subject, q.basis), rMul(half, rAdd(p.basis, p.subject)))],
      ]);
      return finish(contributions);
    }
    case "convention.shapley": {
      if (factors.length > 6) {
        return refuse(
          "SHAPLEY_FACTOR_LIMIT",
          M,
          `Shapley averages over n! orderings; at ${factors.length} factors the budget in §34 is exceeded.`,
        );
      }
      const orderings = permutations(ids);
      const totals = new Map<string, Rational>(ids.map((id) => [id, R_ZERO]));
      for (const ordering of orderings) {
        const step = sequentialContributions(factors, ordering);
        for (const id of ids) totals.set(id, rAdd(totals.get(id)!, step.get(id)!));
      }
      const n = BigInt(orderings.length);
      const contributions = new Map<string, Rational>(
        ids.map((id) => {
          const t = totals.get(id)!;
          return [id, rational(t.num, t.den * n)];
        }),
      );
      return finish(contributions);
    }
    case "convention.sequential.declared-order": {
      const order = convention.declaredOrder;
      if (order === undefined || [...order].sort().join(" ") !== [...ids].sort().join(" ")) {
        return refuse(
          "ORDER_UNDECLARED",
          M,
          "sequential.declared-order requires a caller-declared order covering exactly the factor set. Almost every FP&A bridge uses this convention; almost none declares the order. This one is visible.",
        );
      }
      return finish(sequentialContributions(factors, order));
    }
  }
}

// ── Presentation: rounding AFTER reconciliation, exact-sum preserved ────────

/** Rounds contributions to minor units so the rounded parts sum to the
 * rounded total exactly — largest-remainder over the fractional parts, never
 * a plug into the biggest line (GUARD-12: no residual quantity is ever added
 * into a FactorContribution). */
export function roundDecomposition(
  decomposition: Decomposition,
): readonly { factorId: string; amountMinor: bigint }[] {
  const floorRational = (r: Rational): bigint => {
    const q = r.num / r.den;
    return r.num % r.den !== 0n && r.num < 0n ? q - 1n : q;
  };
  const targetTotal = ((): bigint => {
    // Half-even at 0 places on the exact total.
    const twice = rational(decomposition.totalVariance.num * 2n, decomposition.totalVariance.den);
    const floor = floorRational(decomposition.totalVariance);
    const twiceFloor = floorRational(twice);
    if (twiceFloor === floor * 2n) return floor; // fraction < .5
    if (twiceFloor > floor * 2n + 1n) return floor + 1n; // fraction > .5 (impossible branch kept simple)
    // exactly .5 or in (.5, 1): compare precisely
    const frac = rSub(decomposition.totalVariance, rational(floor, 1n));
    const cmp = rCmp(frac, rational(1n, 2n));
    if (cmp < 0) return floor;
    if (cmp > 0) return floor + 1n;
    return floor % 2n === 0n ? floor : floor + 1n;
  })();
  const floors = decomposition.factors.map((f) => {
    const floor = floorRational(f.amount);
    return { factorId: f.factorId, floor, frac: rSub(f.amount, rational(floor, 1n)) };
  });
  let residual = targetTotal - floors.reduce((a, f) => a + f.floor, 0n);
  const order = [...floors].sort((a, b) => {
    const cmp = rCmp(b.frac, a.frac);
    return cmp !== 0 ? cmp : a.factorId < b.factorId ? -1 : 1;
  });
  const bump = new Set<string>();
  for (const f of order) {
    if (residual <= 0n) break;
    bump.add(f.factorId);
    residual -= 1n;
  }
  return floors.map((f) => ({ factorId: f.factorId, amountMinor: f.floor + (bump.has(f.factorId) ? 1n : 0n) }));
}

// ── §16.7 · convention sensitivity and attributionUnstable ──────────────────

export interface SensitivityBand {
  readonly factorId: string;
  readonly minAmount: Rational;
  readonly maxAmount: Rational;
  readonly spread: Rational;
  readonly signStable: boolean;
  readonly rankStable: boolean;
}

export interface SensitivityReport {
  readonly methodRef: MethodRef;
  readonly conventionsCompared: readonly ConventionId[];
  readonly bands: readonly SensitivityBand[];
  readonly attributionUnstable: boolean;
  /** The disagreeing pair when unstable — read by the required caveat. */
  readonly disagreement: { readonly factorId: string; readonly conventions: readonly [ConventionId, ConventionId] } | null;
}

/** Re-computes the decomposition under every applicable registered convention
 * and reports the band. This is the honest answer to "was it price or
 * volume?" when the honest answer is "the data does not distinguish them" —
 * and the spread is reported even when stable, because a 40% spread on the
 * price effect is a fact the reader is entitled to. */
export function conventionSensitivity(factors: readonly FactorComparand[]): Result<SensitivityReport> {
  const M = VARIANCE_METHODS.sensitivity;
  if (factors.length < 2) {
    return refuse("DECOMPOSITION_REQUIRES_FACTORS", M, "Sensitivity is defined for two or more factors.");
  }
  const candidates: ConventionRef[] =
    factors.length === 2
      ? [
          { conventionId: "convention.laspeyres.price-first", semanticVersion: "1.0.0" },
          { conventionId: "convention.paasche.volume-first", semanticVersion: "1.0.0" },
          { conventionId: "convention.bennet.midpoint", semanticVersion: "1.0.0" },
          { conventionId: "convention.shapley", semanticVersion: "1.0.0" },
        ]
      : [{ conventionId: "convention.shapley", semanticVersion: "1.0.0" }];
  const runs: { conventionId: ConventionId; byFactor: Map<string, Rational>; ranks: Map<string, number> }[] = [];
  for (const convention of candidates) {
    const d = decomposeVariance(factors, convention);
    if (!d.ok) return d;
    const byFactor = new Map(d.value.factors.map((f) => [f.factorId, f.amount]));
    const ranked = [...d.value.factors].sort((a, b) => rCmp(rAbs(b.amount), rAbs(a.amount)));
    const ranks = new Map(ranked.map((f, i) => [f.factorId, i]));
    runs.push({ conventionId: convention.conventionId, byFactor, ranks });
  }
  const ids = factors.map((f) => f.factorId);
  let disagreement: SensitivityReport["disagreement"] = null;
  const bands = ids.map((factorId): SensitivityBand => {
    const amounts = runs.map((r) => ({ conventionId: r.conventionId, amount: r.byFactor.get(factorId)! }));
    let min = amounts[0]!;
    let max = amounts[0]!;
    for (const a of amounts) {
      if (rCmp(a.amount, min.amount) < 0) min = a;
      if (rCmp(a.amount, max.amount) > 0) max = a;
    }
    const signs = new Set(amounts.map((a) => (a.amount.num === 0n ? 0 : a.amount.num < 0n ? -1 : 1)));
    const rankSet = new Set(runs.map((r) => r.ranks.get(factorId)!));
    const signStable = signs.size === 1;
    const rankStable = rankSet.size === 1;
    if ((!signStable || !rankStable) && disagreement === null) {
      disagreement = { factorId, conventions: [min.conventionId, max.conventionId] };
    }
    return {
      factorId,
      minAmount: min.amount,
      maxAmount: max.amount,
      spread: rSub(max.amount, min.amount),
      signStable,
      rankStable,
    };
  });
  return ok({
    methodRef: M,
    conventionsCompared: runs.map((r) => r.conventionId),
    bands,
    attributionUnstable: bands.some((b) => !b.signStable || !b.rankStable),
    disagreement,
  });
}

// ── §16.14 · relative variance: the denominator is a required argument ──────

export function relativeVariance(
  basis: Rational,
  subject: Rational,
  denominator: "basis" | "subject" | "midpoint" | undefined,
): Result<{ relative: Rational | null; denominator: string }> {
  const M = VARIANCE_METHODS.relative;
  if (denominator === undefined) {
    return refuse("DENOMINATOR_UNSELECTED", M, "Basis, subject and midpoint denominators are three different claims; the caller names one.");
  }
  const delta = rSub(subject, basis);
  const base =
    denominator === "basis" ? basis : denominator === "subject" ? subject : rMul(rational(1n, 2n), rAdd(basis, subject));
  if (base.num === 0n) {
    // Null at a zero denominator — a percentage of nothing is not a number.
    return ok({ relative: null, denominator });
  }
  return ok({ relative: rMul(delta, rational(base.den, base.num)), denominator });
}

// ── §16.9 · materiality: classified, partitioned, NEVER a filter ────────────

export type MaterialityClass = "material" | "below-threshold" | "unclassifiable";

export interface VarianceItem {
  readonly varianceRef: string;
  readonly signedDeltaMinor: bigint;
}

export type MaterialityPolicy =
  | {
      readonly kind: "absolute";
      readonly purpose: "analytical";
      readonly declaredBy: string;
      readonly thresholdMinor: bigint;
    }
  | {
      readonly kind: "absolute-asymmetric";
      readonly purpose: "analytical";
      readonly declaredBy: string;
      /** BOTH sides must be stated. Asymmetry by omission is not available —
       * favourable variances of the same size hide missed accruals. */
      readonly adverseThresholdMinor?: bigint;
      readonly favourableThresholdMinor?: bigint;
    }
  | {
      readonly kind: "statistical";
      readonly purpose: "analytical";
      readonly declaredBy: string;
      readonly windowObservationsMinor: readonly bigint[];
      readonly k: number;
      readonly distributionAssumption: string;
      readonly sampleMinimum: number;
    };

export interface MaterialityRun {
  readonly methodRef: MethodRef;
  readonly classified: readonly { varianceRef: string; signedDeltaMinor: bigint; class: MaterialityClass; note: string | null }[];
  readonly belowThresholdCount: number;
  readonly belowThresholdAggregateMinor: bigint;
  /** Two hundred immaterial same-signed variances summing to a material one
   * is the classic below-threshold accumulation defect; this flag is a
   * required caveat when it fires. */
  readonly belowThresholdAggregateMaterial: boolean;
}

export function classifyMateriality(
  variances: readonly VarianceItem[],
  policy: MaterialityPolicy | undefined,
): Result<MaterialityRun> {
  const M = VARIANCE_METHODS.materiality;
  const abs = (n: bigint): bigint => (n < 0n ? -n : n);

  let classify: (v: VarianceItem) => { class: MaterialityClass; note: string | null };
  let thresholdForAggregate: bigint | null = null;

  if (policy === undefined) {
    // No policy → every variance unclassifiable, and the run says so. There
    // is no house threshold to fall back to, because there isn't one (D-5).
    classify = () => ({ class: "unclassifiable", note: "No MaterialityPolicy supplied; there is no house threshold." });
  } else if (policy.kind === "absolute") {
    const t = policy.thresholdMinor;
    thresholdForAggregate = t;
    classify = (v) => ({ class: abs(v.signedDeltaMinor) >= t ? "material" : "below-threshold", note: null });
  } else if (policy.kind === "absolute-asymmetric") {
    if (policy.adverseThresholdMinor === undefined || policy.favourableThresholdMinor === undefined) {
      return refuse(
        "ASYMMETRY_INCOMPLETE",
        M,
        "An asymmetric policy must state BOTH adverseThreshold and favourableThreshold. Asymmetry by omission is how a favourable variance from a missed accrual survives a close.",
      );
    }
    const adverse = policy.adverseThresholdMinor;
    const favourable = policy.favourableThresholdMinor;
    thresholdForAggregate = adverse < favourable ? adverse : favourable;
    classify = (v) => {
      const t = v.signedDeltaMinor < 0n ? adverse : favourable;
      return { class: abs(v.signedDeltaMinor) >= t ? "material" : "below-threshold", note: "asymmetric-policy" };
    };
  } else {
    const { windowObservationsMinor, k, distributionAssumption, sampleMinimum } = policy;
    if (k <= 0 || sampleMinimum <= 0 || distributionAssumption.trim() === "") {
      return refuse("STATISTICAL_BASIS_INVALID", M, "A statistical policy needs a positive k, a positive sampleMinimum and a stated distributionAssumption.");
    }
    if (windowObservationsMinor.length < sampleMinimum) {
      // Fewer observations than the declared minimum does NOT fall back to
      // absolute — a control limit computed from four observations is not a
      // control limit. Everything in scope is unclassifiable, with the
      // shortfall named.
      const note = `Statistical window holds ${windowObservationsMinor.length} observations; sampleMinimum is ${sampleMinimum}.`;
      classify = () => ({ class: "unclassifiable", note });
    } else {
      // k·(mean absolute deviation) limit over the declared window — integer
      // arithmetic; the assumption made is recorded, not tested.
      const n = BigInt(windowObservationsMinor.length);
      const mean = windowObservationsMinor.reduce((a, x) => a + x, 0n) / n;
      const mad = windowObservationsMinor.reduce((a, x) => a + abs(x - mean), 0n) / n;
      const kScaled = BigInt(Math.trunc(k * 1000));
      const limit = (mad * kScaled) / 1000n;
      thresholdForAggregate = limit;
      const note = `k=${k} × MAD over ${windowObservationsMinor.length} obs; distribution assumption: ${distributionAssumption} (recorded, not tested).`;
      classify = (v) => ({ class: abs(v.signedDeltaMinor - mean) >= limit ? "material" : "below-threshold", note });
    }
  }

  // No code path REMOVES a variance on the basis of its class (GUARD-13):
  // every input row appears in `classified`, and the below-threshold set is
  // aggregated alongside the material set, not dropped.
  const classified = variances.map((v) => {
    const c = classify(v);
    return { varianceRef: v.varianceRef, signedDeltaMinor: v.signedDeltaMinor, class: c.class, note: c.note };
  });
  const below = classified.reduce(
    (acc, c) => (c.class === "below-threshold" ? { count: acc.count + 1, sum: acc.sum + c.signedDeltaMinor } : acc),
    { count: 0, sum: 0n },
  );
  return ok({
    methodRef: M,
    classified,
    belowThresholdCount: below.count,
    belowThresholdAggregateMinor: below.sum,
    belowThresholdAggregateMaterial:
      thresholdForAggregate !== null && abs(below.sum) >= thresholdForAggregate && below.count > 0,
  });
}

// ── §16.11 · FX: unattributable is a residual, never a zero ─────────────────

export interface FxComparandRefs {
  readonly basisRateRef: string | undefined;
  readonly subjectRateRef: string | undefined;
}

/** Transaction FX and translation FX are different variances with different
 * bases and may not be netted — the caller names which one it wants. */
export function fxAttributability(
  refs: FxComparandRefs,
  fxKind: "transaction" | "translation" | undefined,
):
  | { readonly attributable: true; readonly factorId: "factor.fx.transaction" | "factor.fx.translation" }
  | { readonly attributable: false; readonly residualReason: "fx-unattributable"; readonly detail: string }
  | { readonly attributable: false; readonly refusal: VarianceRefusal } {
  if (fxKind === undefined) {
    return {
      attributable: false,
      refusal: {
        kind: "FX_KIND_UNSPECIFIED",
        methodRef: VARIANCE_METHODS.fx,
        detail: "Transaction and translation FX are different variances with different bases and may not be netted; the caller names which.",
      },
    };
  }
  if (refs.basisRateRef === undefined || refs.subjectRateRef === undefined) {
    // FX is NOT zero here. Silently assuming same-currency comparands is how
    // a currency movement becomes a price variance.
    const missing = [
      refs.basisRateRef === undefined ? "basis" : null,
      refs.subjectRateRef === undefined ? "subject" : null,
    ].filter((s): s is string => s !== null);
    return {
      attributable: false,
      residualReason: "fx-unattributable",
      detail: `ExchangeRateRef absent on: ${missing.join(", ")}. The un-separable amount goes to unassignedResidual.`,
    };
  }
  return { attributable: true, factorId: fxKind === "transaction" ? "factor.fx.transaction" : "factor.fx.translation" };
}

// ── §16.8 · mix: only defined over a DECLARED portfolio boundary ────────────

export interface MixBasis {
  /** Captured BY VALUE, not resolved at read time. */
  readonly portfolioMembers: readonly string[];
  readonly averagingMethod: "basis-weighted" | "subject-weighted" | "midpoint-weighted";
  readonly entrantTreatment: "as-volume" | "as-mix" | "as-own-term";
  readonly exitTreatment: "as-volume" | "as-mix" | "as-own-term";
}

export function requireMixBasis(basis: Partial<MixBasis> | undefined): Result<MixBasis> {
  const M = VARIANCE_METHODS.mix;
  if (
    basis === undefined ||
    basis.portfolioMembers === undefined ||
    basis.portfolioMembers.length === 0 ||
    basis.averagingMethod === undefined ||
    basis.entrantTreatment === undefined ||
    basis.exitTreatment === undefined
  ) {
    return refuse(
      "MIX_PORTFOLIO_UNDECLARED",
      M,
      "Mix is only defined relative to a declared portfolio: members (by value), averagingMethod, entrantTreatment and exitTreatment are all required. Adding one product to a report changes every other product's mix variance.",
    );
  }
  return ok(basis as MixBasis);
}

// ── §16.12 · the narrative skeleton — deterministic, caveats non-droppable ──

export type CaveatId =
  | "convention-named"
  | "attribution-unstable"
  | "residual-present"
  | "below-threshold-aggregate-material"
  | "mix-not-additive";

export interface NarrativeSkeleton {
  readonly methodRef: MethodRef;
  readonly conventionStatement: ConventionRef;
  readonly steps: readonly { factorId: string; amount: Rational; shareOfTotalText: string }[];
  readonly requiredCaveats: readonly { id: CaveatId; text: string }[];
}

export function buildSkeleton(
  decomposition: Decomposition,
  sensitivity: SensitivityReport | null,
  materiality: MaterialityRun | null,
): NarrativeSkeleton {
  const steps = [...decomposition.factors]
    .sort((a, b) => {
      const cmp = rCmp(rAbs(b.amount), rAbs(a.amount));
      return cmp !== 0 ? cmp : a.factorId < b.factorId ? -1 : 1;
    })
    .map((f) => ({
      factorId: f.factorId,
      amount: f.amount,
      shareOfTotalText: rIsZeroSafeShare(f.amount, decomposition.totalVariance),
    }));
  const caveats: { id: CaveatId; text: string }[] = [
    // Always. The convention is named in every narrative, without exception.
    {
      id: "convention-named",
      text: `Decomposed under ${decomposition.conventionRef.conventionId}@${decomposition.conventionRef.semanticVersion}; a different registered convention gives a different, equally correct split.`,
    },
  ];
  if (sensitivity !== null && sensitivity.attributionUnstable && sensitivity.disagreement !== null) {
    caveats.push({
      id: "attribution-unstable",
      text: `Attribution is unstable: ${sensitivity.disagreement.conventions[0]} and ${sensitivity.disagreement.conventions[1]} disagree on ${sensitivity.disagreement.factorId} in sign or rank. The data does not distinguish the explanations.`,
    });
  }
  if (decomposition.unassignedResidual.num !== 0n && decomposition.residualReason !== null) {
    caveats.push({
      id: "residual-present",
      text: `An unassigned residual of ${rToDecimalString(decomposition.unassignedResidual, 2)} remains: ${decomposition.residualReason}.`,
    });
  }
  if (materiality !== null && materiality.belowThresholdAggregateMaterial) {
    caveats.push({
      id: "below-threshold-aggregate-material",
      text: `${materiality.belowThresholdCount} below-threshold variances aggregate past the policy threshold — the accumulation the per-item filter cannot see.`,
    });
  }
  if (!decomposition.additiveAcrossLevels) {
    caveats.push({
      id: "mix-not-additive",
      text: "factor.mix is present: product-level mix does not sum to category-level mix. Roll-up additivity is asserted only over the non-mix factors.",
    });
  }
  return { methodRef: VARIANCE_METHODS.skeleton, conventionStatement: decomposition.conventionRef, steps, requiredCaveats: caveats };
}

function rIsZeroSafeShare(part: Rational, total: Rational): string {
  if (total.num === 0n) return "share undefined over a zero total";
  const share = rMul(part, rational(total.den * 100n, total.num));
  return `${rToDecimalString(share, 1)}% of the total variance`;
}
