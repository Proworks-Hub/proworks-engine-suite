// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { allocateAcrossComponents } from "../kernel/allocation.js";
import { cei, dsoCountback, dsoSimple } from "../kernel/agingAndMetrics.js";
import { matchCascade } from "../kernel/matching.js";
import { validateAgingPolicy } from "../kernel/methods.js";
import { classifyShortPay, evaluateDiscount, realizedFxGainLoss, residualStrategyChildBasis } from "../kernel/shortpayAndFx.js";
import { createReceivablesEngine, type CallContext, type CommandMeta } from "../engine.js";
import {
  OPEN_ITEM_TRANSITIONS,
  openItemStateSchema,
  RECEIPT_TRANSITIONS,
  receiptStateSchema,
  TERMINAL_OPEN_ITEM_STATES,
  TERMINAL_RECEIPT_STATES,
  type AgingPolicy,
  type MatchPolicy,
  type TolerancePolicy,
} from "../model.js";
import { createInMemoryReceivableStore } from "../ports.js";

const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });

const ctx = (asOf = "2026-08-20", org = "org-1"): CallContext => ({
  tenant: { organizationId: org, roles: [] },
  trace: { correlationId: "c-1" },
  asOf,
});
const meta = (key: string, authorizationRef?: string): CommandMeta => ({
  idempotencyKey: key,
  principal: "system.test",
  ...(authorizationRef !== undefined ? { authorizationRef } : {}),
});

const CURRENCIES = { USD: 2, EUR: 2, JPY: 0 };

function engine() {
  const store = createInMemoryReceivableStore();
  return { e: createReceivablesEngine({ store, currencyRegistry: CURRENCIES }), store };
}

