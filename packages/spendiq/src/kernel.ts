// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// SpendIQ kernel — §16. Chartered as a SPECIALIZED engine by owner ruling
// DEC-026, which overrules the package's own "module, not engine" verdict;
// the conflict is recorded in the decision register, and the blueprint's
// design rules bind unchanged. The integrity core is the savings claim: its
// amount has NO constructor other than deriveSavings over a by-value
// baseline with a REQUIRED basis (six defensible bases produce six numbers
// from identical facts), its assertion statement is GENERATED from its own
// fields — including what it does NOT assert — and cost-avoidance is
// structurally unreconcilable because the increase that did not happen
// leaves no trace. Coverage is three buckets that never collapse: a model
// proposal lands in lowEvidence and cannot inflate attribution. Maverick
// spend with the contract register unbound REFUSES — £0 would be unknown
// presented as zero, on the engine's headline capability.
//
// Duplication findings from the package stand as CONSUME obligations:
// price-variance-by-item is ReceiptIQ's shipped capability, and the
// concentration fold is ProfitabilityIQ's — neither is reimplemented here.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const SPEND_METHODS = {
  classify: method("spend.classify.deterministic"),
  confirm: method("spend.classify.human-confirm"),
  cubeFold: method("spend.cube.fold"),
  ranking: method("spend.ranking"),
  tail: method("spend.tail"),
  maverick: method("spend.maverick"),
  baseline: method("spend.savings.baseline"),
  derive: method("spend.savings.derive"),
  realisation: method("spend.savings.realisation"),
} as const satisfies Record<string, MethodRef>;

export const SPEND_REFUSAL_KINDS = [
  "reconciliation-failed",
  "tail-definition-required",
  "contract-register-unbound",
  "baseline-basis-required",
  "confirmation-authorization-missing",
] as const;
export type SpendRefusalKind = (typeof SPEND_REFUSAL_KINDS)[number];

