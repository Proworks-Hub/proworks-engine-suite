// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  approvalReadiness,
  assessDuplicate,
  evaluateMatch,
  evaluatePair,
  normalizeInvoiceNumber,
  reconcileTotals,
  recordApprovalDecision,
  recordDuplicateDecision,
  registerToleranceScheme,
  supersede,
  toleranceCheck,
  verdictFrom,
  type InvoiceFacts,
  type MatchRequest,
  type ToleranceRule,
} from "../kernel.js";

const request = (overrides?: Partial<MatchRequest>): MatchRequest => ({
  documentId: "inv-100",
  asOf: "2026-08-30",
  requestedDegree: "three-way",
  purchaseOrderRef: "po-7",
  goodsReceiptRef: "gr-3",
  onInsufficientLegs: "refuse",
  degradationAuthorizationRef: null,
  lineResults: [{ dimension: "quantity", outcome: "pass" }],
  checksNotEvaluated: [],
  ...overrides,
});

describe("§16.2 the match result — the type carries the honesty rule", () => {
  it("a skipped check can NEVER produce matched: the first branch of verdictFrom", () => {
    // An otherwise perfect match with one not-evaluated check.
    expect(verdictFrom([{ dimension: "quantity", outcome: "pass" }], [{ dimension: "taxAmount", reason: "no tax data" }])).toBe(
      "indeterminate",
    );
    expect(verdictFrom([{ dimension: "quantity", outcome: "pass" }], [])).toBe("matched");
    expect(verdictFrom([{ dimension: "quantity", outcome: "pass-within-tolerance" }], [])).toBe("matched-within-tolerance");
    expect(verdictFrom([{ dimension: "quantity", outcome: "fail" }], [])).toBe("exception");
  });
  it("a three-way match carries the goods receipt as a required field", () => {
    const r = evaluateMatch(request());
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.degree !== "three-way") return;
    expect(r.value.goodsReceiptRef).toBe("gr-3");
    expect(r.value.degradation).toBeUndefined();
  });
  it("a two-way result has NO goodsReceipt field — not null, absent", () => {
    const r = evaluateMatch(request({ requestedDegree: "two-way" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degree).toBe("two-way");
    expect("goodsReceiptRef" in r.value).toBe(false);
  });
  it("four-way is declared and refused — three-way is visibly not the top rung", () => {
    const r = evaluateMatch(request({ requestedDegree: "four-way" }));
    expect(!r.ok && r.refusal.kind).toBe("capability-not-chartered");
  });
  it("onInsufficientLegs is required: a caller that forgets gets a refusal, not a silent degrade", () => {
    const r = evaluateMatch(request({ goodsReceiptRef: null, onInsufficientLegs: undefined }));
    expect(!r.ok && r.refusal.kind).toBe("insufficient-legs");
  });
  it("degrading requires an authorization, and the degradation is labelled AT THE RESULT", () => {
    const noAuth = evaluateMatch(request({ goodsReceiptRef: null, onInsufficientLegs: "degrade" }));
    expect(!noAuth.ok && noAuth.refusal.kind).toBe("degradation-authorization-missing");
    const withAuth = evaluateMatch(
      request({ goodsReceiptRef: null, onInsufficientLegs: "degrade", degradationAuthorizationRef: "auth-9" }),
    );
    expect(withAuth.ok).toBe(true);
    if (!withAuth.ok || withAuth.value.degree !== "two-way") return;
    expect(withAuth.value.degradation?.missingLegs).toEqual(["goods-receipt"]);
    expect(withAuth.value.degradation?.performedDegree).toBe("two-way");
  });
});

describe("§16.3 totals reconciliation — a validator that can actually fail", () => {
  const lines = [
    { lineId: "1", lineNetMinor: 10_000n, vatCategory: "S", vatRatePermille: 200n },
    { lineId: "2", lineNetMinor: 5_000n, vatCategory: "S", vatRatePermille: 200n },
  ];
  const goodTotals = {
    sumOfLinesMinor: 15_000n,
    documentAllowancesMinor: 1_000n,
    documentChargesMinor: 500n,
    totalWithoutVatMinor: 14_500n,
    totalVatMinor: 2_900n,
    totalWithVatMinor: 17_400n,
    paidAmountMinor: 0n,
    roundingAmountMinor: 0n,
    amountDueMinor: 17_400n,
  };
  const goodVat = [{ category: "S", ratePermille: 200n, taxableMinor: 14_500n, taxMinor: 2_900n }];
  it("T-TOT-06: a conformant invoice raises NO exception — a validator firing on valid input is as bad as one that never fires", () => {
    expect(reconcileTotals(lines, goodTotals, goodVat)).toHaveLength(0);
  });
  it("T-TOT-01: one line altered by a minor unit names BT-106 with the delta", () => {
    const exceptions = reconcileTotals(lines, { ...goodTotals, sumOfLinesMinor: 15_001n }, goodVat);
    const bt106 = exceptions.find((e) => e.field === "BT-106")!;
    expect(bt106.expectedMinor).toBe(15_000n);
    expect(bt106.statedMinor).toBe(15_001n);
    expect(bt106.severity).toBe("review"); // an exception, NOT a refusal to match
  });
  it("T-TOT-03: two BG-23 entries sharing a category and rate are inconsistent", () => {
    const exceptions = reconcileTotals(lines, goodTotals, [
      { category: "S", ratePermille: 200n, taxableMinor: 10_000n, taxMinor: 2_000n },
      { category: "S", ratePermille: 200n, taxableMinor: 4_500n, taxMinor: 900n },
    ]);
    expect(exceptions.some((e) => e.code === "vat-breakdown-inconsistent")).toBe(true);
  });
  it("T-TOT-05: a paid amount not reducing BT-115 is flagged", () => {
    const exceptions = reconcileTotals(lines, { ...goodTotals, paidAmountMinor: 5_000n }, goodVat);
    expect(exceptions.some((e) => e.field === "BT-115")).toBe(true);
  });
});

describe("§16.4 tolerances — an absent tolerance is not an unlimited one", () => {
  const configured = (dimension: ToleranceRule["dimension"], overrides?: Record<string, unknown>): ToleranceRule =>
    ({ configured: true, dimension, direction: "two-sided", absoluteMinor: 5_000n, ...overrides }) as ToleranceRule;
  const declared = (dimension: ToleranceRule["dimension"]): ToleranceRule => ({
    configured: false,
    dimension,
    declaredNotEvaluated: true,
  });
  const fullScheme: ToleranceRule[] = [
    configured("quantity"),
    configured("unitPrice"),
    configured("lineAmount"),
    configured("invoiceAmount"),
    declared("taxAmount"),
    declared("conversionRate"),
  ];
  it("a scheme missing a dimension is refused — the author must declare not-evaluated out loud", () => {
    const r = registerToleranceScheme(fullScheme.slice(0, 5));
    expect(!r.ok && r.refusal.kind).toBe("tolerance-scheme-invalid");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("conversionRate");
    expect(registerToleranceScheme(fullScheme).ok).toBe(true);
  });
  it("both bounds with no combination refuses — which wins is a policy choice (D-6)", () => {
    const bad = [...fullScheme.slice(0, 5), { configured: true, dimension: "conversionRate", direction: "two-sided", absoluteMinor: 100n, percentagePermille: 20n } as ToleranceRule];
    const r = registerToleranceScheme(bad);
    expect(!r.ok && r.refusal.kind).toBe("tolerance-scheme-invalid");
  });
  it("either-may-pass and both-must-pass behave oppositely at the extremes", () => {
    const either = configured("lineAmount", { percentagePermille: 20n, combination: "either-may-pass" });
    const both = configured("lineAmount", { percentagePermille: 20n, combination: "both-must-pass" });
    // A $100,000 line 2% over: $2,000 variance. absolute $50 fails, 2% passes.
    expect((toleranceCheck(either, 200_000n, 10_000_000n) as { outcome: string }).outcome).toBe("pass-within-tolerance");
    expect((toleranceCheck(both, 200_000n, 10_000_000n) as { outcome: string }).outcome).toBe("fail");
  });
  it("direction over-only lets an under-billing pass untested — as declared, not assumed", () => {
    const rule = configured("invoiceAmount", { direction: "over-only" });
    expect((toleranceCheck(rule, -900_000n, 1_000_000n) as { outcome: string }).outcome).toBe("pass");
    expect((toleranceCheck(rule, 900_000n, 1_000_000n) as { outcome: string }).outcome).toBe("fail");
  });
});

describe("§16.5 duplicates — signals compute; only a human confirms", () => {
  const invoice = (overrides?: Partial<InvoiceFacts>): InvoiceFacts => ({
    supplierRef: "supp-1",
    rawInvoiceNumber: "INV-001",
    grossTotalMinor: 50_000n,
    currencyCode: "GBP",
    issueDate: "2026-08-01",
    purchaseOrderRef: "po-1",
    ...overrides,
  });
  it("S1 and S5: normalization collision — INV-001 vs INV1 are usually one invoice", () => {
    expect(normalizeInvoiceNumber("INV-001")).toBe(normalizeInvoiceNumber("INV1"));
    const finding = evaluatePair(invoice(), invoice({ rawInvoiceNumber: "INV1" }), 14);
    expect(finding.kind === "signals" && finding.signals).toContain("number-normalization-collision");
  });
  it("S6: same number, DIFFERENT amount is a supersession candidate, never a duplicate signal", () => {
    const finding = evaluatePair(invoice(), invoice({ grossTotalMinor: 52_000n }), 14);
    expect(finding.kind).toBe("supersession-candidate");
  });
  it("T-DUP-09: a maximal signal set still yields review-required — LOCK-2 falsifiable", () => {
    const finding = evaluatePair(invoice(), invoice({ rawInvoiceNumber: "INV1" }), 14);
    if (finding.kind !== "signals") return;
    const disposition = assessDuplicate(finding, [["same-supplier-same-number"], ["number-normalization-collision"]]);
    expect(disposition).toBe("review-required"); // never confirmed-duplicate by computation
  });
  it("no signal in reviewWhen fires → distinct", () => {
    const finding = evaluatePair(invoice(), invoice({ rawInvoiceNumber: "OTHER-99", grossTotalMinor: 1n }), 14);
    if (finding.kind !== "signals") return;
    expect(assessDuplicate(finding, [["same-supplier-same-number"]])).toBe("distinct");
  });
  it("confirmed-duplicate requires a human principal AND a Governance reference", () => {
    const noHuman = recordDuplicateDecision("pair-1", "confirmed-duplicate", "system.batch", "gov-1");
    expect(!noHuman.ok && noHuman.refusal.kind).toBe("duplicate-decision-authorization-missing");
    const noGov = recordDuplicateDecision("pair-1", "confirmed-duplicate", "human.steven", undefined);
    expect(noGov.ok).toBe(false);
    const proper = recordDuplicateDecision("pair-1", "confirmed-duplicate", "human.steven", "gov-1");
    expect(proper.ok).toBe(true);
  });
});

describe("§16.6/§16.8 supersession and approval — authority stays human", () => {
  it("supersession: history stays stale-valid, approval resets to pending, evidence published", () => {
    const s = supersede("inv-100@v1", "inv-100@v2");
    expect(s.priorMatchResultsFreshness).toBe("stale");
    expect(s.approvalState).toBe("pending"); // a prior approval is not reusable authority
    expect(s.publishes).toBe("invoice.superseded"); // PayablesIQ decides; InvoiceIQ does not withdraw
  });
  it("approval readiness computes; the decision needs a human + Governance ref", () => {
    expect(approvalReadiness(["coding-unresolved"], true).state).toBe("blocked");
    expect(approvalReadiness([], true).state).toBe("ready");
    expect(approvalReadiness([], false).state).toBe("not-required");
    const bad = recordApprovalDecision("inv-100@v2", "service.bot", "gov-2", "approved");
    expect(!bad.ok && bad.refusal.kind).toBe("approval-authorization-missing");
    expect(recordApprovalDecision("inv-100@v2", "human.steven", "gov-2", "approved").ok).toBe(true);
  });
});