const POLICY: AgingPolicy = {
  methodRef: { methodId: "aging.standard", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  basis: "dueDate",
  buckets: [
    { name: "current", fromDays: 0, toDays: 1 },
    { name: "1-30", fromDays: 1, toDays: 31 },
    { name: "31-60", fromDays: 31, toDays: 61 },
    { name: "61+", fromDays: 61, toDays: Number.MAX_SAFE_INTEGER },
  ],
  graceDays: 0,
  creditTreatment: "separate-credits-line",
};

const MATCH: MatchPolicy = {
  methodRef: { methodId: "match.standard", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  maxCandidates: 24,
  policyOrderedAuthorized: false,
};

const TOLERANCE: TolerancePolicy = {
  methodRef: { methodId: "tolerance.standard", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  absoluteMinor: "500",
  percent: "1",
  allowUnearnedDiscount: false,
  toleranceAuthorizationRef: "gov-tolerance-1",
};

async function seedInvoice(
  e: ReturnType<typeof engine>["e"],
  id: string,
  amount: string,
  dueDate?: string,
  overrides?: Record<string, unknown>,
) {
  const outcome = await e.recordReceivable(
    {
      openItemId: id,
      customerRef: "cust-A",
      documentRef: `doc-${id}`,
      itemKind: "invoice",
      sign: "debit",
      originalAmount: usd(amount),
      documentDate: "2026-08-01",
      ...(dueDate !== undefined ? { dueDate } : {}),
      ...overrides,
    },
    ctx(),
    meta(`intake-${id}`),
  );
  if (!outcome.ok) throw new Error(`seed failed: ${outcome.refusal.detail}`);
}

describe("intake — M-1 gates", () => {
  it("refuses an unknown currency scale rather than assuming 2", async () => {
    const { e } = engine();
    const outcome = await e.recordReceivable(
      {
        openItemId: "i1", customerRef: "cust-A", documentRef: "d1", itemKind: "invoice", sign: "debit",
        originalAmount: { amount: "1.000", currency: "KWD", scale: 3 },
        documentDate: "2026-08-01",
      },
      ctx(),
      meta("k1"),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("unknown-currency-scale");
  });
  it("refuses a duplicate documentRef naming the prior item", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "100.00", "2026-08-31");
    const dup = await e.recordReceivable(
      {
        openItemId: "i2", customerRef: "cust-A", documentRef: "doc-i1", itemKind: "invoice", sign: "debit",
        originalAmount: usd("100.00"), documentDate: "2026-08-01",
      },
      ctx(),
      meta("k2"),
    );
    expect(!dup.ok && dup.refusal.kind).toBe("duplicate-intake");
    expect(!dup.ok && dup.refusal.detail).toContain("i1");
  });
  it("refuses backdated due dates without explicit authorization", async () => {
    const { e } = engine();
    const outcome = await e.recordReceivable(
      {
        openItemId: "i1", customerRef: "cust-A", documentRef: "d1", itemKind: "invoice", sign: "debit",
        originalAmount: usd("100.00"), documentDate: "2026-08-10", dueDate: "2026-08-01",
      },
      ctx(),
      meta("k1"),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("authorization-required");
  });
  it("a replayed command deduplicates instead of doubling", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "100.00", "2026-08-31");
    const replay = await e.recordReceivable(
      {
        openItemId: "i1-again", customerRef: "cust-A", documentRef: "doc-other", itemKind: "invoice", sign: "debit",
        originalAmount: usd("100.00"), documentDate: "2026-08-01",
      },
      ctx(),
      meta("intake-i1"), // same key
    );
    expect(replay.ok && replay.value.deduplicated).toBe(true);
  });
  it("an unbound store refuses — never an empty book", async () => {
    const e = createReceivablesEngine({ currencyRegistry: CURRENCIES });
    const outcome = await e.getCustomerBalance({ customerRef: "cust-A" }, ctx());
    expect(!outcome.ok && outcome.refusal.kind).toBe("store-port-unbound");
  });
});

describe("cash — the three-way distinction and the lockbox duplicate rule", () => {
  it("a receipt with no customer is unidentified; identification transitions it", async () => {
    const { e } = engine();
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", amount: usd("50.00"), valueDate: "2026-08-15", receivedDate: "2026-08-15",
        instrument: "ach", sourceMessageRef: "lockbox-1",
      },
      ctx(),
      meta("cash-1"),
    );
    const blocked = await e.applyCash({ cashReceiptId: "r1", autoMatch: { policy: MATCH } }, ctx(), meta("apply-1"));
    expect(!blocked.ok && blocked.refusal.kind).toBe("unidentified-customer");
    await e.identifyCashReceipt({ cashReceiptId: "r1", customerRef: "cust-A" }, ctx(), meta("id-1"));
    const park = await e.placeOnAccount({ cashReceiptId: "r1" }, ctx(), meta("park-1"));
    expect(park.ok).toBe(true);
  });
  it("refuses a duplicate receipt naming the prior one — not merged, not skipped", async () => {
    const { e } = engine();
    const input = {
      cashReceiptId: "r1", customerRef: "cust-A", amount: usd("50.00"), valueDate: "2026-08-15",
      receivedDate: "2026-08-15", instrument: "ach", payerReference: "PAY-9", sourceMessageRef: "lockbox-1",
    };
    await e.recordCashReceipt(input, ctx(), meta("cash-1"));
    const dup = await e.recordCashReceipt({ ...input, cashReceiptId: "r2" }, ctx(), meta("cash-2"));
    expect(!dup.ok && dup.refusal.kind).toBe("duplicate-receipt");
    expect(!dup.ok && dup.refusal.detail).toContain("r1");
  });
});

