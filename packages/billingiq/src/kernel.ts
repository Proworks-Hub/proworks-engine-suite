// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { rational, type MethodRef, type Rational } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// BillingIQ kernel — §16. The convention is never the engine's to pick: six
// defensible proration conventions answer 69.64 → 150.00 on one golden event
// (GP-1) and the price basis moves the answer again independently, so BOTH
// are required arguments. Tier mode is required (66.00 vs 111.00 at one
// quantity, T-GOLD-TIER2). Gapless numbering means every value in the series
// is accounted for as exactly one of issued / void-in-sequence /
// not-yet-allocated — a burned number is retained forever with its record,
// which is what makes the guarantee provable rather than asserted. The tax
// gate never softens: a zero-tax invoice is a DETERMINATION; "we do not
// know" is a refusal. roundingAmount is presented, never used to absorb a
// discrepancy — an engine that adjusts a figure to make a document balance
// is doing the forbidden thing.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const BILLING_METHODS = {
  lineNet: method("billing.line.net-amount"),
  totals: method("billing.document.totals"),
  proration: method("billing.proration"),
  tiered: method("billing.rating.tiered"),
  package: method("billing.rating.package"),
  usageIngest: method("billing.usage.ingest"),
  lateDisposition: method("billing.usage.late-disposition"),
  numbering: method("billing.numbering"),
  correction: method("billing.correction.select"),
  taxGate: method("billing.tax.gate"),
} as const satisfies Record<string, MethodRef>;

export const BILLING_REFUSAL_KINDS = [
  "invalid-price-base-quantity",
  "totals-do-not-reconcile",
  "proration-convention-required",
  "tier-mode-required",
  "zero-quantity-behaviour-required",
  "invalid-block-size",
  "usage-window-config-required",
  "number-sequence-unbound",
  "gapless-forbids-draft-allocation",
  "credit-disposition-required",
  "void-not-establishable-use-credit-note",
  "tax-determination-unresolved",
  "tax-determination-not-final",
  "tax-determination-unversioned",
] as const;
export type BillingRefusalKind = (typeof BILLING_REFUSAL_KINDS)[number];

