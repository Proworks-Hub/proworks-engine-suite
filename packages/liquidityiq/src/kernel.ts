// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// LiquidityIQ kernel — §16. The coverage lattice is the engine's centre:
// completeness is complete > partial > insufficient, bucket n's opening
// balance is bucket n−1's closing balance, so PARTIALITY PROPAGATES FORWARD
// AND NEVER RECOVERS. The `complete` variant is the ONLY one carrying a
// projected closing balance — the type, not documentation, prevents a number
// over a hole. `netOfKnown` is named to read like the fragment it is.
// A notional pool's offset is a PooledView, never a balance: legally the
// offset depends on a right of set-off that can be challenged in insolvency,
// and typing it as a balance tells a treasurer they can draw money they
// cannot.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const LIQUIDITY_METHODS = {
  forecast: method("M-DIR-FCST"),
  coverage: method("M-COVERAGE"),
  workingCapital: method("M-WC-METRICS"),
  ccc: method("M-CCC"),
  buffer: method("M-BUF"),
  gap: method("M-GAP"),
  poolNotional: method("M-POOL-NOTIONAL"),
  dedup: method("M-DEDUP-INFLIGHT"),
  fxCons: method("M-FX-CONS"),
} as const satisfies Record<string, MethodRef>;

export const LIQUIDITY_REFUSAL_KINDS = [
  "variant_axis_unselected",
  "ccc_basis_mismatch",
  "buffer_cell_mismatch",
  "buffer_window_not_complete",
  "fx_rate_unavailable",
  "notional_pool_needs_rate_set",
] as const;
export type LiquidityRefusalKind = (typeof LIQUIDITY_REFUSAL_KINDS)[number];

