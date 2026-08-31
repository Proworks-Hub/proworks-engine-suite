// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  associateActionOutcome,
  evaluateDunning,
  evaluateFrequency,
  evaluateQuietHours,
  keepRateComposition,
  moveRung,
  prioritize,
  promiseOutcome,
  writeOffCandidacy,
  type ContactRecord,
  type DunningFacts,
  type DunningStep,
} from "../kernel.js";

describe("M-1 priority — partial over imputed zero, dispute suppression scoped", () => {
  const weights = new Map([
    ["amount-at-risk", 3n],
    ["days-beyond-term", 2n],
    ["credit-evidence", 1n],
  ]);
  it("a missing factor yields a PARTIAL score with the factor named — never zero imputed", () => {
    const r = prioritize(
      { subjectRef: "cust-1", amountAtRiskMinor: 10_000n, disputedPortionMinor: 0n, factors: new Map([["amount-at-risk", 5n], ["days-beyond-term", 4n]]) },
      weights,
      1,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scoreBasis).toBe("partial");
    expect(r.value.missingFactors).toEqual(["credit-evidence"]);
    expect(r.value.score).toBe(23n);
    expect(r.value.authority).toBe("none"); // a rank is not a decision
  });
  it("beyond maxMissingFactors the subject is refused, not scored", () => {
    const r = prioritize(
      { subjectRef: "cust-1", amountAtRiskMinor: 10_000n, disputedPortionMinor: 0n, factors: new Map() },
      weights,
      1,
    );
    expect(!r.ok && r.refusal.kind).toBe("too_many_missing_factors");
  });
  it("dispute suppression is scoped to the disputed portion: 8,700 of 10,000 stays collectable", () => {
    const r = prioritize(
      { subjectRef: "cust-2", amountAtRiskMinor: 10_000n, disputedPortionMinor: 1_300n, factors: new Map([["amount-at-risk", 1n], ["days-beyond-term", 1n], ["credit-evidence", 1n]]) },
      weights,
      0,
    );
    if (!r.ok) return;
    expect(r.value.suppressedFromDunningMinor).toBe(1_300n);
    expect(r.value.collectableMinor).toBe(8_700n);
  });
});

describe("M-3 promises — five outcomes, and a keep-rate that names its denominator", () => {
  it("kept / kept-late / partial / broken by date, grace and amount", () => {
    const pay = (amount: bigint, date: string) => [{ amountMinor: amount, date }];
    expect(promiseOutcome(100n, "2026-08-10", 3, pay(100n, "2026-08-09"), "2026-08-30").outcome).toBe("kept");
    expect(promiseOutcome(100n, "2026-08-10", 3, pay(100n, "2026-08-12"), "2026-08-30").outcome).toBe("kept-late");
    expect(promiseOutcome(100n, "2026-08-10", 3, pay(40n, "2026-08-11"), "2026-08-30").outcome).toBe("partial");
    expect(promiseOutcome(100n, "2026-08-10", 3, [], "2026-08-30").outcome).toBe("broken");
    expect(promiseOutcome(100n, "2026-08-10", 3, [], "2026-08-11").outcome).toBe("still-open");
    const voided = promiseOutcome(100n, "2026-08-10", 3, [], "2026-08-30", "superseded");
    expect(voided.outcome).toBe("void");
  });
  it("the keep rate is a composition, never a bare percentage", () => {
    const composition = keepRateComposition(["kept", "kept", "broken", "partial", "void", "still-open"]);
    expect(composition.kept).toBe(2);
    expect(composition.broken).toBe(1);
    expect(composition.barePercentage).toBeNull(); // the reader folds; the engine does not
  });
});

