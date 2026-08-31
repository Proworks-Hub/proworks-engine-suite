// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  assessDuplication,
  classifyRisk,
  composeRun,
  fingerprint,
  mapSchemeStatus,
  normalizePayeeName,
  reconcileSettlement,
  type InstructionFacts,
  type InstructionState,
} from "../kernel.js";

const facts = (overrides?: Partial<InstructionFacts>): InstructionFacts => ({
  organizationId: "org-1",
  direction: "outbound",
  railId: "faster-payments",
  payerTokenRef: "payer-t1",
  payeeTokenRef: "payee-t9",
  amountMinor: 125_000n,
  currencyCode: "GBP",
  requestedExecutionDate: "2026-09-01",
  obligationRefs: ["inv-100"],
  payeeName: "Acme Supplies Ltd.",
  ...overrides,
});

describe("§16.1 the composite fingerprint — says WHY, not just different", () => {
  it("normalization: case fold, whitespace collapse, punctuation strip, no transliteration", () => {
    expect(normalizePayeeName("  ACME  Supplies,  Ltd. ")).toBe("acme supplies ltd");
    expect(normalizePayeeName("Müller GmbH")).toBe("müller gmbh"); // NOT transliterated
  });
  it("obligation refs are sorted so order does not split a duplicate", () => {
    const a = fingerprint(facts({ obligationRefs: ["inv-2", "inv-1"] }));
    const b = fingerprint(facts({ obligationRefs: ["inv-1", "inv-2"] }));
    expect(a.key).toBe(b.key);
  });
});

describe("§16.2 duplication — never re-pay an unknown fate", () => {
  const inState = (state: InstructionState) => [{ instructionRef: "prior-1", facts: facts(), state }];
  it("a match in an INDETERMINATE state blocks with NO override — the most important rule", () => {
    for (const state of ["in-flight", "instructed", "authorized"] as const) {
      const r = assessDuplication(facts(), inState(state));
      expect(r.assessment.verdict, state).toBe("suspected-blocking");
      if (r.assessment.verdict === "suspected-blocking") {
        expect(r.assessment.overrideAvailable).toBe(false);
      }
    }
  });
  it("a match in a terminal-failed state is suspected-recoverable — still blocking, cheaper override", () => {
    const r = assessDuplication(facts(), inState("failed"));
    expect(r.assessment.verdict).toBe("suspected-recoverable");
    if (r.assessment.verdict === "suspected-recoverable") {
      expect(r.assessment.overrideAvailable).toBe(true);
    }
  });
  it("a settled match blocks without override: the prior payment HAPPENED", () => {
    const r = assessDuplication(facts(), inState("settled"));
    expect(r.assessment.verdict).toBe("suspected-blocking");
  });
  it("all-equal-except-obligationRefs is a near match, non-blocking, with the field named", () => {
    const r = assessDuplication(facts(), [
      { instructionRef: "prior-2", facts: facts({ obligationRefs: ["inv-999"] }), state: "settled" },
    ]);
    expect(r.assessment.verdict).toBe("near");
    if (r.assessment.verdict === "near") {
      expect(r.assessment.differingField).toBe("obligationRefs");
      expect(r.assessment.blocking).toBe(false);
    }
  });
  it("a genuinely different instruction is clear", () => {
    const r = assessDuplication(facts(), [
      { instructionRef: "prior-3", facts: facts({ amountMinor: 1n, payeeTokenRef: "other" }), state: "settled" },
    ]);
    expect(r.assessment.verdict).toBe("clear");
  });
});

describe("§16.3 scheme status mapping — unmapped goes to review, never a default", () => {
  const table = { codeSetVersion: "2026-Q2", entries: { ACSP: "accepted", RJCT: "rejected" } };
  it("a mapped code returns the neutral state with the code-set version", () => {
    const r = mapSchemeStatus(table, "ACSP");
    expect(r.mapped && r.neutralState).toBe("accepted");
  });
  it("an unmapped code — external code sets change quarterly — yields review-required", () => {
    const r = mapSchemeStatus(table, "NEWCODE");
    expect(r.mapped).toBe(false);
    if (r.mapped) return;
    expect(r.outcome).toBe("unmapped-scheme-status");
    expect(r.disposition).toBe("review-required");
    expect(r.codeSetVersion).toBe("2026-Q2");
  });
});

