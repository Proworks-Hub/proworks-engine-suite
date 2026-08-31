// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// TaxIQ kernel — §16. An unmapped item is UNDETERMINED: default-to-taxable
// and default-to-exempt are wrong in opposite directions and both are
// silent. Nexus is not an attribute — it is a function of a transaction
// history over a window, and the governing rule is asymmetric: partial
// history can ESTABLISH an obligation (monotone a-fortiori) but can never
// refute one; no-obligation requires an attestation of completeness, never
// a silence. Rounding is a versioned attribute of the jurisdiction's tax
// method, never a setting: when a jurisdiction requires line-level half-up
// and you applied invoice-level banker's rounding, you are wrong in a way
// no internal consistency repairs. A superseded determination in an
// already-aggregated period adjusts the CURRENT period (LOCK-3); the filed
// aggregate is never rewritten.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const TAX_METHODS = {
  taxability: method("M-TAXABILITY"),
  nexus: method("M-NEXUS"),
  exemption: method("M-EXEMPTION"),
  calculation: method("M-CALCULATION-AND-ROUNDING"),
  filing: method("M-FILING-AGGREGATION"),
  stacking: method("M-STACKING"),
  withholding: method("M-WITHHOLDING"),
} as const satisfies Record<string, MethodRef>;

export const TAX_REFUSAL_KINDS = [
  "item_not_classified",
  "exemption_claimed_without_evidence",
  "insufficient_location_precision",
  "no_content_for_jurisdiction",
] as const;
export type TaxRefusalKind = (typeof TAX_REFUSAL_KINDS)[number];