export interface BillingRefusal {
  readonly kind: BillingRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: BillingRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: BillingRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// Half-even rounding of an exact rational to minor units — the one boundary.
export function roundHalfEven(r: Rational): bigint {
  const floor = ((): bigint => {
    const q = r.num / r.den;
    return r.num % r.den !== 0n && r.num < 0n ? q - 1n : q;
  })();
  const twiceRemainder = 2n * (r.num - floor * r.den);
  if (twiceRemainder < r.den) return floor;
  if (twiceRemainder > r.den) return floor + 1n;
  return floor % 2n === 0n ? floor : floor + 1n;
}

// ── M-1 · line net amount ───────────────────────────────────────────────────

export function lineNetAmount(
  netUnitPriceMinor: bigint,
  perQuantity: bigint,
  invoicedQuantity: bigint,
  lineChargesMinor: bigint,
  lineAllowancesMinor: bigint,
): Result<bigint> {
  const M = BILLING_METHODS.lineNet;
  if (perQuantity === 0n) {
    // A zero base quantity is a corrupt price; billing zero for it would be
    // a false answer. A typed refusal, not a division guard returning 0.
    return refuse("invalid-price-base-quantity", M, "baseQuantity is zero.");
  }
  const exact = rational(netUnitPriceMinor * invoicedQuantity, perQuantity);
  const withAdjustments = rational(
    exact.num + (lineChargesMinor - lineAllowancesMinor) * exact.den,
    exact.den,
  );
  // Rounded ONCE, at the line, after all line-level adjustments.
  return ok(roundHalfEven(withAdjustments));
}

// ── M-2 · document totals: the rounding line never absorbs ─────────────────

export interface DocumentTotalsInput {
  readonly lineNetMinor: readonly bigint[];
  readonly documentAllowancesMinor: bigint;
  readonly documentChargesMinor: bigint;
  /** FROM the tax determination, not computed here. */
  readonly taxTotalMinor: bigint;
  readonly prepaidMinor: bigint;
  /** Presented separately (EN 16931 business term); NEVER used to absorb an
   * arithmetic discrepancy. */
  readonly roundingAmountMinor: bigint;
  /** The figures the document claims — verified, not trusted. */
  readonly statedTaxExclusiveMinor: bigint;
  readonly statedAmountDueMinor: bigint;
}

export function documentTotals(
  input: DocumentTotalsInput,
): Result<{ taxExclusiveMinor: bigint; taxInclusiveMinor: bigint; amountDueMinor: bigint }> {
  const M = BILLING_METHODS.totals;
  const sumOfLines = input.lineNetMinor.reduce((a, l) => a + l, 0n);
  const taxExclusive = sumOfLines - input.documentAllowancesMinor + input.documentChargesMinor;
  const taxInclusive = taxExclusive + input.taxTotalMinor;
  const amountDue = taxInclusive - input.prepaidMinor + input.roundingAmountMinor;
  if (taxExclusive !== input.statedTaxExclusiveMinor || amountDue !== input.statedAmountDueMinor) {
    return refuse(
      "totals-do-not-reconcile",
      M,
      `Recomputed taxExclusive ${taxExclusive} vs stated ${input.statedTaxExclusiveMinor}; amountDue ${amountDue} vs stated ${input.statedAmountDueMinor}. No figure is adjusted to make a document balance.`,
    );
  }
  return ok({ taxExclusiveMinor: taxExclusive, taxInclusiveMinor: taxInclusive, amountDueMinor: amountDue });
}

// ── M-4 · proration: convention AND price basis required ───────────────────

export type ProrationConventionId =
  | "actual-seconds"
  | "calendar-day-inclusive"
  | "calendar-day-exclusive"
  | "thirty-three-sixty"
  | "credit-and-rebill"
  | "none";

export interface ProrationRequest {
  readonly convention: ProrationConventionId | undefined; // REQUIRED
  readonly priceBasis: "current-price" | "last-price-billed" | undefined; // REQUIRED
  readonly totalSecondsInPeriod: bigint;
  readonly remainingSeconds: bigint;
  readonly totalDaysInPeriod: bigint;
  readonly remainingDaysExclusive: bigint; // change day belongs to the OLD plan
  /** 30/360 remaining: 30 − changeDayOfMonth + 1. */
  readonly remainingDays30360: bigint;
  readonly oldPeriodAmountMinor: bigint;
  readonly newPeriodAmountMinor: bigint;
}

export interface ProrationResult {
  readonly creditLineMinor: bigint; // negative
  readonly debitLineMinor: bigint;
  readonly netChargeMinor: bigint;
  readonly conventionId: ProrationConventionId;
  readonly priceBasis: "current-price" | "last-price-billed";
  readonly methodRef: MethodRef;
}

export function prorate(request: ProrationRequest): Result<ProrationResult> {
  const M = BILLING_METHODS.proration;
  if (request.convention === undefined || request.priceBasis === undefined) {
    // GP-1: the four time-apportionment conventions spread 69.64 → 80.00 on a
    // 150.00 delta; with credit-and-rebill 150.00 and with none 0.00. Every
    // one is defensible and in production somewhere. No house default,
    // recommended never to be one (§12.5).
    return refuse("proration-convention-required", M, "convention and priceBasis are both required; six conventions and two bases give materially different answers on the same event.");
  }
  const finish = (creditLineMinor: bigint, debitLineMinor: bigint): Result<ProrationResult> =>
    ok({
      creditLineMinor,
      debitLineMinor,
      netChargeMinor: debitLineMinor + creditLineMinor,
      conventionId: request.convention!,
      priceBasis: request.priceBasis!,
      methodRef: M,
    });
  if (request.convention === "none") return finish(0n, 0n);
  if (request.convention === "credit-and-rebill") {
    return finish(-request.oldPeriodAmountMinor, request.newPeriodAmountMinor);
  }
  const factor: Rational = (() => {
    switch (request.convention) {
      case "actual-seconds":
        return rational(request.remainingSeconds, request.totalSecondsInPeriod);
      case "calendar-day-exclusive":
        return rational(request.remainingDaysExclusive, request.totalDaysInPeriod);
      case "calendar-day-inclusive":
        return rational(request.remainingDaysExclusive + 1n, request.totalDaysInPeriod);
      default:
        return rational(request.remainingDays30360, 30n);
    }
  })();
  // Rounded PER LINE (RB-2), half-even, scale = minor units.
  const credit = -roundHalfEven(rational(request.oldPeriodAmountMinor * factor.num, factor.den));
  const debit = roundHalfEven(rational(request.newPeriodAmountMinor * factor.num, factor.den));
  return finish(credit, debit);
}

// ── M-6 · tiered rating: mode required, one rounding at the end ─────────────

export interface Tier {
  readonly upTo: bigint | null; // null = infinity
  readonly unitAmountMinor: bigint;
  readonly flatAmountMinor: bigint;
}

export function rateTiered(
  quantity: bigint,
  tiers: readonly Tier[],
  tierMode: "graduated" | "volume" | undefined,
  zeroQuantityBehaviour: "bill-first-tier-flat" | "bill-nothing" | undefined,
): Result<bigint> {
  const M = BILLING_METHODS.tiered;
  if (tierMode === undefined) {
    // 66.00 vs 111.00 at quantity 12 from ONE tier table (T-GOLD-TIER2):
    // mode is required, never inferred.
    return refuse("tier-mode-required", M, "graduated and volume answer 68% apart on the golden table; the caller names one.");
  }
  const hasFlat = tiers.some((t) => t.flatAmountMinor !== 0n);
  if (hasFlat && zeroQuantityBehaviour === undefined) {
    return refuse(
      "zero-quantity-behaviour-required",
      M,
      "Does a customer with no usage get a bill? A commercial decision the engine must not make.",
    );
  }
  if (quantity === 0n) {
    if (!hasFlat || zeroQuantityBehaviour === "bill-nothing") return ok(0n);
    return ok(tiers[0]!.flatAmountMinor);
  }
  if (tierMode === "volume") {
    const landing = tiers.find((t) => t.upTo === null || quantity <= t.upTo) ?? tiers[tiers.length - 1]!;
    return ok(quantity * landing.unitAmountMinor + landing.flatAmountMinor);
  }
  // graduated: each band at its own amount; full precision through the walk,
  // one rounding at the end (all-minor arithmetic here is already exact).
  let remaining = quantity;
  let previousUpTo = 0n;
  let total = 0n;
  for (const tier of tiers) {
    if (remaining === 0n) break;
    const bandCapacity = tier.upTo === null ? remaining : tier.upTo - previousUpTo;
    const inBand = remaining < bandCapacity ? remaining : bandCapacity;
    if (inBand > 0n) {
      total += inBand * tier.unitAmountMinor + tier.flatAmountMinor;
      remaining -= inBand;
    }
    previousUpTo = tier.upTo ?? previousUpTo;
  }
  return ok(total);
}

/** M-7 · package pricing: a started block is a charged block — ceil is the
 * definition; a roundingMode here would be a category error and is not
 * offered. */
export function ratePackage(quantity: bigint, blockSize: bigint, blockPriceMinor: bigint): Result<bigint> {
  if (blockSize === 0n) {
    return refuse("invalid-block-size", BILLING_METHODS.package, "A zero block size is a corrupt price.");
  }
  const blocks = (quantity + blockSize - 1n) / blockSize;
  return ok(blocks * blockPriceMinor);
}

// ── M-8 · usage ingest: idempotent, windowed, honestly bounded ──────────────

export interface UsageIngestConfig {
  /** REQUIRED and finite: an unbounded window is unimplementable, and a
   * silent one is a correctness hazard. The honest consequence — an event
   * re-sent after the window counts twice — is recorded (KL-03). */
  readonly dedupWindowDays: number | undefined;
  readonly maxBackdatingDays: number | undefined;
  readonly maxFutureSkewMinutes: number | undefined;
}

export type UsageIngestOutcome =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "duplicate-suppressed" } // counted, never silently dropped
  | { readonly outcome: "rejected-out-of-window" }
  | { readonly outcome: "rejected-future" }
  | { readonly outcome: "rejected-unknown-meter" } // never rated against a guessed meter
  | { readonly outcome: "rejected-malformed"; readonly field: string };

