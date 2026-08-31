// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// InvoiceIQ kernel — §16. The TYPE carries the honesty rule: a two-way match
// result has no goods-receipt field to read (not optional — absent), a
// skipped check can never produce `matched` (the first branch of verdictFrom
// is checksNotEvaluated → indeterminate), and a degraded match is labelled
// at the result with a required authorization. Duplicate detection computes
// at most `review-required`: there is NO code path from a signal evaluation
// to `confirmed-duplicate` — only recordDuplicateDecision, with a human
// principal and a Governance reference, reaches it (G-9/LOCK-2 made
// falsifiable). An unconfigured tolerance dimension is not an infinite
// tolerance; the scheme author says it out loud or the scheme is refused.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const INVOICE_METHODS = {
  matchDegree: method("match.degree"),
  matchEvaluate: method("match.evaluate"),
  totalsReconcile: method("invoice.totals-reconcile"),
  tolerance: method("match.tolerance"),
  duplicate: method("duplicate.detect"),
  supersede: method("invoice.supersede"),
  approvalReadiness: method("invoice.approval-readiness"),
} as const satisfies Record<string, MethodRef>;

export const INVOICE_REFUSAL_KINDS = [
  "capability-not-chartered",
  "insufficient-legs",
  "degradation-authorization-missing",
  "tolerance-scheme-invalid",
  "approval-authorization-missing",
  "duplicate-decision-authorization-missing",
] as const;
export type InvoiceRefusalKind = (typeof INVOICE_REFUSAL_KINDS)[number];