export interface TaxRefusal {
  readonly kind: TaxRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TaxRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: TaxRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.3 · taxability: no default in either direction ──────────────────────

export type TaxOutcomeKind = "taxable" | "exempt" | "zero-rated" | "out-of-scope" | "reverse-charge" | "undetermined";

export function determineTaxability(
  itemCategoryRef: string | null,
  categoryRules: ReadonlyMap<string, TaxOutcomeKind>,
): Result<{ outcome: TaxOutcomeKind; ruleKey: string }> {
  const M = TAX_METHODS.taxability;
  if (itemCategoryRef === null) {
    // NEVER default-to-taxable and NEVER default-to-exempt.
    return refuse("item_not_classified", M, "An unmapped item is undetermined; both defaults are wrong in opposite directions and both are silent.");
  }
  const outcome = categoryRules.get(itemCategoryRef);
  if (outcome === undefined) {
    return refuse("no_content_for_jurisdiction", M, `No taxability rule for category ${itemCategoryRef} in the active content set.`);
  }
  return ok({ outcome, ruleKey: itemCategoryRef });
}

// ── §16.4 · nexus: partial history establishes, never refutes ───────────────

export interface NexusThreshold {
  readonly jurisdictionRef: string;
  readonly amountMinor: bigint | null;
  readonly transactionCount: number | null;
  readonly combinator: "and" | "or";
  /** Some jurisdictions count nontaxable sales toward the threshold; some
   * exclude resale — a field, never an assumption. */
  readonly includesExemptSales: boolean;
  readonly includesResale: boolean;
  /** Crossing is not collecting: e.g. first day of the fourth month after
   * the crossing month. Supplied as content. */
  readonly collectionStartLagMonths: number;
}

export interface NexusWindowCoverage {
  readonly observedMeasureMinor: bigint;
  readonly observedTransactionCount: number;
  readonly completeness: "complete-attested" | "engine-observed-only" | "unknown";
  readonly attestedBy?: string;
  /** True when the observed set may be OVER-inclusive under this threshold's
   * measure (e.g. resale/exempt sales present but the measure excludes them)
   * — the monotone a-fortiori argument then fails in the other direction. */
  readonly observedSetMayOverstate: boolean;
}

export type NexusResult =
  | {
      readonly kind: "obligation-established";
      readonly basis: "monotone-a-fortiori" | "complete-coverage";
      readonly collectionStartLagMonths: number;
    }
  | { readonly kind: "no-obligation"; readonly marginToThresholdMinor: bigint }
  | {
      readonly kind: "indeterminate";
      readonly reason: "incomplete-transaction-coverage" | "measure-not-computable-from-available-fields";
      readonly whatWouldResolveIt: string;
    };

export function evaluateNexus(threshold: NexusThreshold, coverage: NexusWindowCoverage): NexusResult {
  const amountMet = threshold.amountMinor !== null && coverage.observedMeasureMinor >= threshold.amountMinor;
  const countMet = threshold.transactionCount !== null && coverage.observedTransactionCount >= threshold.transactionCount;
  const met = threshold.combinator === "and" ? amountMet && countMet : amountMet || countMet;
  const complete = coverage.completeness === "complete-attested";
  if (met) {
    if (!complete && coverage.observedSetMayOverstate) {
      // The observed value could overstate under this measure definition:
      // MonotoneBasis is only granted for a provable subset.
      return {
        kind: "indeterminate",
        reason: "measure-not-computable-from-available-fields",
        whatWouldResolveIt: "Classify the observed transactions under the threshold's measure (resale/exempt separation) or attest completeness.",
      };
    }
    // Partial history CAN establish an obligation: observed ⊆ actual and the
    // measure is monotone, so observed ≥ threshold ⇒ actual ≥ threshold.
    return {
      kind: "obligation-established",
      basis: complete ? "complete-coverage" : "monotone-a-fortiori",
      collectionStartLagMonths: threshold.collectionStartLagMonths,
    };
  }
  if (!complete) {
    // observed < threshold says NOTHING about the unobserved remainder.
    // NEVER no-obligation: a false negative here is a liability the seller
    // personally funds, discovered on audit years later with penalties.
    return {
      kind: "indeterminate",
      reason: "incomplete-transaction-coverage",
      whatWouldResolveIt: "A completeness attestation over the window by a named principal.",
    };
  }
  const margin = threshold.amountMinor !== null ? threshold.amountMinor - coverage.observedMeasureMinor : 0n;
  return { kind: "no-obligation", marginToThresholdMinor: margin };
}

// ── §16.5 · exemption: per-jurisdiction, evidenced, replay-stable ───────────

export interface ExemptionCertificate {
  readonly certificateRef: string;
  readonly coveredJurisdictionRefs: readonly string[];
  readonly validFrom: string;
  readonly validTo: string;
  readonly scope: "resale" | "entity-exempt" | "single-purchase";
  readonly consumedByTransactionRef: string | null;
}

export type JurisdictionExemption =
  | { readonly jurisdictionRef: string; readonly outcome: "exempt"; readonly certificateRef: string }
  | { readonly jurisdictionRef: string; readonly outcome: "taxable"; readonly reason: string };

export function evaluateExemption(
  jurisdictionStack: readonly string[],
  claimedScope: "resale" | "entity-exempt" | "single-purchase",
  certificate: ExemptionCertificate | undefined,
  taxPointDate: string,
  transactionRef: string,
): Result<readonly JurisdictionExemption[]> {
  const M = TAX_METHODS.exemption;
  if (certificate === undefined) {
    // A claimed exemption with no evidence is a BLOCKING refusal: an exempt
    // invoice with no supporting document is precisely what an audit assesses.
    return refuse("exemption_claimed_without_evidence", M, `Exemption (${claimedScope}) claimed with no certificate evidence.`);
  }
  // Expiry against the TAX POINT DATE, not today: a certificate that expired
  // last month was valid for a supply made two months ago, and replay must
  // reproduce exempt.
  const validAtTaxPoint = taxPointDate >= certificate.validFrom && taxPointDate <= certificate.validTo;
  const scopeMatches = certificate.scope === claimedScope || (certificate.scope === "single-purchase" && claimedScope === "single-purchase");
  const consumed =
    certificate.scope === "single-purchase" &&
    certificate.consumedByTransactionRef !== null &&
    certificate.consumedByTransactionRef !== transactionRef;
  return ok(
    jurisdictionStack.map((jurisdictionRef): JurisdictionExemption => {
      if (!validAtTaxPoint) return { jurisdictionRef, outcome: "taxable", reason: "certificate not valid at tax point date" };
      if (!scopeMatches) return { jurisdictionRef, outcome: "taxable", reason: `certificate scope ${certificate.scope} does not cover ${claimedScope}` };
      if (consumed) return { jurisdictionRef, outcome: "taxable", reason: "single-purchase certificate already consumed" };
      // Validity is PER JURISDICTION: a partial exemption is the single most
      // common real-world exemption error, made explicit here.
      if (!certificate.coveredJurisdictionRefs.includes(jurisdictionRef)) {
        return { jurisdictionRef, outcome: "taxable", reason: "certificate does not cover this jurisdiction" };
      }
      return { jurisdictionRef, outcome: "exempt", certificateRef: certificate.certificateRef };
    }),
  );
}

// ── §16.6 · calculation and rounding: a versioned method, never a setting ───

export interface RoundingMethod {
  readonly jurisdictionRef: string;
  readonly level: "line" | "per-rate-subtotal" | "invoice";
  readonly mode: "half-up" | "half-even";
  readonly residualAllocation: "largest-remainder" | "last-line";
}

const roundAt = (numerator: bigint, denominator: bigint, mode: "half-up" | "half-even"): bigint => {
  const q = numerator / denominator;
  const rem = numerator % denominator;
  if (rem === 0n) return q;
  const twice = 2n * (rem < 0n ? -rem : rem);
  const bump = numerator < 0n ? -1n : 1n;
  if (twice > denominator) return q + bump;
  if (twice < denominator) return q;
  if (mode === "half-up") return q + bump;
  return q % 2n === 0n ? q : q + bump;
};

/**
 * Line-level tax: compute each base at full precision, apply the rate exactly,
 * round ONCE at the method's level. Never round twice; never round then sum.
 */
export function computeTax(
  lineNetMinor: readonly bigint[],
  ratePermille: bigint,
  roundingMethod: RoundingMethod,
): { perLineTaxMinor: readonly bigint[]; totalTaxMinor: bigint; allocationRecorded: boolean } {
  if (roundingMethod.level === "line") {
    const perLine = lineNetMinor.map((net) => roundAt(net * ratePermille, 1000n, roundingMethod.mode));
    return { perLineTaxMinor: perLine, totalTaxMinor: perLine.reduce((a, t) => a + t, 0n), allocationRecorded: false };
  }
  // invoice / per-rate-subtotal: exact sum first, one rounding, then the
  // rounded total allocated back — and the allocation is RECORDED, because a
  // line may differ by a minor unit from a naive per-line computation.
  const exactTotalNumerator = lineNetMinor.reduce((a, net) => a + net * ratePermille, 0n);
  const total = roundAt(exactTotalNumerator, 1000n, roundingMethod.mode);
  const naive = lineNetMinor.map((net) => (net * ratePermille) / 1000n); // floors
  let residual = total - naive.reduce((a, t) => a + t, 0n);
  const remainders = lineNetMinor.map((net, i) => ({ i, rem: (net * ratePermille) % 1000n }));
  const order =
    roundingMethod.residualAllocation === "largest-remainder"
      ? [...remainders].sort((a, b) => (a.rem !== b.rem ? (b.rem > a.rem ? 1 : -1) : a.i - b.i))
      : [...remainders].reverse();
  const perLine = [...naive];
  for (const { i } of order) {
    if (residual <= 0n) break;
    perLine[i] = perLine[i]! + 1n;
    residual -= 1n;
  }
  return { perLineTaxMinor: perLine, totalTaxMinor: total, allocationRecorded: true };
}

/**
 * G-11: the tax-inclusive split. 79.20 at 19%: no cent pair both sums to the
 * gross and reproduces the rate exactly. The GROSS is preserved, the applied
 * rate stays 19% in the capture, and the apparent-rate divergence is stated —
 * never presented as the rate.
 */
export function taxInclusiveSplit(
  grossMinor: bigint,
  ratePermille: bigint,
): {
  netMinor: bigint;
  taxMinor: bigint;
  preservedInvariant: "gross";
  appliedRatePermille: bigint;
  apparentRateDiffersFromApplied: boolean;
} {
  // net = gross / (1 + rate), rounded half-up at the minor boundary.
  const netMinor = roundAt(grossMinor * 1000n, 1000n + ratePermille, "half-up");
  const taxMinor = grossMinor - netMinor; // gross preserved by construction
  const apparentDiffers = taxMinor * 1000n !== netMinor * ratePermille;
  return { netMinor, taxMinor, preservedInvariant: "gross", appliedRatePermille: ratePermille, apparentRateDiffersFromApplied: apparentDiffers };
}

// ── §16.7 · filing aggregation: immutable, adjusted never rewritten ─────────

export interface Determination {
  readonly determinationId: string;
  readonly periodRef: string;
  readonly outcome: TaxOutcomeKind;
  readonly taxMinor: bigint;
  readonly supersededBy: string | null;
}

export interface FilingAggregate {
  readonly periodRef: string;
  readonly aggregatedAt: string;
  readonly byOutcome: Readonly<Record<string, { taxMinor: bigint; count: number; determinationIds: readonly string[] }>>;
  readonly priorPeriodAdjustments: readonly { originalDeterminationId: string; supersedingDeterminationId: string; deltaMinor: bigint }[];
  readonly immutable: true;
}

export function aggregateFiling(
  periodRef: string,
  aggregatedAt: string,
  determinations: readonly Determination[],
  supersessionsOfFiledPeriods: readonly { originalDeterminationId: string; supersedingDeterminationId: string; deltaMinor: bigint }[],
): FilingAggregate {
  const byOutcome: Record<string, { taxMinor: bigint; count: number; determinationIds: string[] }> = {};
  for (const d of determinations) {
    // Only CURRENT determinations at the aggregation instant.
    if (d.supersededBy !== null || d.periodRef !== periodRef) continue;
    const bucket = (byOutcome[d.outcome] ??= { taxMinor: 0n, count: 0, determinationIds: [] });
    bucket.taxMinor += d.taxMinor;
    bucket.count += 1;
    bucket.determinationIds.push(d.determinationId); // drill-down is a lookup, not a re-query
  }
  return {
    periodRef,
    aggregatedAt,
    byOutcome,
    // A superseded determination in an ALREADY-AGGREGATED period lands here,
    // in the current period — rewriting a filed period is the restatement
    // LOCK-3 forbids.
    priorPeriodAdjustments: supersessionsOfFiledPeriods,
    immutable: true,
  };
}

// ── §16.8 · stacking: ordered, each component names its base ────────────────

export interface StackComponent {
  readonly taxTypeRef: string;
  readonly sequence: number; // explicit, never derived from array order
  readonly ratePermille: bigint;
  /** Tax-on-tax is real (Directive Art 78): a component's base may include
   * prior components — DECLARED, never an implicit running total. */
  readonly baseIncludesComponents: readonly string[];
}

export function computeStack(
  netMinor: bigint,
  components: readonly StackComponent[],
  mode: "half-up" | "half-even" = "half-even",
): readonly { taxTypeRef: string; baseMinor: bigint; taxMinor: bigint }[] {
  const ordered = [...components].sort((a, b) => a.sequence - b.sequence);
  const computed = new Map<string, bigint>();
  return ordered.map((component) => {
    let base = netMinor;
    for (const includedRef of component.baseIncludesComponents) {
      base += computed.get(includedRef) ?? 0n;
    }
    const tax = roundAt(base * component.ratePermille, 1000n, mode);
    computed.set(component.taxTypeRef, tax);
    return { taxTypeRef: component.taxTypeRef, baseMinor: base, taxMinor: tax };
  });
}

// ── §16.9 · withholding: not-substantiated is a determination, not a fallback

export interface WithholdingDetermination {
  readonly appliedRatePermille: bigint;
  readonly treatyRelief: "applied" | "not-substantiated" | "no-treaty";
  /** Same number as statutory today, different consequences later — the
   * evidence gap is NAMED. */
  readonly evidenceGap: string | null;
  readonly withheldMinor: bigint;
  readonly executionNote: "TaxIQ determines; PaymentsIQ withholds; LedgerIQ posts";
}

export function determineWithholding(
  grossMinor: bigint,
  statutoryRatePermille: bigint,
  treaty: { treatyRatePermille: bigint; documentationEvidenceRef: string | null; lobSatisfied: boolean } | null,
): WithholdingDetermination {
  const finish = (rate: bigint, relief: WithholdingDetermination["treatyRelief"], gap: string | null): WithholdingDetermination => ({
    appliedRatePermille: rate,
    treatyRelief: relief,
    evidenceGap: gap,
    withheldMinor: roundAt(grossMinor * rate, 1000n, "half-up"),
    executionNote: "TaxIQ determines; PaymentsIQ withholds; LedgerIQ posts",
  });
  if (treaty === null) return finish(statutoryRatePermille, "no-treaty", null);
  if (treaty.documentationEvidenceRef === null) {
    return finish(statutoryRatePermille, "not-substantiated", "documentation evidence (W-8BEN / W-8BEN-E) absent");
  }
  if (!treaty.lobSatisfied) {
    return finish(statutoryRatePermille, "not-substantiated", "limitation-on-benefits article not satisfied");
  }
  return finish(treaty.treatyRatePermille, "applied", null);
}