describe("application — cascade, allocation, reversal, I-1", () => {
  async function seedAndReceive(e: ReturnType<typeof engine>["e"]) {
    await seedInvoice(e, "i1", "100.00", "2026-08-31");
    await seedInvoice(e, "i2", "60.00", "2026-08-31");
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", customerRef: "cust-A", amount: usd("60.00"), valueDate: "2026-08-15",
        receivedDate: "2026-08-15", instrument: "ach", sourceMessageRef: "lb-1",
      },
      ctx(),
      meta("cash-1"),
    );
  }

  it("exact-amount match wins uniquely and settles the item (I-1 derives to zero)", async () => {
    const { e } = engine();
    await seedAndReceive(e);
    const outcome = await e.applyCash({ cashReceiptId: "r1", autoMatch: { policy: MATCH } }, ctx(), meta("apply-1"));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.matcher).toBe("exact-amount");
    const item = await e.getOpenItem({ openItemId: "i2" }, ctx());
    expect(item.ok && item.value.state).toBe("cleared");
    expect(item.ok && item.value.openAmount.amount).toBe("0.00");
  });
  it("ties refuse rather than pick — ambiguity stops the cascade", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "60.00", "2026-08-31");
    await seedInvoice(e, "i2", "60.00", "2026-08-31");
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", customerRef: "cust-A", amount: usd("60.00"), valueDate: "2026-08-15",
        receivedDate: "2026-08-15", instrument: "ach", sourceMessageRef: "lb-1",
      },
      ctx(),
      meta("cash-1"),
    );
    const outcome = await e.applyCash({ cashReceiptId: "r1", autoMatch: { policy: MATCH } }, ctx(), meta("apply-1"));
    expect(!outcome.ok && outcome.refusal.kind).toBe("ambiguous-match");
    // Stage attribution matters to an operator: a tie at exact-amount says so,
    // rather than reporting a generic subset ambiguity from a later stage.
    if (!outcome.ok) expect(outcome.refusal.detail).toContain("equal the receipt amount");
  });
  it("two distinct SUBSETS refuse with both listed — no exact-amount tie involved", async () => {
    const { e } = engine();
    await seedInvoice(e, "a1", "40.00", "2026-08-31");
    await seedInvoice(e, "a2", "20.00", "2026-08-31");
    await seedInvoice(e, "b1", "35.00", "2026-08-31");
    await seedInvoice(e, "b2", "25.00", "2026-08-31");
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", customerRef: "cust-A", amount: usd("60.00"), valueDate: "2026-08-15",
        receivedDate: "2026-08-15", instrument: "ach", sourceMessageRef: "lb-1",
      },
      ctx(),
      meta("cash-1"),
    );
    const outcome = await e.applyCash({ cashReceiptId: "r1", autoMatch: { policy: MATCH } }, ctx(), meta("apply-1"));
    expect(!outcome.ok && outcome.refusal.kind).toBe("ambiguous-match");
    if (!outcome.ok) expect(outcome.refusal.detail).toContain("subsets");
  });
  it("exact-reference beats exact-amount; subset-sum finds the unique pair", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "40.00", "2026-08-31");
    await seedInvoice(e, "i2", "20.00", "2026-08-31");
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", customerRef: "cust-A", amount: usd("60.00"), valueDate: "2026-08-15",
        receivedDate: "2026-08-15", instrument: "ach", sourceMessageRef: "lb-1",
      },
      ctx(),
      meta("cash-1"),
    );
    const outcome = await e.applyCash({ cashReceiptId: "r1", autoMatch: { policy: MATCH } }, ctx(), meta("apply-1"));
    expect(outcome.ok && outcome.value.matcher).toBe("subset-sum");
    const balance = await e.getCustomerBalance({ customerRef: "cust-A" }, ctx());
    expect(balance.ok && balance.value.perCurrency[0]?.balance.amount).toBe("0.00");
  });
  it("reversal restores I-1 and requires authorization", async () => {
    const { e } = engine();
    await seedAndReceive(e);
    const applied = await e.applyCash(
      { cashReceiptId: "r1", allocations: [{ openItemId: "i1", amount: usd("60.00") }] },
      ctx(),
      meta("apply-1"),
    );
    expect(applied.ok).toBe(true);
    const applicationId = applied.ok ? applied.value.applicationIds[0] ?? "" : "";
    const unauthorized = await e.reverseApplication({ applicationId, reason: "misapplied" }, ctx(), meta("rev-1"));
    expect(!unauthorized.ok && unauthorized.refusal.kind).toBe("authorization-required");
    const reversed = await e.reverseApplication(
      { applicationId, reason: "misapplied" },
      ctx(),
      meta("rev-2", "gov-1"),
    );
    expect(reversed.ok).toBe(true);
    const item = await e.getOpenItem({ openItemId: "i1" }, ctx());
    expect(item.ok && item.value.openAmount.amount).toBe("100.00");
    expect(item.ok && item.value.state).toBe("open");
  });
  it("cross-currency application refuses: the booking rate is never substituted", async () => {
    const { e } = engine();
    await e.recordReceivable(
      {
        openItemId: "je1", customerRef: "cust-A", documentRef: "dj1", itemKind: "invoice", sign: "debit",
        originalAmount: { amount: "5000", currency: "JPY", scale: 0 }, documentDate: "2026-08-01",
      },
      ctx(),
      meta("jp-1"),
    );
    await e.recordCashReceipt(
      {
        cashReceiptId: "r1", customerRef: "cust-A", amount: usd("50.00"), valueDate: "2026-08-15",
        receivedDate: "2026-08-15", instrument: "wire", sourceMessageRef: "lb-1",
      },
      ctx(),
      meta("cash-1"),
    );
    const outcome = await e.applyCash(
      { cashReceiptId: "r1", allocations: [{ openItemId: "je1", amount: usd("50.00") }] },
      ctx(),
      meta("apply-1"),
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("rate-port-unbound");
  });
  it("write-off requires authorization and cannot exceed the open amount", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "100.00", "2026-08-31");
    const unauthorized = await e.recordWriteOff({ openItemId: "i1", amount: usd("100.00") }, ctx(), meta("wo-1"));
    expect(!unauthorized.ok && unauthorized.refusal.kind).toBe("authorization-required");
    const over = await e.recordWriteOff({ openItemId: "i1", amount: usd("101.00") }, ctx(), meta("wo-2", "gov-1"));
    expect(!over.ok && over.refusal.kind).toBe("policy-invalid");
    const authorized = await e.recordWriteOff({ openItemId: "i1", amount: usd("100.00") }, ctx(), meta("wo-3", "gov-1"));
    expect(authorized.ok).toBe(true);
    const item = await e.getOpenItem({ openItemId: "i1" }, ctx());
    expect(item.ok && item.value.state).toBe("written-off");
  });
});