describe("§16.4 risk classification — deterministic ladder with recorded basis", () => {
  const bands = [
    { upToMinor: 100_000n, base: "routine" as const },
    { upToMinor: null, base: "elevated" as const },
  ];
  it("no configured bands refuses — a default band quietly decides $500k is routine", () => {
    const r = classifyRisk({
      amountMinor: 50_000_000n,
      tenantBands: undefined,
      railFinality: "recallable",
      payeeVerification: "match",
      firstPaymentToPayeeAccount: false,
      crossBorderOrCrossCurrency: false,
      screeningVerdictKnown: true,
      memberOfAuthorizedRun: true,
    });
    expect(!r.ok && r.refusal.kind).toBe("risk_bands_unconfigured");
  });
  it("escalations stack and every applied rule is recorded for L4", () => {
    const r = classifyRisk({
      amountMinor: 500_000n, // band: elevated
      tenantBands: bands,
      railFinality: "irrevocable-on-settlement", // → high
      payeeVerification: "no-match", // → critical
      firstPaymentToPayeeAccount: true, // capped at critical
      crossBorderOrCrossCurrency: false,
      screeningVerdictKnown: true,
      memberOfAuthorizedRun: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.riskClass).toBe("critical");
    expect(r.value.riskClassBasis).toEqual(["band:elevated", "rail-irrevocable", "payee-unverified", "first-payment-to-account"]);
  });
  it("an unknown screening verdict floors the class at high", () => {
    const r = classifyRisk({
      amountMinor: 1_000n,
      tenantBands: bands,
      railFinality: "recallable",
      payeeVerification: "match",
      firstPaymentToPayeeAccount: false,
      crossBorderOrCrossCurrency: false,
      screeningVerdictKnown: false,
      memberOfAuthorizedRun: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.riskClass).toBe("high");
    expect(r.value.riskClassBasis).toContain("screening-unknown-floor-high");
  });
});

describe("§16.6 settlement reconciliation tri-state", () => {
  it("within tolerance reconciles without an exception", () => {
    const r = reconcileSettlement({
      instructedMinor: 100_000n,
      settledMinor: 99_998n,
      ourChargesMinor: 0n,
      fxDifferenceMinor: 0n,
      toleranceMinor: 5n,
      unattributedChargeCandidateMinor: null,
    });
    expect(r.state).toBe("reconciled");
    expect(r.exceptionRaised).toBe(false);
  });
  it("a residual explained by an unattributed charge is tentative WITH an exception", () => {
    const r = reconcileSettlement({
      instructedMinor: 100_000n,
      settledMinor: 98_500n,
      ourChargesMinor: 0n,
      fxDifferenceMinor: 0n,
      toleranceMinor: 5n,
      unattributedChargeCandidateMinor: 1_500n,
    });
    expect(r.state).toBe("tentatively-reconciled");
    expect(r.exceptionRaised).toBe(true);
  });
  it("otherwise unreconciled with the decomposition attached", () => {
    const r = reconcileSettlement({
      instructedMinor: 100_000n,
      settledMinor: 90_000n,
      ourChargesMinor: 100n,
      fxDifferenceMinor: 0n,
      toleranceMinor: 5n,
      unattributedChargeCandidateMinor: null,
    });
    expect(r.state).toBe("unreconciled");
    expect(r.residualMinor).toBe(9_900n);
  });
});

describe("§16.7 run composition — a RECOMMEND that cannot release", () => {
  it("an undeclared netting policy refuses", () => {
    const r = composeRun([], undefined);
    expect(!r.ok && r.refusal.kind).toBe("netting_policy_undeclared");
  });
  it("groups by (payee, rail, currency, date) and nets within group deterministically", () => {
    const r = composeRun(
      [
        { candidateRef: "c2", facts: facts({ obligationRefs: ["inv-2"], amountMinor: 30_000n }), payByDate: "2026-09-01" },
        { candidateRef: "c1", facts: facts({ obligationRefs: ["inv-1"], amountMinor: 20_000n }), payByDate: "2026-09-01" },
        { candidateRef: "c3", facts: facts({ payeeTokenRef: "payee-other", amountMinor: 5_000n }), payByDate: "2026-09-01" },
      ],
      "net-within-group",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("payment-run-proposal");
    expect("release" in r.value).toBe(false); // no authority, structurally
    const netted = r.value.groups.find((g) => g.memberRefs.length === 2)!;
    expect(netted.memberRefs).toEqual(["c1", "c2"]); // sorted, order-independent
    expect(netted.nettedAmountMinor).toBe(50_000n);
    expect(netted.obligationRefs).toEqual(["inv-1", "inv-2"]);
    // Determinism: shuffled input, same fingerprint.
    const again = composeRun(
      [
        { candidateRef: "c3", facts: facts({ payeeTokenRef: "payee-other", amountMinor: 5_000n }), payByDate: "2026-09-01" },
        { candidateRef: "c1", facts: facts({ obligationRefs: ["inv-1"], amountMinor: 20_000n }), payByDate: "2026-09-01" },
        { candidateRef: "c2", facts: facts({ obligationRefs: ["inv-2"], amountMinor: 30_000n }), payByDate: "2026-09-01" },
      ],
      "net-within-group",
    );
    if (!again.ok) return;
    expect(again.value.runCompositionFingerprint).toBe(r.value.runCompositionFingerprint);
  });
});