export interface LiquidityRefusal {
  readonly kind: LiquidityRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LiquidityRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: LiquidityRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.4 · the coverage lattice and the forecast ───────────────────────────

/** The four-cell balance taxonomy: what the bank asserts vs what the ledger
 * says, on booking vs value dates. Comparing across cells is the invisible
 * error in every product that gets buffers wrong. */
export type BalanceCell = "available@value" | "available@booking" | "ledger@value" | "ledger@booking";

export interface BucketInput {
  readonly bucketRef: string;
  readonly knownInflowMinor: bigint;
  readonly knownOutflowMinor: bigint;
  /** Legs the caller knows are unbound or degraded for this bucket. */
  readonly missingLegs: readonly string[];
  /** Supplied TimingProfile refs or quarantined indirect projections (L-2):
   * each makes the bucket at best partial. */
  readonly quarantined: readonly string[];
  /** True only when the caller cannot even establish the opening picture. */
  readonly insufficient?: string;
}

export type ForecastBucket =
  | {
      readonly completeness: "complete";
      readonly bucketRef: string;
      readonly netOfKnownMinor: bigint;
      /** The ONLY variant carrying a closing balance. */
      readonly projectedClosingMinor: bigint;
    }
  | {
      readonly completeness: "partial";
      readonly bucketRef: string;
      /** Deliberately awkward name: `netCashFlow` reads like the answer;
       * `netOfKnown` reads like the fragment it is. */
      readonly netOfKnownMinor: bigint;
      readonly missingLegs: readonly string[];
      readonly quarantined: readonly string[];
      // no closing balance — structurally absent
    }
  | {
      readonly completeness: "insufficient";
      readonly bucketRef: string;
      readonly reason: string;
      // no numbers at all
    };

/**
 * M-DIR-FCST + M-COVERAGE. Not a model — no parameter is estimated; the
 * commitments arrive as facts. completeness(b) = min(completeness(b−1),
 * local(b)) on the ordered lattice, so one unbound leg on day one makes every
 * later bucket at best partial — the honest answer commercial products avoid.
 */
export function buildForecast(
  openingBalanceMinor: bigint | { readonly unknown: string },
  buckets: readonly BucketInput[],
): readonly ForecastBucket[] {
  const rank = { complete: 2, partial: 1, insufficient: 0 } as const;
  let carried: keyof typeof rank =
    typeof openingBalanceMinor === "bigint" ? "complete" : "insufficient";
  let carriedReason = typeof openingBalanceMinor === "bigint" ? "" : openingBalanceMinor.unknown;
  let closing = typeof openingBalanceMinor === "bigint" ? openingBalanceMinor : 0n;
  const out: ForecastBucket[] = [];
  for (const b of buckets) {
    const local: keyof typeof rank =
      b.insufficient !== undefined
        ? "insufficient"
        : b.missingLegs.length > 0 || b.quarantined.length > 0
          ? "partial"
          : "complete";
    const state: keyof typeof rank = rank[local] < rank[carried] ? local : carried;
    const net = b.knownInflowMinor - b.knownOutflowMinor;
    if (state === "complete") {
      closing = closing + net;
      out.push({ completeness: "complete", bucketRef: b.bucketRef, netOfKnownMinor: net, projectedClosingMinor: closing });
    } else if (state === "partial") {
      out.push({
        completeness: "partial",
        bucketRef: b.bucketRef,
        netOfKnownMinor: net,
        missingLegs: b.missingLegs,
        quarantined: b.quarantined,
      });
    } else {
      out.push({
        completeness: "insufficient",
        bucketRef: b.bucketRef,
        reason: b.insufficient ?? carriedReason ?? "opening balance unknown",
      });
    }
    carried = state;
    if (b.insufficient !== undefined) carriedReason = b.insufficient;
  }
  return out;
}

// ── §16.6 · working-capital metrics: the variant is required ────────────────

export interface WorkingCapitalVariant {
  readonly balanceBasis: "average-of-endpoints" | "ending" | "time-weighted-average";
  readonly dayCount: 365 | 360;
  readonly denominator: "credit-sales" | "total-revenue" | "cogs" | "purchases";
}

export interface MetricResult {
  readonly metric: "dso" | "dpo" | "dio";
  readonly daysTimes100: bigint; // exact hundredths of a day
  readonly variant: WorkingCapitalVariant;
  readonly methodRef: MethodRef;
}

/** Every variant axis is required — the spread between defensible variants is
 * wider than the decisions made on top of them (the yieldMethod precedent,
 * D-1). No default anywhere. */
export function workingCapitalMetric(
  metric: "dso" | "dpo" | "dio",
  openingBalanceMinor: bigint,
  closingBalanceMinor: bigint,
  denominatorFlowMinor: bigint,
  variant: WorkingCapitalVariant | undefined,
): Result<MetricResult> {
  const M = LIQUIDITY_METHODS.workingCapital;
  if (variant === undefined) {
    return refuse(
      "variant_axis_unselected",
      M,
      `${metric.toUpperCase()} has no default variant: balanceBasis × dayCount × denominator each move the answer.`,
    );
  }
  if (denominatorFlowMinor === 0n) {
    return refuse("variant_axis_unselected", M, "A zero denominator flow yields no defined metric.");
  }
  const balance =
    variant.balanceBasis === "ending"
      ? closingBalanceMinor
      : (openingBalanceMinor + closingBalanceMinor) / 2n; // average-of-endpoints; time-weighted needs the series and is supplied pre-averaged
  const daysTimes100 = (balance * BigInt(variant.dayCount) * 100n) / denominatorFlowMinor;
  return ok({ metric, daysTimes100, variant, methodRef: M });
}

/** CCC = DIO + DSO − DPO — but ONLY over metrics computed on the same
 * balanceBasis and dayCount. Mixing bases is refused, not averaged. */
export function cashConversionCycle(
  dso: MetricResult,
  dpo: MetricResult,
  dio: MetricResult,
): Result<{ cccDaysTimes100: bigint; methodRef: MethodRef }> {
  const M = LIQUIDITY_METHODS.ccc;
  const basis = (m: MetricResult): string => `${m.variant.balanceBasis}/${m.variant.dayCount}`;
  if (basis(dso) !== basis(dpo) || basis(dso) !== basis(dio)) {
    return refuse(
      "ccc_basis_mismatch",
      M,
      `CCC over mixed bases is not a cycle: DSO ${basis(dso)}, DPO ${basis(dpo)}, DIO ${basis(dio)}.`,
    );
  }
  return ok({ cccDaysTimes100: dio.daysTimes100 + dso.daysTimes100 - dpo.daysTimes100, methodRef: M });
}

// ── §16.7 · buffer evaluation: measured against a NAMED cell ────────────────

export interface BufferPolicy {
  readonly policyRef: string;
  readonly requiredMinimumMinor: bigint;
  /** REQUIRED: which of the four cells this minimum is measured against.
   * Comparing an available@value minimum to a ledger@booking balance is the
   * invisible error — here it is a refusal. */
  readonly measuredAgainst: BalanceCell;
}

export type Sufficiency = "above" | "at" | "below" | "undeterminable";

export interface BufferEvaluation {
  readonly policyRef: string;
  readonly sufficiency: Sufficiency; // deliberately no health word in the vocabulary
  readonly headroomMinor: bigint | null;
  readonly methodRef: MethodRef;
}

export function evaluateBuffer(
  policy: BufferPolicy,
  comparable: { readonly cell: BalanceCell; readonly minor: bigint },
): Result<BufferEvaluation> {
  const M = LIQUIDITY_METHODS.buffer;
  if (policy.measuredAgainst !== comparable.cell) {
    return refuse(
      "buffer_cell_mismatch",
      M,
      `Policy ${policy.policyRef} is measured against ${policy.measuredAgainst}; the supplied balance is ${comparable.cell}. Both are "the balance", and they are different numbers.`,
    );
  }
  const headroom = comparable.minor - policy.requiredMinimumMinor;
  return ok({
    policyRef: policy.policyRef,
    sufficiency: headroom > 0n ? "above" : headroom === 0n ? "at" : "below",
    headroomMinor: headroom,
    methodRef: M,
  });
}

/** days-of-outflow requires a COMPLETE forecast for exactly those days: a
 * minimum computed from a partial outflow view is too small in the direction
 * that causes an overdraft. */
export function daysOfOutflowRequirement(
  forecast: readonly ForecastBucket[],
  days: number,
): Result<{ requiredMinimumMinor: bigint }> {
  const M = LIQUIDITY_METHODS.buffer;
  const window = forecast.slice(0, days);
  if (window.length < days || window.some((b) => b.completeness !== "complete")) {
    const gaps = window
      .filter((b) => b.completeness !== "complete")
      .map((b) => b.bucketRef)
      .join(", ");
    return refuse(
      "buffer_window_not_complete",
      M,
      `days-of-outflow(${days}) needs a complete forecast for the window; not complete at: ${gaps || "window short"}. The requirement is undeterminable, not smaller.`,
    );
  }
  let outflow = 0n;
  for (const b of window) {
    if (b.completeness === "complete" && b.netOfKnownMinor < 0n) outflow += -b.netOfKnownMinor;
  }
  return ok({ requiredMinimumMinor: outflow });
}

// ── §16.9 · funding gap: two thresholds, two questions ──────────────────────

export interface FundingGap {
  readonly firstBucketBelowBuffer: string | null; // policy breached: treasurer acts
  readonly firstBucketBelowZero: string | null; // account overdraws: the bank acts
  readonly peakShortfallMinor: bigint;
  /** A gap identified over partial buckets is partial-evidence, and the
   * payload states BOTH error directions rather than assuming one. */
  readonly gapConfidence: "evidenced" | "partial-evidence" | "undeterminable";
  readonly methodRef: MethodRef;
}

export function identifyFundingGap(
  forecast: readonly ForecastBucket[],
  bufferMinor: bigint,
): FundingGap {
  let firstBelowBuffer: string | null = null;
  let firstBelowZero: string | null = null;
  let peak = 0n;
  let sawPartial = false;
  let sawComplete = false;
  for (const b of forecast) {
    if (b.completeness === "complete") {
      sawComplete = true;
      if (firstBelowBuffer === null && b.projectedClosingMinor < bufferMinor) firstBelowBuffer = b.bucketRef;
      if (firstBelowZero === null && b.projectedClosingMinor < 0n) firstBelowZero = b.bucketRef;
      if (b.projectedClosingMinor < peak) peak = b.projectedClosingMinor;
    } else {
      sawPartial = true;
    }
  }
  return {
    firstBucketBelowBuffer: firstBelowBuffer,
    firstBucketBelowZero: firstBelowZero,
    peakShortfallMinor: peak < 0n ? -peak : 0n,
    gapConfidence: !sawComplete ? "undeterminable" : sawPartial ? "partial-evidence" : "evidenced",
    methodRef: LIQUIDITY_METHODS.gap,
  };
}

// ── §16.8 · pooling: a notional offset is a VIEW, never a balance ───────────

/** Distinct type, deliberately NOT structurally compatible with a
 * bank-asserted balance: it carries the offsetting agreement and the
 * right-of-set-off status because the offset is only as good as that right. */
export interface PooledView {
  readonly kind: "pooled-view";
  readonly offsetMinor: bigint;
  readonly participants: readonly { accountRef: string; balanceMinor: bigint }[];
  readonly offsetAgreementRef: string;
  readonly rightOfSetOffStatus: "confirmed" | "asserted" | "unknown";
  readonly methodRef: MethodRef;
}

export function notionalPoolView(
  participants: readonly { accountRef: string; balanceMinor: bigint; currencyCode: string }[],
  offsetAgreementRef: string,
  rightOfSetOffStatus: PooledView["rightOfSetOffStatus"],
  fxRateSetRef?: string,
): Result<PooledView> {
  const M = LIQUIDITY_METHODS.poolNotional;
  const currencies = new Set(participants.map((p) => p.currencyCode));
  if (currencies.size > 1 && fxRateSetRef === undefined) {
    return refuse(
      "notional_pool_needs_rate_set",
      M,
      `Multi-currency notional offsetting needs a rate AND a legal basis; currencies: ${[...currencies].join(", ")}, no FxRateSet supplied.`,
    );
  }
  return ok({
    kind: "pooled-view",
    offsetMinor: participants.reduce((a, p) => a + p.balanceMinor, 0n),
    participants: participants.map((p) => ({ accountRef: p.accountRef, balanceMinor: p.balanceMinor })),
    offsetAgreementRef,
    rightOfSetOffStatus,
    methodRef: M,
  });
}

// ── §16.10 · in-flight deduplication: exact match only ──────────────────────

export interface DedupOutcome {
  /** Commitments removed because a bank reference matched a booked entry. */
  readonly removedCommitmentRefs: readonly string[];
  /** In-flight with no match: stays in the ladder as scheduled. */
  readonly retainedCommitmentRefs: readonly string[];
  /** With the port unbound the ladder is partial by construction, and the
   * DIRECTION of the error is stated: outflows may be double-counted, so the
   * forecast is pessimistic in an unquantified amount. */
  readonly portUnbound: { readonly missingLeg: string; readonly errorDirection: "pessimistic-outflows-may-double-count" } | null;
  readonly methodRef: MethodRef;
}

export function dedupInFlight(
  inFlight: readonly { commitmentRef: string; bankReference: string | null }[] | { readonly unbound: true },
  bookedBankReferences: ReadonlySet<string>,
): DedupOutcome {
  const M = LIQUIDITY_METHODS.dedup;
  if ("unbound" in inFlight) {
    return {
      removedCommitmentRefs: [],
      retainedCommitmentRefs: [],
      portUnbound: { missingLeg: "PaymentInFlightPort", errorDirection: "pessimistic-outflows-may-double-count" },
      methodRef: M,
    };
  }
  const removed: string[] = [];
  const retained: string[] = [];
  for (const p of inFlight) {
    // Exact-match only. Fuzzy matching is cash application — ReceivablesIQ's —
    // and a wrong fuzzy match silently deletes a real outflow.
    if (p.bankReference !== null && bookedBankReferences.has(p.bankReference)) removed.push(p.commitmentRef);
    else retained.push(p.commitmentRef);
  }
  return { removedCommitmentRefs: removed, retainedCommitmentRefs: retained, portUnbound: null, methodRef: M };
}

// ── §16.13 · FX consolidation: whole or refused ─────────────────────────────

export interface FxRateSet {
  readonly rateSetId: string;
  readonly source: string;
  readonly effectiveDate: string;
  /** rate scaled by 1e8, quote per base. */
  readonly quotes: readonly { base: string; quote: string; rateE8: bigint }[];
}

export function consolidateFx(
  positions: readonly { currencyCode: string; minor: bigint }[],
  reportingCurrency: string,
  rateSet: FxRateSet | undefined,
): Result<{ consolidatedMinor: bigint; rateSetId: string }> {
  const M = LIQUIDITY_METHODS.fxCons;
  const foreign = [...new Set(positions.map((p) => p.currencyCode).filter((c) => c !== reportingCurrency))];
  if (foreign.length > 0 && rateSet === undefined) {
    // Not a partial sum of the same-currency subset presented as the total.
    return refuse("fx_rate_unavailable", M, `No FxRateSet; missing pairs: ${foreign.map((c) => `${c}/${reportingCurrency}`).join(", ")}.`);
  }
  let total = 0n;
  for (const p of positions) {
    if (p.currencyCode === reportingCurrency) {
      total += p.minor;
      continue;
    }
    const quote = rateSet!.quotes.find((q) => q.base === p.currencyCode && q.quote === reportingCurrency);
    if (quote === undefined) {
      return refuse("fx_rate_unavailable", M, `Rate set ${rateSet!.rateSetId} lacks ${p.currencyCode}/${reportingCurrency}.`);
    }
    // Half-even at the minor-unit boundary — one rounding, per position leg.
    const numerator = p.minor * quote.rateE8;
    const q = numerator / 100_000_000n;
    const rem = numerator % 100_000_000n;
    const half = 50_000_000n;
    const rounded =
      rem > half || (rem === half && q % 2n !== 0n) ? q + 1n : rem < -half || (rem === -half && q % 2n !== 0n) ? q - 1n : q;
    total += rounded;
  }
  return ok({ consolidatedMinor: total, rateSetId: rateSet?.rateSetId ?? "none-needed" });
}