describe("M-4 dunning — every exit condition, every step", () => {
  const steps: DunningStep[] = [
    { stepId: "s1", offsetDays: 0, channelClass: "email" },
    { stepId: "s2", offsetDays: 7, channelClass: "voice" },
  ];
  const clearFacts: DunningFacts = { settled: false, openDisputeCoversAmount: false, openPromiseCoversAmount: false, permissionState: "permitted" };
  it("each of E-1..E-4 yields ZERO steps", () => {
    const settled = evaluateDunning(steps, 0, 5, { ...clearFacts, settled: true }, 10);
    expect(settled.state === "suspended-by-exit-condition" && settled.condition).toBe("settled");
    const disputed = evaluateDunning(steps, 0, 5, { ...clearFacts, openDisputeCoversAmount: true }, 10);
    expect(disputed.state === "suspended-by-exit-condition" && disputed.condition).toBe("disputed");
    const promised = evaluateDunning(steps, 0, 5, { ...clearFacts, openPromiseCoversAmount: true }, 10);
    expect(promised.state === "suspended-by-exit-condition" && promised.condition).toBe("promised");
    const capped = evaluateDunning(steps, 0, 5, { ...clearFacts, permissionState: "cap-exhausted" }, 10);
    expect(capped.state === "suspended-by-exit-condition" && capped.condition).toBe("permission");
    for (const r of [settled, disputed, promised, capped]) expect(r.dueSteps).toHaveLength(0);
  });
  it("a cease is TERMINAL; cap exhaustion is not", () => {
    const ceased = evaluateDunning(steps, 0, 5, { ...clearFacts, permissionState: "cease" }, 10);
    expect(ceased.state).toBe("halted-by-permission");
    if (ceased.state === "halted-by-permission") expect(ceased.terminal).toBe(true);
  });
  it("maxSteps reached is exhausted-with-review, not terminal-and-forgotten", () => {
    const r = evaluateDunning(steps, 5, 5, clearFacts, 10);
    expect(r.state).toBe("exhausted");
    if (r.state === "exhausted") expect(r.humanReviewRequired).toBe(true);
  });
  it("clear facts yield the due steps in order", () => {
    const r = evaluateDunning(steps, 0, 5, clearFacts, 8);
    expect(r.state === "steps-due" && r.dueSteps).toEqual(["s1", "s2"]);
  });
});

describe("M-5 escalation — fails closed", () => {
  it("an external-consequence rung with no Governance grant refuses", () => {
    const r = moveRung({ rungId: "external-referral", requiresGovernance: true, requiresHumanPrincipal: true }, undefined, "human.steven");
    expect(!r.ok && r.refusal.kind).toBe("escalation_requires_governance");
  });
  it("a human-principal rung refuses a system principal", () => {
    const r = moveRung({ rungId: "final-demand", requiresGovernance: true, requiresHumanPrincipal: true }, true, "system.batch");
    expect(r.ok).toBe(false);
    const proper = moveRung({ rungId: "final-demand", requiresGovernance: true, requiresHumanPrincipal: true }, true, "human.steven");
    expect(proper.ok).toBe(true);
    if (proper.ok) expect(proper.value.recordedAs).toBe("journal-entry");
  });
});

describe("M-6 contact caps — unknown counts against the cap (H-6)", () => {
  const record = (atDate: string, overrides?: Partial<ContactRecord>): ContactRecord => ({
    atDate,
    channelClass: "voice",
    direction: "outbound",
    connectionOutcome: "outcome-unknown",
    priorConsentWithinWindow: false,
    ...overrides,
  });
  it("outcome-unknown counts; evidenced no-connect is excluded; inbound never counts", () => {
    const v = evaluateFrequency(
      [
        record("2026-08-25"), // unknown → counts
        record("2026-08-26", { connectionOutcome: "no-connect" }), // evidence → excluded
        record("2026-08-27", { direction: "inbound", connectionOutcome: "connected-conversation" }), // inbound → not counted
        record("2026-08-28", { connectionOutcome: "connected-conversation" }), // counts
      ],
      "2026-08-30",
      7,
      7,
      7,
    );
    expect(v.countedAttempts).toBe(2);
    expect(v.capReached).toBe(false);
    // The inbound CONVERSATION starts the post-conversation window.
    expect(v.inPostConversationWindow).toBe(true);
  });
  it("seven attempts in seven days reaches the cap", () => {
    const records = Array.from({ length: 7 }, (_, i) => record(`2026-08-2${4 + Math.min(i, 5)}`));
    const v = evaluateFrequency(records, "2026-08-30", 7, 7, 7);
    expect(v.capReached).toBe(true);
  });
});