export interface SpendRefusal {
  readonly kind: SpendRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: SpendRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: SpendRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── M-1/M-2/M-3 · classification: deterministic first, model never counts ───

export interface SpendFact {
  readonly factRef: string;
  readonly amountMinor: bigint;
  /** ReceiptIQ's normalized merchantKey, or null when unresolved. Raw
   * supplier strings are NEVER bucketed: near-duplicate raw names produce
   * the most damaging error in spend analysis — a recommendation to
   * consolidate a supplier with itself. */
  readonly supplierKey: string | null;
  readonly descriptionKey: string;
}

export interface MappingRule {
  readonly ruleId: string;
  readonly effectiveFrom: string;
  readonly matchDescriptionKey: string;
  readonly category: string;
  readonly origin: "authored" | "human-confirmed"; // deliberately NO "model" variant
}

export type Classification =
  | { readonly state: "deterministic-mapped"; readonly ruleId: string; readonly category: string }
  | { readonly state: "model-proposed"; readonly category: string; readonly modelRef: string; readonly sourceStrength: "ai-candidate" }
  | { readonly state: "unclassified"; readonly reason: "no-rule-matched" | "supplier-unresolved" };

/** Ordered rules, first match wins, evaluated at asOf. Pure and total: same
 * fact, same mapping set, same asOf — same result forever. */
export function classify(
  fact: SpendFact,
  rules: readonly MappingRule[],
  asOf: string,
  modelCandidate?: { category: string; modelRef: string },
): Classification {
  if (fact.supplierKey === null) {
    // Not dropped, not bucketed by raw string — a named unclassified state.
    return { state: "unclassified", reason: "supplier-unresolved" };
  }
  for (const rule of rules) {
    if (rule.effectiveFrom <= asOf && rule.matchDescriptionKey === fact.descriptionKey) {
      return { state: "deterministic-mapped", ruleId: rule.ruleId, category: rule.category };
    }
  }
  if (modelCandidate !== undefined) {
    return { state: "model-proposed", category: modelCandidate.category, modelRef: modelCandidate.modelRef, sourceStrength: "ai-candidate" };
  }
  return { state: "unclassified", reason: "no-rule-matched" };
}

/** M-4: confirmation creates a NEW rule whose origin records the human, not
 * the model — with a Governance reference, or a refusal. It never modifies a
 * source record and never touches a published run. */
export function confirmMapping(
  candidateCategory: string,
  descriptionKey: string,
  principal: string | undefined,
  governanceDecisionRef: string | undefined,
  asOf: string,
  newRuleId: string,
): Result<MappingRule> {
  const M = SPEND_METHODS.confirm;
  if (principal === undefined || !principal.startsWith("human.") || governanceDecisionRef === undefined) {
    return refuse("confirmation-authorization-missing", M, "A confirmation needs a human principal AND a GovernanceDecisionRef; it does not authorize itself.");
  }
  return ok({
    ruleId: newRuleId,
    effectiveFrom: asOf,
    matchDescriptionKey: descriptionKey,
    category: candidateCategory,
    origin: "human-confirmed",
  });
}

// ── M-5 · the three-bucket cube fold and invariant R-1 ──────────────────────

export interface Coverage {
  readonly attributedMinor: bigint;
  readonly unclassifiedMinor: bigint;
  /** Model-proposed lands HERE — visible, separate, never silently inflating
   * coverage. */
  readonly lowEvidenceMinor: bigint;
}

export function foldCube(
  facts: readonly { fact: SpendFact; classification: Classification }[],
  suppliedSourceTotalMinor: bigint,
): Result<{ byCategory: ReadonlyMap<string, Coverage>; total: Coverage }> {
  const M = SPEND_METHODS.cubeFold;
  const byCategory = new Map<string, { attributedMinor: bigint; unclassifiedMinor: bigint; lowEvidenceMinor: bigint }>();
  const bucket = (key: string) => {
    const existing = byCategory.get(key);
    if (existing !== undefined) return existing;
    const fresh = { attributedMinor: 0n, unclassifiedMinor: 0n, lowEvidenceMinor: 0n };
    byCategory.set(key, fresh);
    return fresh;
  };
  const total = { attributedMinor: 0n, unclassifiedMinor: 0n, lowEvidenceMinor: 0n };
  for (const { fact, classification } of facts) {
    if (classification.state === "deterministic-mapped") {
      bucket(classification.category).attributedMinor += fact.amountMinor;
      total.attributedMinor += fact.amountMinor;
    } else if (classification.state === "model-proposed") {
      bucket(classification.category).lowEvidenceMinor += fact.amountMinor;
      total.lowEvidenceMinor += fact.amountMinor;
    } else {
      // `unclassified` is a REAL node, not an omission.
      bucket("unclassified").unclassifiedMinor += fact.amountMinor;
      total.unclassifiedMinor += fact.amountMinor;
    }
  }
  // Invariant R-1: the cube ties to the source or the run refuses with the
  // residual — a cube that does not tie is the row-level F-1 failure.
  const sum = total.attributedMinor + total.unclassifiedMinor + total.lowEvidenceMinor;
  if (sum !== suppliedSourceTotalMinor) {
    return refuse("reconciliation-failed", M, `Cube total ${sum} != source total ${suppliedSourceTotalMinor}; residual ${suppliedSourceTotalMinor - sum}.`);
  }
  return ok({ byCategory, total });
}

// ── M-6 · ranking with an excluded set ──────────────────────────────────────

export function rankSuppliers(
  suppliers: readonly { supplierKey: string; coverage: Coverage }[],
  maxUnclassifiedSharePermille: bigint,
): {
  ranked: readonly { supplierKey: string; attributedMinor: bigint }[];
  excluded: readonly { supplierKey: string; unclassifiedSharePermille: bigint }[];
} {
  const ranked: { supplierKey: string; attributedMinor: bigint }[] = [];
  const excluded: { supplierKey: string; unclassifiedSharePermille: bigint }[] = [];
  for (const s of suppliers) {
    const totalMinor = s.coverage.attributedMinor + s.coverage.unclassifiedMinor + s.coverage.lowEvidenceMinor;
    const share = totalMinor === 0n ? 0n : (s.coverage.unclassifiedMinor * 1000n) / totalMinor;
    if (share > maxUnclassifiedSharePermille) {
      // A top-ten list that silently omits a 70%-unclassified supplier is
      // wrong in a way the reader cannot detect — the exclusion is returned.
      excluded.push({ supplierKey: s.supplierKey, unclassifiedSharePermille: share });
    } else {
      ranked.push({ supplierKey: s.supplierKey, attributedMinor: s.coverage.attributedMinor });
    }
  }
  ranked.sort((a, b) =>
    a.attributedMinor !== b.attributedMinor ? (b.attributedMinor > a.attributedMinor ? 1 : -1) : a.supplierKey < b.supplierKey ? -1 : 1,
  );
  return { ranked, excluded };
}

// ── M-7 · tail spend: four definitions, REQUIRED, published spread 5%-40% ───

export type TailDefinition =
  | { readonly kind: "cumulative-share"; readonly topPermille: bigint }
  | { readonly kind: "absolute-threshold"; readonly belowMinor: bigint }
  | { readonly kind: "transaction-count"; readonly fewerThan: number }
  | { readonly kind: "abc-category"; readonly categoryCSharePermille: bigint };

export function tailSuppliers(
  suppliers: readonly { supplierKey: string; annualSpendMinor: bigint; transactionCount: number }[],
  definition: TailDefinition | undefined,
): Result<{ tail: readonly string[]; definition: TailDefinition }> {
  const M = SPEND_METHODS.tail;
  if (definition === undefined) {
    // Published answers span 5% to 40% of spend — an eight-fold spread that
    // changes WHICH suppliers are in the set entirely. D-6 confirmed: Steven
    // chooses a house definition or it stays required forever.
    return refuse("tail-definition-required", M, "Four defensible definitions select different supplier sets (published spread 5%-40% of spend); the caller names one.");
  }
  const byDescending = [...suppliers].sort((a, b) =>
    a.annualSpendMinor !== b.annualSpendMinor ? (b.annualSpendMinor > a.annualSpendMinor ? 1 : -1) : a.supplierKey < b.supplierKey ? -1 : 1,
  );
  const totalMinor = suppliers.reduce((a, s) => a + s.annualSpendMinor, 0n);
  const tail: string[] = [];
  switch (definition.kind) {
    case "cumulative-share": {
      let cumulative = 0n;
      for (const s of byDescending) {
        cumulative += s.annualSpendMinor;
        if (cumulative * 1000n > totalMinor * definition.topPermille) tail.push(s.supplierKey);
      }
      break;
    }
    case "absolute-threshold":
      for (const s of suppliers) if (s.annualSpendMinor < definition.belowMinor) tail.push(s.supplierKey);
      break;
    case "transaction-count":
      for (const s of suppliers) if (s.transactionCount < definition.fewerThan) tail.push(s.supplierKey);
      break;
    case "abc-category": {
      // Category C = the bottom slice of cumulative spend (category-relative).
      let cumulative = 0n;
      const cThresholdPermille = 1000n - definition.categoryCSharePermille;
      for (const s of byDescending) {
        cumulative += s.annualSpendMinor;
        if (cumulative * 1000n > totalMinor * cThresholdPermille) tail.push(s.supplierKey);
      }
      break;
    }
  }
  return ok({ tail: tail.sort(), definition });
}

// ── M-9 · maverick spend: the refusal that is the headline ──────────────────

export interface ContractCoverage {
  readonly supplierKey: string;
  readonly category: string;
  readonly coverageFrom: string;
  readonly coverageTo: string;
}

/** OC-1 only (no-contract-covered-this-purchase); OC-2/OC-3 need contracted
 * rates and channel obligations no port carries yet. With the register
 * unbound the method REFUSES — the explicitly rejected alternatives are
 * reporting £0 (unknown as zero), substituting "not on a preferred list"
 * (a different claim that gets acted on as this one), and inferring a
 * contract from repeated purchasing (a pattern is not an agreement). */
export function maverickSpend(
  facts: readonly { factRef: string; supplierKey: string; category: string; date: string }[],
  contractRegister: readonly ContractCoverage[] | undefined,
): Result<{ offContractOc1: readonly string[]; covered: readonly string[] }> {
  const M = SPEND_METHODS.maverick;
  if (contractRegister === undefined) {
    return refuse(
      "contract-register-unbound",
      M,
      "Off-contract spend needs a contract register (coverage windows, contracted rates, channel obligations). ContractRegisterPort is unbound in every host today; no engine in the taxonomy owns contract terms. The engine's headline capability cannot be answered, and it says so — never £0.",
    );
  }
  const offContractOc1: string[] = [];
  const covered: string[] = [];
  for (const fact of facts) {
    const hit = contractRegister.some(
      (c) => c.supplierKey === fact.supplierKey && c.category === fact.category && fact.date >= c.coverageFrom && fact.date <= c.coverageTo,
    );
    (hit ? covered : offContractOc1).push(fact.factRef);
  }
  return ok({ offContractOc1, covered });
}

// ── M-10 · the savings-claim integrity core ─────────────────────────────────

export type BaselineBasis =
  | "prior-actual-weighted-average"
  | "prior-actual-last-paid"
  | "contracted-rate"
  | "budgeted-rate"
  | "market-index"
  | "first-quote";

export interface BaselineVersion {
  readonly versionId: string;
  readonly basis: BaselineBasis;
  readonly capturedAt: string;
  /** BY VALUE — a baseline holding a reference to a live price re-derives
   * when history changes and the claimed saving silently moves. */
  readonly unitPriceMinor: bigint;
  readonly observationCount: number;
  readonly supersedes: string | null;
}

export function captureBaseline(
  versionId: string,
  basis: BaselineBasis | undefined,
  unitPriceMinor: bigint,
  observationCount: number,
  capturedAt: string,
  supersedes: string | null = null,
): Result<BaselineVersion> {
  const M = SPEND_METHODS.baseline;
  if (basis === undefined) {
    // Six defensible bases produce six numbers from identical facts;
    // last-paid on a spot buy and a year's weighted average can differ by
    // more than the claimed saving. A default silently picks the flattering
    // one (G-BASE).
    return refuse("baseline-basis-required", M, "Six defensible baseline bases; the basis is the caller's, forever.");
  }
  return ok({ versionId, basis, capturedAt, unitPriceMinor, observationCount, supersedes });
}

export type SavingsKind =
  | "unit-price-reduction"
  | "demand-reduction"
  | "specification-change"
  | "payment-terms"
  | "consolidation-leverage"
  | "cost-avoidance"; // structurally unreconcilable — the increase that did not happen leaves no trace

declare const derivedAmountBrand: unique symbol;
/** The ONLY way to obtain a claim amount: the brand cannot be constructed
 * outside deriveSavings (G-LOCK2b — a model output is not a BaselineVersion
 * and cannot reach this function). */
export type DerivedAmount = { readonly amountMinor: bigint; readonly [derivedAmountBrand]: true };

export function deriveSavings(
  baseline: BaselineVersion,
  observed: { readonly unitPriceMinor: bigint; readonly quantity: bigint },
): DerivedAmount {
  const amountMinor = (baseline.unitPriceMinor - observed.unitPriceMinor) * observed.quantity;
  return { amountMinor } as DerivedAmount;
}

export interface SavingsClaim {
  readonly claimId: string;
  readonly kind: SavingsKind;
  readonly baselineVersionId: string;
  readonly amount: DerivedAmount;
  /** Generated, not authored — regenerated on replay from stored fields, so
   * it cannot be edited into a stronger claim. */
  readonly assertion: { readonly asserts: string; readonly doesNotAssert: string };
  /** null = not yet checked. NOT zero. */
  readonly realisation: RealisationOutcome | null;
  readonly methodRef: MethodRef;
}

export function makeClaim(
  claimId: string,
  kind: SavingsKind,
  baseline: BaselineVersion,
  observed: { readonly unitPriceMinor: bigint; readonly quantity: bigint },
): SavingsClaim {
  const amount = deriveSavings(baseline, observed);
  return {
    claimId,
    kind,
    baselineVersionId: baseline.versionId,
    amount,
    assertion: {
      asserts: `Had the observed quantity of ${observed.quantity} been purchased at the ${baseline.basis} baseline of ${baseline.unitPriceMinor} minor (captured ${baseline.capturedAt} from ${baseline.observationCount} observations), spend would have been ${amount.amountMinor} minor higher.`,
      doesNotAssert:
        "That a budget envelope was reduced; that cash was saved; that this appears in the P&L; that the observed volume would have occurred at the baseline price" +
        (kind === "consolidation-leverage" ? "; that switching costs are zero" : "") +
        "; that any reduction is attributable to a single action.",
    },
    realisation: null,
    methodRef: SPEND_METHODS.derive,
  };
}

// ── M-11 · realisation: the reconciliation the category fails ───────────────

export type NonReconciliationDriver =
  | "volume-change"
  | "mix-change"
  | "category-remapped"
  | "fx-movement"
  | "one-time-purchase"
  | "baseline-superseded"
  | "source-facts-incomplete";

export type RealisationOutcome =
  | { readonly kind: "reconciled"; readonly movementMinor: bigint }
  | { readonly kind: "reconciled-with-variance"; readonly movementMinor: bigint; readonly varianceMinor: bigint; readonly drivers: readonly NonReconciliationDriver[] }
  | { readonly kind: "unreconcilable"; readonly reason: string; readonly drivers: readonly NonReconciliationDriver[] };

export function checkRealisation(
  claim: SavingsClaim,
  observedSpendMovementMinor: bigint | null,
  drivers: readonly NonReconciliationDriver[],
): RealisationOutcome {
  if (claim.kind === "cost-avoidance") {
    // Structurally unreconcilable: the spend line looks unchanged because
    // the increase that did not happen leaves no trace. The TYPE carries
    // this so a total cannot mix it with cash reductions.
    return { kind: "unreconcilable", reason: "cost-avoidance leaves no trace in the spend line", drivers };
  }
  if (observedSpendMovementMinor === null) {
    return { kind: "unreconcilable", reason: "source facts incomplete for the realisation window", drivers: ["source-facts-incomplete"] };
  }
  const variance = observedSpendMovementMinor - claim.amount.amountMinor;
  if (variance === 0n) return { kind: "reconciled", movementMinor: observedSpendMovementMinor };
  return { kind: "reconciled-with-variance", movementMinor: observedSpendMovementMinor, varianceMinor: variance, drivers };
}