export function ingestUsageEvent(
  config: UsageIngestConfig,
  event: { readonly sourceEventId: string; readonly meterRef: string; readonly ageDays: number; readonly futureMinutes: number },
  knownMeters: ReadonlySet<string>,
  seenKeysInWindow: ReadonlySet<string>,
): Result<UsageIngestOutcome> {
  const M = BILLING_METHODS.usageIngest;
  if (config.dedupWindowDays === undefined || config.maxBackdatingDays === undefined || config.maxFutureSkewMinutes === undefined) {
    return refuse("usage-window-config-required", M, "dedupWindow, maxBackdating and maxFutureSkew are required finite values.");
  }
  if (event.sourceEventId.trim() === "") return ok({ outcome: "rejected-malformed", field: "sourceEventId" });
  if (!knownMeters.has(event.meterRef)) return ok({ outcome: "rejected-unknown-meter" });
  if (event.futureMinutes > config.maxFutureSkewMinutes) return ok({ outcome: "rejected-future" });
  if (event.ageDays > config.maxBackdatingDays) return ok({ outcome: "rejected-out-of-window" });
  if (seenKeysInWindow.has(event.sourceEventId)) return ok({ outcome: "duplicate-suppressed" });
  return ok({ outcome: "accepted" });
}

// ── M-10 · late usage: LOCK-3 in usage form ─────────────────────────────────