describe("M-7 quiet hours — the contacted party's clock or nothing", () => {
  it("unknown timezone refuses every time-bound channel — never the tenant's zone, never UTC", () => {
    expect(evaluateQuietHours(undefined, true)).toBe("refused-unknown-locale");
    expect(evaluateQuietHours(undefined, false)).toBe("permitted"); // non-time-bound channel
  });
  it("8am–9pm local: 7:59 refuses, 8:00 permits, 21:00 refuses", () => {
    expect(evaluateQuietHours(7, true)).toBe("refused-quiet-hours");
    expect(evaluateQuietHours(8, true)).toBe("permitted");
    expect(evaluateQuietHours(20, true)).toBe("permitted");
    expect(evaluateQuietHours(21, true)).toBe("refused-quiet-hours");
  });
});

describe("M-8 write-off candidacy — conditions, not a collectability judgement", () => {
  it("enumerates the met bases, requires authorization, judges nothing", () => {
    const c = writeOffCandidacy("cust-9", {
      ageDays: 400,
      ageThresholdDays: 365,
      sequenceExhausted: true,
      uncontactable: false,
      amountMinor: 5_000n,
      pursuitCostThresholdMinor: 10_000n,
    });
    expect(c).not.toBeNull();
    expect(c!.basis).toHaveLength(3);
    expect(c!.authorizationRequired).toBe(true);
    expect(c!.collectabilityJudgement).toBe("none");
  });
  it("no condition met → no candidate", () => {
    const c = writeOffCandidacy("cust-10", {
      ageDays: 30,
      ageThresholdDays: 365,
      sequenceExhausted: false,
      uncontactable: false,
      amountMinor: 50_000n,
      pursuitCostThresholdMinor: 10_000n,
    });
    expect(c).toBeNull();
  });
});

describe("M-9 association — defined by what it refuses to claim", () => {
  it("observational data: causalClaim none, five confounders named", () => {
    const r = associateActionOutcome(120_000n, 14);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.causalClaim !== "none") return;
    expect(r.value.confounders).toHaveLength(5);
    expect(r.value.confounders.join(" ")).toContain("payer's AP run date");
  });
  it("a retrospective experiment design is refused — it cannot be created after the actions", () => {
    const r = associateActionOutcome(0n, 14, {
      designRef: "exp-1",
      designRecordedAt: "2026-08-20",
      firstActionAt: "2026-08-10",
      betweenArmDifferenceMinor: 500n,
    });
    expect(!r.ok && r.refusal.kind).toBe("experiment_design_not_predating_actions");
  });
  it("a pre-registered design permits the one honest causal claim", () => {
    const r = associateActionOutcome(0n, 14, {
      designRef: "exp-2",
      designRecordedAt: "2026-08-01",
      firstActionAt: "2026-08-10",
      betweenArmDifferenceMinor: 500n,
    });
    expect(r.ok && r.value.causalClaim).toBe("randomized-within-tenant");
  });
});

// ── Guards for all three Family 6 packages ──────────────────────────────────

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

describe("guards — billingiq, collectionsiq, creditiq", () => {
  const roots = ["billingiq", "collectionsiq", "creditiq"].map((p) => join(process.cwd(), "packages", p, "src"));
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no float leaks", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("G-10: creditiq exposes no field named exposure carrying a partial sum", () => {
    for (const f of files.filter((x) => x.path.includes("creditiq"))) {
      expect(/\bexposureMinor\s*:/.test(f.text), f.path).toBe(false); // knownFloorMinor is the name
    }
  });
  it("no credit.limit.within event literal exists anywhere in creditiq", () => {
    for (const f of files.filter((x) => x.path.includes("creditiq"))) {
      expect(/credit\.limit\.within/.test(f.text.replace(/\/\/ no within event EXISTS/g, "")), f.path).toBe(false);
    }
  });
});