export interface InvoiceRefusal {
  readonly kind: InvoiceRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: InvoiceRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: InvoiceRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.1/§16.2 · the degree ladder and the match result union ──────────────

/** four-way is DECLARED and unchartered: if the enum stopped at three-way,
 * "the highest available match" would read as "the strongest possible
 * verification" — false wherever goods are inspected before acceptance. */
export type MatchDegree = "two-way" | "three-way" | "four-way";

export type MatchVerdict = "matched" | "matched-within-tolerance" | "exception" | "indeterminate";

export interface DimensionCheck {
  readonly dimension: string;
  readonly outcome: "pass" | "pass-within-tolerance" | "fail";
}

export interface NotEvaluated {
  readonly dimension: string;
  readonly reason: string;
}

/** The first branch is the honesty rule: a check that COULD NOT RUN makes the
 * whole verdict indeterminate — a skipped check can never produce matched.
 * indeterminate is not exception: missing evidence and a disagreement
 * between documents are fixed by different people. */
export function verdictFrom(
  results: readonly DimensionCheck[],
  checksNotEvaluated: readonly NotEvaluated[],
): MatchVerdict {
  if (checksNotEvaluated.length > 0) return "indeterminate";
  if (results.some((r) => r.outcome === "fail")) return "exception";
  if (results.some((r) => r.outcome === "pass-within-tolerance")) return "matched-within-tolerance";
  return "matched";
}

export interface MatchDegradation {
  readonly requestedDegree: MatchDegree;
  readonly performedDegree: MatchDegree;
  readonly missingLegs: readonly string[];
  readonly reason: string;
  readonly authorizationRef: string;
}

interface MatchCommon {
  readonly documentId: string;
  readonly verdict: MatchVerdict;
  readonly asOf: string;
  readonly lineResults: readonly DimensionCheck[];
  readonly checksNotEvaluated: readonly NotEvaluated[];
  readonly methodRef: MethodRef;
}

export interface TwoWayMatchResult extends MatchCommon {
  readonly degree: "two-way";
  readonly purchaseOrderRef: string;
  // NOTE: no goodsReceipt field — not optional, ABSENT. A consumer cannot
  // read a two-way result as a three-way one.
  readonly degradation?: MatchDegradation;
}

export interface ThreeWayMatchResult extends MatchCommon {
  readonly degree: "three-way";
  readonly purchaseOrderRef: string;
  readonly goodsReceiptRef: string; // REQUIRED, not nullable.
  readonly degradation?: never; // a three-way result cannot be degraded
}

export type MatchResult = TwoWayMatchResult | ThreeWayMatchResult;

export interface MatchRequest {
  readonly documentId: string;
  readonly asOf: string;
  readonly requestedDegree: MatchDegree;
  readonly purchaseOrderRef: string | null;
  readonly goodsReceiptRef: string | null;
  /** REQUIRED, no default: a caller that forgets gets a refusal, not a
   * silent degradation. */
  readonly onInsufficientLegs: "refuse" | "degrade" | "degrade-if-authorized-else-refuse" | undefined;
  readonly degradationAuthorizationRef: string | null;
  readonly lineResults: readonly DimensionCheck[];
  readonly checksNotEvaluated: readonly NotEvaluated[];
}

export function evaluateMatch(request: MatchRequest): Result<MatchResult> {
  const M = INVOICE_METHODS.matchEvaluate;
  if (request.requestedDegree === "four-way") {
    return refuse(
      "capability-not-chartered",
      M,
      "The Ownership Lock grants InvoiceIQ two-way and three-way match. four-way is declared so three-way is visibly not the top rung, and refused because claiming it would be claiming an InspectionProvider that does not exist.",
    );
  }
  if (request.purchaseOrderRef === null) {
    return refuse("insufficient-legs", M, "No purchase-order leg: not even a two-way match is possible.");
  }
  const verdict = verdictFrom(request.lineResults, request.checksNotEvaluated);
  const common = {
    documentId: request.documentId,
    verdict,
    asOf: request.asOf,
    lineResults: request.lineResults,
    checksNotEvaluated: request.checksNotEvaluated,
    methodRef: M,
  };
  if (request.requestedDegree === "three-way" && request.goodsReceiptRef === null) {
    if (request.onInsufficientLegs === undefined) {
      return refuse("insufficient-legs", M, "onInsufficientLegs is required and has no default; there is no value that degrades silently.");
    }
    if (request.onInsufficientLegs === "refuse") {
      return refuse("insufficient-legs", M, "Three-way requested, goods-receipt leg absent, policy is refuse.");
    }
    if (request.degradationAuthorizationRef === null) {
      return refuse("degradation-authorization-missing", M, "Degrading a three-way request to two-way requires a caller-supplied authorization.");
    }
    return ok({
      ...common,
      degree: "two-way",
      purchaseOrderRef: request.purchaseOrderRef,
      degradation: {
        requestedDegree: "three-way",
        performedDegree: "two-way",
        missingLegs: ["goods-receipt"],
        reason: "GoodsReceiptProvider leg absent",
        authorizationRef: request.degradationAuthorizationRef,
      },
    });
  }
  if (request.requestedDegree === "three-way") {
    return ok({
      ...common,
      degree: "three-way",
      purchaseOrderRef: request.purchaseOrderRef,
      goodsReceiptRef: request.goodsReceiptRef!,
    });
  }
  return ok({ ...common, degree: "two-way", purchaseOrderRef: request.purchaseOrderRef });
}

// ── §16.3 · totals reconciliation (EN 16931 sequence) ───────────────────────

export interface InvoiceLine {
  readonly lineId: string;
  /** BT-131, already rounded to 2dp minor units. */
  readonly lineNetMinor: bigint;
  readonly vatCategory: string;
  readonly vatRatePermille: bigint;
}

export interface InvoiceTotals {
  readonly sumOfLinesMinor: bigint; // BT-106
  readonly documentAllowancesMinor: bigint; // BT-107
  readonly documentChargesMinor: bigint; // BT-108
  readonly totalWithoutVatMinor: bigint; // BT-109
  readonly totalVatMinor: bigint; // BT-110
  readonly totalWithVatMinor: bigint; // BT-112
  readonly paidAmountMinor: bigint; // BT-113
  readonly roundingAmountMinor: bigint; // BT-114
  readonly amountDueMinor: bigint; // BT-115
}

export interface TotalsException {
  readonly code: "totals-do-not-reconcile" | "vat-breakdown-inconsistent";
  readonly field: string;
  readonly expectedMinor: bigint;
  readonly statedMinor: bigint;
  /** An arithmetic error and an over-billing are different findings; the
   * invoice is still matched. */
  readonly severity: "review";
}

export function reconcileTotals(
  lines: readonly InvoiceLine[],
  totals: InvoiceTotals,
  vatBreakdownEntries: readonly { category: string; ratePermille: bigint; taxableMinor: bigint; taxMinor: bigint }[],
): readonly TotalsException[] {
  const exceptions: TotalsException[] = [];
  const flag = (field: string, expected: bigint, stated: bigint): void => {
    if (expected !== stated) {
      exceptions.push({ code: "totals-do-not-reconcile", field, expectedMinor: expected, statedMinor: stated, severity: "review" });
    }
  };
  const bt106 = lines.reduce((a, l) => a + l.lineNetMinor, 0n);
  flag("BT-106", bt106, totals.sumOfLinesMinor);
  const bt109 = totals.sumOfLinesMinor - totals.documentAllowancesMinor + totals.documentChargesMinor;
  flag("BT-109", bt109, totals.totalWithoutVatMinor);
  // One BG-23 entry per distinct (category, rate) pair; two entries sharing a
  // pair is inconsistent regardless of the amounts.
  const seen = new Set<string>();
  for (const entry of vatBreakdownEntries) {
    const key = `${entry.category}@${entry.ratePermille}`;
    if (seen.has(key)) {
      exceptions.push({ code: "vat-breakdown-inconsistent", field: key, expectedMinor: 0n, statedMinor: 0n, severity: "review" });
    }
    seen.add(key);
    // BT-117 = round(BT-116 × rate): computed from the ROUNDED taxable, half-up.
    const expectedTax = (entry.taxableMinor * entry.ratePermille + 500n) / 1000n;
    flag(`BT-117[${key}]`, expectedTax, entry.taxMinor);
  }
  const bt110 = vatBreakdownEntries.reduce((a, e) => a + e.taxMinor, 0n);
  flag("BT-110", bt110, totals.totalVatMinor);
  flag("BT-112", totals.totalWithoutVatMinor + totals.totalVatMinor, totals.totalWithVatMinor);
  flag("BT-115", totals.totalWithVatMinor - totals.paidAmountMinor + totals.roundingAmountMinor, totals.amountDueMinor);
  return exceptions;
}

// ── §16.4 · the tolerance model, validated at registration ──────────────────

export type ToleranceDimension = "quantity" | "unitPrice" | "lineAmount" | "invoiceAmount" | "taxAmount" | "conversionRate";
export const TOLERANCE_DIMENSIONS: readonly ToleranceDimension[] = [
  "quantity",
  "unitPrice",
  "lineAmount",
  "invoiceAmount",
  "taxAmount",
  "conversionRate",
];

export type ToleranceRule =
  | {
      readonly configured: true;
      readonly dimension: ToleranceDimension;
      readonly direction: "over-only" | "under-only" | "two-sided";
      readonly absoluteMinor?: bigint;
      readonly percentagePermille?: bigint;
      /** REQUIRED when both are present: either-may-pass with 2% and $50
       * lets a $100,000 line through on $2,000; both-must-pass blocks $8 on
       * $200. Both defensible; neither a default (D-6, the yieldMethod
       * analogue). */
      readonly combination?: "both-must-pass" | "either-may-pass";
    }
  | {
      /** An unconfigured dimension must be DECLARED not-evaluated, never
       * implicitly infinite — unknown-presented-as-healthy in tolerance form. */
      readonly configured: false;
      readonly dimension: ToleranceDimension;
      readonly declaredNotEvaluated: true;
    };

export function registerToleranceScheme(rules: readonly ToleranceRule[]): Result<{ schemeAccepted: true }> {
  const M = INVOICE_METHODS.tolerance;
  const present = new Set(rules.map((r) => r.dimension));
  const missing = TOLERANCE_DIMENSIONS.filter((dim) => !present.has(dim));
  if (missing.length > 0) {
    return refuse("tolerance-scheme-invalid", M, `Dimensions neither configured nor declared not-evaluated: ${missing.join(", ")}. An absent tolerance is not an unlimited one.`);
  }
  for (const rule of rules) {
    if (!rule.configured) continue;
    const hasAbsolute = rule.absoluteMinor !== undefined;
    const hasPercentage = rule.percentagePermille !== undefined;
    if (!hasAbsolute && !hasPercentage) {
      return refuse("tolerance-scheme-invalid", M, `${rule.dimension}: a configured rule needs an absolute or a percentage bound.`);
    }
    if (hasAbsolute && hasPercentage && rule.combination === undefined) {
      return refuse("tolerance-scheme-invalid", M, `${rule.dimension}: both bounds present and no combination declared — which wins is a policy choice, not a default.`);
    }
    if ((rule.absoluteMinor ?? 0n) < 0n || (rule.percentagePermille ?? 0n) < 0n) {
      return refuse("tolerance-scheme-invalid", M, `${rule.dimension}: a negative tolerance has no meaning.`);
    }
  }
  return ok({ schemeAccepted: true });
}

export function toleranceCheck(
  rule: ToleranceRule,
  varianceMinor: bigint,
  basisMinor: bigint,
): DimensionCheck | NotEvaluated {
  if (!rule.configured) return { dimension: rule.dimension, reason: "declared not-evaluated" };
  const overrun = varianceMinor > 0n;
  if ((rule.direction === "over-only" && !overrun && varianceMinor !== 0n) || (rule.direction === "under-only" && overrun)) {
    return { dimension: rule.dimension, outcome: "pass" };
  }
  const absVariance = varianceMinor < 0n ? -varianceMinor : varianceMinor;
  if (absVariance === 0n) return { dimension: rule.dimension, outcome: "pass" };
  const absoluteOk = rule.absoluteMinor !== undefined ? absVariance <= rule.absoluteMinor : undefined;
  const percentOk =
    rule.percentagePermille !== undefined ? absVariance * 1000n <= basisMinor * rule.percentagePermille : undefined;
  let within: boolean;
  if (absoluteOk !== undefined && percentOk !== undefined) {
    within = rule.combination === "both-must-pass" ? absoluteOk && percentOk : absoluteOk || percentOk;
  } else {
    within = absoluteOk ?? percentOk ?? false;
  }
  return { dimension: rule.dimension, outcome: within ? "pass-within-tolerance" : "fail" };
}

// ── §16.5 · duplicate detection: signals, policy, and a human ───────────────

export type DuplicateSignal =
  | "same-supplier-same-number" // S1
  | "same-supplier-amount-date" // S2
  | "same-supplier-amount-window" // S3
  | "same-po-same-amount" // S4
  | "number-normalization-collision"; // S5

export interface InvoiceFacts {
  readonly supplierRef: string;
  readonly rawInvoiceNumber: string;
  readonly grossTotalMinor: bigint;
  readonly currencyCode: string;
  readonly issueDate: string;
  readonly purchaseOrderRef: string | null;
}

export const normalizeInvoiceNumber = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    // Leading zeros stripped per digit group: INV-001 ≡ INV1. Occasionally
    // 0012 and 12 really are different invoices — which is exactly why S5 is
    // a review signal, not a verdict.
    .replace(/\d+/g, (group) => group.replace(/^0+(?=\d)/, ""));

export type PairFinding =
  | { readonly kind: "signals"; readonly signals: readonly DuplicateSignal[] }
  | {
      /** S6: same supplier, same number, DIFFERENT amount — overwhelmingly a
       * corrected re-presentation, not a duplicate. Routes to supersession. */
      readonly kind: "supersession-candidate";
    };

export function evaluatePair(a: InvoiceFacts, b: InvoiceFacts, windowDays: number): PairFinding {
  const sameSupplier = a.supplierRef === b.supplierRef;
  const normalizedEqual = normalizeInvoiceNumber(a.rawInvoiceNumber) === normalizeInvoiceNumber(b.rawInvoiceNumber);
  if (sameSupplier && normalizedEqual && a.grossTotalMinor !== b.grossTotalMinor) {
    return { kind: "supersession-candidate" };
  }
  const signals: DuplicateSignal[] = [];
  if (sameSupplier && a.rawInvoiceNumber === b.rawInvoiceNumber) signals.push("same-supplier-same-number");
  const amountAndCurrency = a.grossTotalMinor === b.grossTotalMinor && a.currencyCode === b.currencyCode;
  const numbersDiffer = a.rawInvoiceNumber !== b.rawInvoiceNumber;
  if (sameSupplier && amountAndCurrency && a.issueDate === b.issueDate && numbersDiffer) {
    signals.push("same-supplier-amount-date");
  }
  const dayDelta = Math.abs((Date.parse(a.issueDate) - Date.parse(b.issueDate)) / 86_400_000);
  if (sameSupplier && amountAndCurrency && numbersDiffer && a.issueDate !== b.issueDate && dayDelta <= windowDays) {
    signals.push("same-supplier-amount-window");
  }
  if (sameSupplier && a.purchaseOrderRef !== null && a.purchaseOrderRef === b.purchaseOrderRef && a.grossTotalMinor === b.grossTotalMinor) {
    signals.push("same-po-same-amount");
  }
  if (sameSupplier && numbersDiffer && normalizedEqual) signals.push("number-normalization-collision");
  return { kind: "signals", signals };
}

/** Only two dispositions are reachable by computation. There is deliberately
 * no confirmWhen in the policy and no code path to confirmed-duplicate here:
 * the strongest verdict the engine reaches alone is review-required. */
export type ComputedDisposition = "distinct" | "review-required";

export function assessDuplicate(
  finding: PairFinding,
  reviewWhen: readonly (readonly DuplicateSignal[])[],
): ComputedDisposition | "supersession-candidate" {
  if (finding.kind === "supersession-candidate") return "supersession-candidate";
  for (const requiredSet of reviewWhen) {
    if (requiredSet.every((s) => finding.signals.includes(s))) return "review-required";
  }
  return "distinct";
}

export interface DuplicateDecision {
  readonly disposition: "confirmed-duplicate" | "not-a-duplicate";
  readonly duplicatePairKey: string;
  readonly decidedBy: string;
  readonly governanceDecisionRef: string;
}

/** The ONLY producer of a confirmed duplicate (G-9): a human principal and a
 * Governance reference, or a refusal. A not-a-duplicate decision suppresses
 * exactly that pair — never the supplier, the amount or the signal. */
export function recordDuplicateDecision(
  duplicatePairKey: string,
  disposition: "confirmed-duplicate" | "not-a-duplicate",
  decidedBy: string | undefined,
  governanceDecisionRef: string | undefined,
): Result<DuplicateDecision> {
  const M = INVOICE_METHODS.duplicate;
  if (decidedBy === undefined || !decidedBy.startsWith("human.") || governanceDecisionRef === undefined) {
    return refuse(
      "duplicate-decision-authorization-missing",
      M,
      "A duplicate is confirmed by a person with a Governance reference, never by a signal evaluation.",
    );
  }
  return ok({ disposition, duplicatePairKey, decidedBy, governanceDecisionRef });
}

// ── §16.6 · supersession: a new version, never an edit ──────────────────────

export interface SupersessionOutcome {
  readonly newVersionRef: string;
  readonly supersededVersionRef: string;
  readonly priorMatchResultsFreshness: "stale"; // valid as history
  readonly approvalState: "pending"; // a prior approval is NOT reusable authority
  readonly publishes: "invoice.superseded"; // evidence; PayablesIQ decides
}

export function supersede(priorVersionRef: string, newVersionRef: string): SupersessionOutcome {
  return {
    newVersionRef,
    supersededVersionRef: priorVersionRef,
    priorMatchResultsFreshness: "stale",
    approvalState: "pending",
    publishes: "invoice.superseded",
  };
}

// ── §16.8 · approval readiness computes; a human decides ────────────────────

export interface ApprovalReadiness {
  readonly state: "ready" | "blocked" | "not-required";
  readonly outstanding: readonly string[];
  readonly methodRef: MethodRef;
}

export function approvalReadiness(outstanding: readonly string[], approvalRequired: boolean): ApprovalReadiness {
  return {
    state: !approvalRequired ? "not-required" : outstanding.length === 0 ? "ready" : "blocked",
    outstanding,
    methodRef: INVOICE_METHODS.approvalReadiness,
  };
}

export function recordApprovalDecision(
  invoiceVersionRef: string,
  principal: string | undefined,
  governanceDecisionRef: string | undefined,
  decision: "approved" | "rejected",
): Result<{ invoiceVersionRef: string; decision: string; principal: string; governanceDecisionRef: string }> {
  const M = INVOICE_METHODS.approvalReadiness;
  if (principal === undefined || !principal.startsWith("human.") || governanceDecisionRef === undefined) {
    // InvoiceIQ never approves. It records that someone with authority did.
    return refuse("approval-authorization-missing", M, "A human principal AND a Governance decision reference are required.");
  }
  return ok({ invoiceVersionRef, decision, principal, governanceDecisionRef });
}