export type LateUsageDisposition =
  | { readonly action: "include-in-current-window" }
  | { readonly action: "late-deferred" } // cutoff passed, draft not yet issued — the cutoff is the rule
  | {
      readonly action: "catch-up-line-next-open-period";
      readonly originPeriodRef: string;
      readonly reviewRequired: boolean;
    };

export function lateUsageDisposition(
  arrivedBeforeCutoff: boolean,
  documentState: "draft" | "issued",
  originPeriodRef: string,
  amountMinor: bigint,
  materialityThresholdMinor: bigint,
): LateUsageDisposition {
  if (arrivedBeforeCutoff && documentState === "draft") return { action: "include-in-current-window" };
  if (documentState === "draft") return { action: "late-deferred" };
  // Never: a silent restatement of a closed period, a retroactive edit, or a
  // re-issued document under the same number.
  return {
    action: "catch-up-line-next-open-period",
    originPeriodRef,
    reviewRequired: amountMinor > materialityThresholdMinor,
  };
}

// ── M-12 · gapless numbering: every value accounted for ─────────────────────

export type SeriesPosition =
  | { readonly state: "issued"; readonly value: bigint; readonly documentId: string }
  | { readonly state: "void-in-sequence"; readonly value: bigint; readonly reason: string; readonly attemptedDocumentId: string };

export interface NumberSeries {
  readonly positions: readonly SeriesPosition[];
  readonly highWaterMark: bigint;
}

export const emptySeries = (): NumberSeries => ({ positions: [], highWaterMark: 0n });

export function validateSchemeConstruction(
  gaplessRequired: boolean,
  allocationMode: "allocate-on-issue-commit" | "allocate-on-draft",
): Result<{ accepted: true }> {
  if (gaplessRequired && allocationMode === "allocate-on-draft") {
    // A number on a draft that may be abandoned is a guaranteed hole.
    return refuse("gapless-forbids-draft-allocation", BILLING_METHODS.numbering, "Gapless series allocate on issue commit only.");
  }
  return ok({ accepted: true });
}

/** Two-phase issue: reserve then commit. A failed commit BURNS the value with
 * a VoidedNumberRecord retained forever — the artifact that makes the
 * guarantee provable. The next issuance takes the NEXT value, never the
 * burned one. */