describe("M-3 allocation — largest remainder, exact sum (R2)", () => {
  const components = [
    { componentId: "c-line", componentKind: "line" as const, amount: usd("70.00") },
    { componentId: "c-tax", componentKind: "tax" as const, amount: usd("20.00") },
    { componentId: "c-freight", componentKind: "freight" as const, amount: usd("10.00") },
  ];
  it("splits proportionally with the residual distributed deterministically", () => {
    const outcome = allocateAcrossComponents(usd("33.33"), components, "proportional");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const total = outcome.value.reduce((acc, a) => acc + BigInt(a.allocated.amount.replace(".", "")), 0n);
    expect(total).toBe(3333n);
    // 70/20/10 of 33.33: floors 23.33/6.66/3.33 leave 1 minor unit to the
    // largest discarded fraction.
    expect(outcome.value.map((a) => a.allocated.amount)).toEqual(["23.33", "6.67", "3.33"]);
  });
  it("sequential mode consumes by priority order", () => {
    const outcome = allocateAcrossComponents(usd("75.00"), components, "sequential");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.map((a) => a.allocated.amount)).toEqual(["70.00", "5.00"]);
    }
  });
  it("refuses when nothing can be allocated", () => {
    const outcome = allocateAcrossComponents(usd("10.00"), [], "proportional");
    expect(!outcome.ok && outcome.refusal.kind).toBe("allocation-assertion-failed");
  });
});

