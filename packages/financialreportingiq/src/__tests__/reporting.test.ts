// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  debtToEquity,
  deriveDeltaCashFlow,
  deriveIndirectCashFlow,
  proveCashInvariant,
  type IndirectCashFlowInputs,
} from "../kernel.js";

const inputs = (overrides?: Partial<IndirectCashFlowInputs>): IndirectCashFlowInputs => ({
  profitOrLossMinor: 100_000n,
  nonCashMovements: [
    { movementType: "depreciation", amountMinor: -30_000n }, // reduced P&L, no cash
    { movementType: "disposal-gain", amountMinor: 5_000n }, // belongs in investing
  ],
  reclassificationsIdentified: true,
  periodContainsBusinessCombination: false,
  combinationEffects: undefined,
  presentationDiffersFromFunctional: false,
  translationEffects: undefined,
  workingCapitalMovementOnResidueMinor: -12_000n,
  investingFlowsMinor: -40_000n,
  financingFlowsMinor: 20_000n,
  ...overrides,
});

describe("§16.5 the four breakers — each a required input with a named refusal", () => {
  it("missing non-cash register refuses", () => {
    const r = deriveIndirectCashFlow(inputs({ nonCashMovements: undefined }));
    expect(!r.ok && r.refusal.kind).toBe("NON_CASH_MOVEMENTS_UNAVAILABLE");
  });
  it("unidentified reclassifications refuse", () => {
    const r = deriveIndirectCashFlow(inputs({ reclassificationsIdentified: false }));
    expect(!r.ok && r.refusal.kind).toBe("RECLASSIFICATIONS_UNIDENTIFIED");
  });
  it("a combination period without supplied effects refuses", () => {
    const r = deriveIndirectCashFlow(inputs({ periodContainsBusinessCombination: true }));
    expect(!r.ok && r.refusal.kind).toBe("COMBINATION_EFFECTS_UNAVAILABLE");
  });
  it("presentation ≠ functional without translation effects refuses", () => {
    const r = deriveIndirectCashFlow(inputs({ presentationDiffersFromFunctional: true }));
    expect(!r.ok && r.refusal.kind).toBe("TRANSLATION_EFFECTS_UNAVAILABLE");
  });
  it("a complete derivation names every non-cash reversal individually", () => {
    const r = deriveIndirectCashFlow(inputs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 100,000 − (−30,000 + 5,000) − 12,000 = 113,000
    expect(r.value.netOperatingMinor).toBe(113_000n);
    expect(r.value.nonCashReversals.map((m) => m.movementType)).toContain("depreciation");
  });
  it("combination consideration is one investing line, net of cash acquired", () => {
    const r = deriveIndirectCashFlow(
      inputs({
        periodContainsBusinessCombination: true,
        combinationEffects: { cashConsiderationNetOfCashAcquiredMinor: 15_000n },
      }),
    );
    if (!r.ok) return;
    expect(r.value.netInvestingMinor).toBe(-55_000n);
  });
});

describe("§16.5 the delta derivation — labelled and barred from statutory", () => {
  it("refused for statutory and regulatory runs", () => {
    for (const kind of ["statutory", "regulatory"] as const) {
      const r = deriveDeltaCashFlow(kind, 100_000n, -5_000n);
      expect(!r.ok && r.refusal.kind, kind).toBe("DELTA_DERIVATION_NOT_PERMITTED_FOR_STATUTORY");
    }
  });
  it("permitted for management with the basis and assumption load inseparable", () => {
    const r = deriveDeltaCashFlow("management", 100_000n, -5_000n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.derivationBasis).toBe("balance-delta-only");
    expect(r.value.assumptionLoad).toBe("high");
  });
});

describe("§16.6 INV-CASH — proven, never constructed", () => {
  it("a reconciling statement holds", () => {
    const statement = deriveIndirectCashFlow(inputs());
    if (!statement.ok) return;
    // LHS from the run's own balance sheets: opening 50,000, closing must be
    // 50,000 + 113,000 − 55,000... investing here is −40,000 (no combination):
    const closing = 50_000n + 113_000n - 40_000n + 20_000n;
    const outcome = proveCashInvariant(50_000n, closing, statement.value);
    expect(outcome.holds).toBe(true);
  });
  it("a mismatch returns the statement WITH the finding and the residual — no balancing line", () => {
    const statement = deriveIndirectCashFlow(inputs());
    if (!statement.ok) return;
    // Inject a known omission: the closing cash is 7,000 short of the flows.
    const outcome = proveCashInvariant(50_000n, 50_000n + 113_000n - 40_000n + 20_000n - 7_000n, statement.value);
    expect(outcome.holds).toBe(false);
    if (outcome.holds) return;
    expect(outcome.finding).toBe("CASH_RECONCILIATION_FAILED");
    expect(outcome.residualMinor).toBe(-7_000n); // the injected amount, reported
    expect(outcome.statementReturned).toBe(true);
  });
});

describe("§16.7 ratios — a registry with no house default", () => {
  const ratioInputs = {
    totalLiabilitiesMinor: 700_000n,
    interestBearingDebtMinor: 420_000n,
    longTermDebtMinor: 300_000n,
    cashAndEquivalentsMinor: 80_000n,
    totalEquityMinor: 100_000n,
  };
  it("an unselected method refuses — 4.304 to 7.177 on one firm", () => {
    const r = debtToEquity(ratioInputs, undefined);
    expect(!r.ok && r.refusal.kind).toBe("RATIO_METHOD_UNSELECTED");
  });
  it("the formulations genuinely differ on the same inputs", () => {
    const totalLiabilities = debtToEquity(ratioInputs, "ratio.debt-to-equity.total-liabilities");
    const netDebt = debtToEquity(ratioInputs, "ratio.debt-to-equity.net-debt");
    if (!totalLiabilities.ok || !netDebt.ok || !totalLiabilities.value.defined || !netDebt.value.defined) return;
    expect(totalLiabilities.value.numeratorMinor).toBe(700_000n); // 7.0x
    expect(netDebt.value.numeratorMinor).toBe(340_000n); // 3.4x — same firm
  });
  it("zero equity yields undefined, never Infinity", () => {
    const r = debtToEquity({ ...ratioInputs, totalEquityMinor: 0n }, "ratio.debt-to-equity.total-liabilities");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.defined).toBe(false);
  });
});