export function issueNumber(
  series: NumberSeries | undefined,
  commitSucceeds: boolean,
  documentId: string,
  failureReason = "commit failed",
): Result<{ series: NumberSeries; issuedValue: bigint | null }> {
  const M = BILLING_METHODS.numbering;
  if (series === undefined) {
    // Never a synthesized or provisional number.
    return refuse("number-sequence-unbound", M, "NumberSequencePort unbound; a document with an invented number is worse than no document.");
  }
  const value = series.highWaterMark + 1n;
  const position: SeriesPosition = commitSucceeds
    ? { state: "issued", value, documentId }
    : { state: "void-in-sequence", value, reason: failureReason, attemptedDocumentId: documentId };
  return ok({
    series: { positions: [...series.positions, position], highWaterMark: value },
    issuedValue: commitSucceeds ? value : null,
  });
}

/** Gapless attestation: every value in [1, highWaterMark] is exactly one of
 * issued or void-in-sequence; above the mark is not-yet-allocated. There is
 * no fourth state and there is no hole. */
export function attestGapless(series: NumberSeries): { gapless: boolean; holes: readonly bigint[] } {
  const occupied = new Map<bigint, number>();
  for (const p of series.positions) occupied.set(p.value, (occupied.get(p.value) ?? 0) + 1);
  const holes: bigint[] = [];
  for (let v = 1n; v <= series.highWaterMark; v++) {
    if ((occupied.get(v) ?? 0) !== 1) holes.push(v);
  }
  return { gapless: holes.length === 0, holes };
}

// ── M-14 · corrections: three instruments, never edits ──────────────────────

export type CreditDisposition = "reduce-open-item" | "customer-credit-balance" | "refund-requested" | "settled-out-of-band";

export function selectCorrection(
  instrument: "credit-note" | "void",
  paymentStateKnowable: boolean,
  downstreamFactsSeen: boolean,
  creditDisposition: CreditDisposition | undefined,
): Result<
  | { readonly instrument: "credit-note"; readonly disposition: CreditDisposition; readonly ownNumberSeries: "credit-note-series"; readonly refundExecution: "PaymentsIQ-request-only" | null }
  | { readonly instrument: "void"; readonly originalNumberRetained: true }
> {
  const M = BILLING_METHODS.correction;
  if (instrument === "void") {
    if (!paymentStateKnowable || downstreamFactsSeen) {
      // Refusing a void it cannot justify is strictly safer than voiding a
      // document a customer has already paid.
      return refuse("void-not-establishable-use-credit-note", M, "BillingIQ cannot establish the document was never acted on; issue a credit note instead.");
    }
    return ok({ instrument: "void", originalNumberRetained: true });
  }
  if (creditDisposition === undefined) {
    // BillingIQ does not infer the disposition from a payment state it does
    // not hold — payment is ReceivablesIQ's fact.
    return refuse("credit-disposition-required", M, "The caller supplies the disposition; the engine holds no payment state to infer it from.");
  }
  return ok({
    instrument: "credit-note",
    disposition: creditDisposition,
    ownNumberSeries: "credit-note-series",
    refundExecution: creditDisposition === "refund-requested" ? "PaymentsIQ-request-only" : null,
  });
}

// ── M-16 · the tax gate: the refusal that must not be softened ──────────────

export interface TaxDetermination {
  readonly state: "determined" | "pending" | "failed";
  readonly rateVersion: string | undefined;
  /** O, E and Z categories record "determined, and the answer is no tax" —
   * categorically different from missing. */
  readonly category: "S" | "E" | "R" | "O" | "Z";
}

export function taxGate(determination: TaxDetermination | undefined): Result<{ cleared: true; category: string }> {
  const M = BILLING_METHODS.taxGate;
  if (determination === undefined) {
    return refuse("tax-determination-unresolved", M, "There is no zero-tax fallback and no tax-pending issuance: an unresolved determination in an immutable, possibly authority-transmitted document asserts a position the entity never took.");
  }
  if (determination.state !== "determined") {
    return refuse("tax-determination-not-final", M, `Determination state is ${determination.state}.`);
  }
  if (determination.rateVersion === undefined) {
    return refuse("tax-determination-unversioned", M, "A determination with no rate version cannot be reproduced.");
  }
  return ok({ cleared: true, category: determination.category });
}