describe("M-2/M-5/M-6/M-7 — discount, short pay, residual, FX", () => {
  it("earned within the window; unearned only under the policy allowance, recorded as unearned", () => {
    const term = { days: 10, percentage: "2" };
    const earned = evaluateDiscount(term, "2026-08-01", "2026-08-08", usd("100.00"), TOLERANCE, "half-even");
    expect(earned.ok && earned.value.kind).toBe("earned");
    expect(earned.ok && earned.value.amount.amount).toBe("2.00");
    const late = evaluateDiscount(term, "2026-08-01", "2026-08-20", usd("100.00"), TOLERANCE, "half-even");
    expect(late.ok).toBe(false);
    const allowed = evaluateDiscount(
      term, "2026-08-01", "2026-08-20", usd("100.00"),
      { ...TOLERANCE, allowUnearnedDiscount: true }, "half-even",
    );
    expect(allowed.ok && allowed.value.kind).toBe("unearned");
  });
  it("classifies within tolerance via the STANDING authorization; unknown reason codes refer, never coerce", () => {
    const within = classifyShortPay(usd("4.00"), TOLERANCE, undefined, {});
    expect(within.ok && within.value.disposition).toBe("tolerance-writeoff");
    expect(within.ok && within.value.authorizationRef).toBe("gov-tolerance-1");
    const mapped = classifyShortPay(usd("50.00"), TOLERANCE, "CS", { CS: "deduction-open" });
    expect(mapped.ok && mapped.value.disposition).toBe("deduction-open");
    const unknown = classifyShortPay(usd("50.00"), TOLERANCE, "ZZ", { CS: "deduction-open" });
    expect(unknown.ok && unknown.value.disposition).toBe("refer");
  });
  it("partial keeps the original due date; residual's child basis is a recorded choice", () => {
    expect(residualStrategyChildBasis("partial", "inherit-parent", "2026-08-31", "2026-09-10").createsChild).toBe(false);
    const reset = residualStrategyChildBasis("residual", "reset-to-application-date", "2026-08-31", "2026-09-10");
    expect(reset.createsChild && reset.childDueDate).toBe("2026-09-10");
  });
  it("realized FX gain/loss rounds ONCE and records any one-unit residual explicitly", () => {
    const original = { base: "EUR", quote: "USD", rate: "1.0850", source: "fixture", effectiveDate: "2026-07-01", rateType: "spot-at-transaction-date" as const };
    const settle = { ...original, rate: "1.1000", effectiveDate: "2026-08-15" };
    const outcome = realizedFxGainLoss(
      { amount: "1000.00", currency: "EUR", scale: 2 },
      original, settle, "USD", 2, "half-even",
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // (1.1000 − 1.0850) × 1000.00 = 15.00 gain.
      expect(outcome.value.gainLoss.amount).toBe("15.00");
      expect(outcome.value.fxRoundingResidualMinor).toBe(0n);
    }
    const unbound = realizedFxGainLoss(
      { amount: "1000.00", currency: "EUR", scale: 2 },
      original, undefined, "USD", 2, "half-even",
    );
    expect(!unbound.ok && unbound.refusal.kind).toBe("rate-port-unbound");
  });
});

describe("M-8 aging — R-1 asserted, unknown bucket, credits separate", () => {
  it("ages through the engine and the identity holds", async () => {
    const { e } = engine();
    await seedInvoice(e, "current-1", "10.00", "2026-08-20");
    await seedInvoice(e, "late-1", "20.00", "2026-08-05"); // 15 days past due
    await seedInvoice(e, "old-1", "30.00", "2026-06-01", { documentDate: "2026-05-01" }); // 80 days past due
    await seedInvoice(e, "unknown-1", "40.00"); // no due date
    await e.recordReceivable(
      {
        openItemId: "cr-1", customerRef: "cust-A", documentRef: "d-cr", itemKind: "credit-note", sign: "credit",
        originalAmount: usd("5.00"), documentDate: "2026-08-01",
      },
      ctx(),
      meta("cr-1"),
    );
    const outcome = await e.ageReceivables({ policy: POLICY, currency: "USD" }, ctx("2026-08-20"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byName = new Map(outcome.value.buckets.map((b) => [b.name, b.total.amount]));
    expect(byName.get("current")).toBe("10.00");
    expect(byName.get("1-30")).toBe("20.00");
    expect(byName.get("61+")).toBe("30.00");
    expect(outcome.value.unknownBucket.amount).toBe("40.00"); // never "current"
    expect(outcome.value.credits.amount).toBe("5.00"); // separate line, never netted invisibly
    expect(outcome.value.subLedgerTotal.amount).toBe("95.00");
  });
  it("refuses a gapped policy on load, not at use", () => {
    const gappy: AgingPolicy = {
      ...POLICY,
      buckets: [
        { name: "current", fromDays: 0, toDays: 1 },
        { name: "35+", fromDays: 35, toDays: Number.MAX_SAFE_INTEGER },
      ],
    };
    expect(validateAgingPolicy(gappy)?.rule).toBe("coverage");
  });
});

describe("M-11 — the DSO family carries its inputs and refuses gaps", () => {
  it("simple DSO requires its arguments; absent is a refusal, not zero", () => {
    expect(dsoSimple(undefined, usd("1000.00"), 30).ok).toBe(false);
    const outcome = dsoSimple(usd("500.00"), usd("1000.00"), 30);
    expect(outcome.ok && outcome.value.days).toBe("15.00");
    expect(outcome.ok && outcome.value.inputs.creditSales).toBe("1000.00");
  });
  it("countback walks periods most-recent-first and refuses when history runs out", () => {
    const outcome = dsoCountback(usd("150.00"), [
      { period: "2026-08", creditSales: usd("100.00"), days: 31 },
      { period: "2026-07", creditSales: usd("100.00"), days: 31 },
    ]);
    // 100 consumes 31 days; remaining 50 of 100 pro-rates to 15.5 days.
    expect(outcome.ok && outcome.value.days).toBe("46.50");
    const starved = dsoCountback(usd("500.00"), [
      { period: "2026-08", creditSales: usd("100.00"), days: 31 },
    ]);
    expect(!starved.ok && starved.refusal.kind).toBe("policy-invalid");
  });
  it("CEI computes the collection effectiveness percentage", () => {
    const outcome = cei(usd("1000.00"), usd("500.00"), usd("600.00"));
    expect(outcome.ok && outcome.value.days).toBe("60.00");
  });
});

describe("state machines — every state exits or is declared terminal", () => {
  it("walks both tables", () => {
    for (const state of openItemStateSchema.options) {
      const hasExit = OPEN_ITEM_TRANSITIONS.some((t) => t.from === state);
      const terminal = TERMINAL_OPEN_ITEM_STATES.includes(state);
      expect(hasExit || terminal, state).toBe(true);
      expect(hasExit && terminal, state).toBe(false);
    }
    for (const state of receiptStateSchema.options) {
      const hasExit = RECEIPT_TRANSITIONS.some((t) => t.from === state);
      const terminal = TERMINAL_RECEIPT_STATES.includes(state);
      expect(hasExit || terminal, state).toBe(true);
      expect(hasExit && terminal, state).toBe(false);
    }
    // `disputed` is deliberately NOT a state — dispute state is CollectionsIQ's.
    expect(openItemStateSchema.options).not.toContain("disputed");
  });
});

describe("tenant isolation and match cascade unit paths", () => {
  it("org-2 sees nothing of org-1", async () => {
    const { e } = engine();
    await seedInvoice(e, "i1", "100.00", "2026-08-31");
    const foreign = await e.getCustomerBalance({ customerRef: "cust-A" }, ctx("2026-08-20", "org-2"));
    expect(foreign.ok && foreign.value.perCurrency).toHaveLength(0);
  });
  it("candidate-count over the policy bound refuses — never truncates", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      openItemId: `i${i}`, customerRef: "cust-A", documentRef: `d${i}`, itemKind: "invoice" as const,
      sign: "debit" as const, originalAmount: usd("10.00"), openAmount: usd("10.00"),
      documentDate: "2026-08-01", discountTerms: [], state: "open" as const, disputePresence: false,
      components: [], sourceEntryIds: [], freshness: "current" as const,
    }));
    const receipt = {
      cashReceiptId: "r1", customerRef: "cust-A", amount: usd("55.00"), valueDate: "2026-08-15",
      receivedDate: "2026-08-15", instrument: "ach", sourceMessageRef: "lb", state: "identified-unapplied" as const,
      unappliedAmount: usd("55.00"), remittanceRefs: [],
    };
    const outcome = matchCascade(receipt, items, MATCH);
    expect(!outcome.ok && outcome.refusal.kind).toBe("budget-exceeded");
  });
});

// ── Guards — proven to fail by injection during the build. ──────────────────

const SRC = join(process.cwd(), "packages/receivablesiq/src");
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("guards", () => {
  it("imports only contracts, core-kit and zod (both import forms)", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
    }
  });
  it("no clock, randomness, float money, or journal-writing surface", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|crypto\.randomUUID/.test(f.text), f.path).toBe(false);
      expect(/Math\.round\(|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/postEntry|writeJournal|appendJournal|postToLedger/.test(f.text), f.path).toBe(false);
      expect(/\.default\("USD"\)/.test(f.text), f.path).toBe(false);
    }
  });
  it("the store port has no update and no delete", () => {
    const ports = files.find((f) => f.path.endsWith("ports.ts"));
    expect(/^\s*(update|delete|remove|amend)\w*\s*\(/m.test(ports?.text ?? "")).toBe(false);
  });
  it("no rolled-up confidence score exists anywhere", () => {
    for (const f of files) {
      expect(/confidenceScore|matchConfidence|overallScore/.test(f.text), f.path).toBe(false);
    }
  });
});
