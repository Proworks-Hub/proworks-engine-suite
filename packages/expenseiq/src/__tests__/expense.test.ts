// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  actualExpenseCeilingCheck,
  composeVerdict,
  deriveCoding,
  evaluatePolicy,
  matchCardLine,
  mileageEntitlement,
  perDiemDayEntitlement,
  personalChargeCandidate,
  registerRule,
  reimbursableAmount,
  tieredMileageEntitlement,
  type CardCandidate,
  type PolicyRuleDefinition,
} from "../kernel.js";

const rule = (overrides?: Partial<PolicyRuleDefinition>): PolicyRuleDefinition => ({
  ruleId: "meals.per-person-ceiling",
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-01-01",
  jurisdictionCurrency: "USD",
  isAggregateCeiling: false,
  severity: "reviewable",
  citation: { documentId: "policy-2026", version: "3", paragraph: "4.2" },
  requiredInputs: ["amountMinor", "attendeeCount"],
  test: (inputs) => {
    const perPerson = inputs.get("amountMinor")! / inputs.get("attendeeCount")!;
    return { pass: perPerson <= 7_500n, observed: perPerson.toString(), threshold: "7500" };
  },
  ...overrides,
});

describe("§16.1 registration-time validation — a bad rule never evaluates", () => {
  it("effectiveTo before effectiveFrom is rejected at registration", () => {
    const r = registerRule(rule({ effectiveFrom: "2025-01-01", effectiveTo: "2020-01-01" }));
    expect(!r.ok && r.refusal.kind).toBe("rule_registration_invalid");
  });
  it("a threshold currency differing from the jurisdiction's is rejected", () => {
    const r = registerRule(rule({ thresholdCurrency: "GBP" }));
    expect(!r.ok && r.refusal.kind).toBe("rule_registration_invalid");
  });
  it("an aggregate ceiling with no window is rejected", () => {
    const r = registerRule(rule({ isAggregateCeiling: true }));
    expect(!r.ok && r.refusal.kind).toBe("rule_registration_invalid");
    expect(registerRule(rule({ isAggregateCeiling: true, aggregateWindowDays: 90 })).ok).toBe(true);
  });
});

describe("§16.2 the evaluation kernel — total, deterministic, honest about missing inputs", () => {
  const failing = rule({
    ruleId: "a.always-fails",
    severity: "advisory",
    requiredInputs: [],
    test: () => ({ pass: false, observed: "x", threshold: "y" }),
  });
  const passing = rule({ ruleId: "z.passes", requiredInputs: [], test: () => ({ pass: true, observed: "1", threshold: "2" }) });
  it("evaluation is TOTAL: a fail does not short-circuit the rest", () => {
    const r = evaluatePolicy([failing, passing, rule()], () => true, new Map([["amountMinor", 20_000n], ["attendeeCount", 4n]]));
    expect(r.evaluations).toHaveLength(3); // every applicable rule evaluated
    expect(r.evaluations.filter((e) => e.outcome === "pass")).toHaveLength(2);
    expect(r.evaluations.filter((e) => e.outcome === "fail")).toHaveLength(1);
  });
  it("a missing required input is UNDETERMINABLE with the names — never pass", () => {
    const r = evaluatePolicy([rule()], () => true, new Map([["amountMinor", 60_000n]]));
    expect(r.evaluations[0]!.outcome).toBe("undeterminable");
    if (r.evaluations[0]!.outcome === "undeterminable") {
      expect(r.evaluations[0]!.missing).toEqual(["attendeeCount"]);
    }
    expect(r.verdictClass).toBe("undeterminable");
  });
  it("undeterminable OUTRANKS a blocking fail — an unevaluable claim is neither compliant nor a violation", () => {
    expect(
      composeVerdict([
        { outcome: "fail", ruleId: "x", observed: "", threshold: "", severity: "blocking", citation: rule().citation },
        { outcome: "undeterminable", ruleId: "y", missing: ["receipt"] },
      ]),
    ).toBe("undeterminable");
  });
  it("severity ladder composes: blocking > reviewable > advisory > in-policy", () => {
    const citation = rule().citation;
    const fail = (severity: "advisory" | "reviewable" | "blocking") =>
      ({ outcome: "fail", ruleId: "x", observed: "", threshold: "", severity, citation }) as const;
    expect(composeVerdict([fail("advisory"), fail("blocking")])).toBe("out-of-policy-blocking");
    expect(composeVerdict([fail("advisory"), fail("reviewable")])).toBe("out-of-policy-reviewable");
    expect(composeVerdict([fail("advisory")])).toBe("out-of-policy-advisory");
    expect(composeVerdict([{ outcome: "pass", ruleId: "x", observed: "", threshold: "" }])).toBe("in-policy");
  });
  it("every fail carries the rule's citation by value", () => {
    const r = evaluatePolicy([rule()], () => true, new Map([["amountMinor", 100_000n], ["attendeeCount", 2n]]));
    const fail = r.evaluations[0]!;
    expect(fail.outcome).toBe("fail");
    if (fail.outcome === "fail") expect(fail.citation.paragraph).toBe("4.2");
  });
  it("shuffling the rule list never changes the verdict class", () => {
    const rules = [failing, passing, rule()];
    const inputs = new Map([["amountMinor", 60_000n], ["attendeeCount", 4n]]);
    const forward = evaluatePolicy(rules, () => true, inputs);
    const reversed = evaluatePolicy([...rules].reverse(), () => true, inputs);
    expect(forward.verdictClass).toBe(reversed.verdictClass);
    expect(forward.evaluations.map((e) => e.ruleId)).toEqual(reversed.evaluations.map((e) => e.ruleId));
  });
});

describe("§16.3 reimbursable amount — absent, not zero, over a blocking claim", () => {
  const cleanVerdict = evaluatePolicy([], () => false, new Map());
  it("a blocking verdict yields NO amount field", () => {
    const blocking = { ...cleanVerdict, verdictClass: "out-of-policy-blocking" as const };
    const r = reimbursableAmount(10_000n, blocking, []);
    expect(r.state).toBe("no-amount");
    expect("amountMinor" in r).toBe(false);
  });
  it("the LOWEST ceiling wins and the supplying rule is recorded", () => {
    const r = reimbursableAmount(10_000n, cleanVerdict, [
      { ruleId: "cap.high", ceilingMinor: 9_000n },
      { ruleId: "cap.low", ceilingMinor: 7_500n },
    ]);
    expect(r.state).toBe("payable");
    if (r.state !== "payable") return;
    expect(r.amountMinor).toBe(7_500n);
    expect(r.cappedByRuleId).toBe("cap.low");
  });
  it("a reviewable verdict yields a PROVISIONAL amount", () => {
    const reviewable = { ...cleanVerdict, verdictClass: "out-of-policy-reviewable" as const };
    const r = reimbursableAmount(10_000n, reviewable, []);
    expect(r.state).toBe("provisional");
  });
});

describe("§16.4 per diem — the partial-day factor applies to M&IE only", () => {
  const rateRef = {
    lodgingCeilingMinor: 15_000n,
    mieTotalMinor: 8_000n,
    mieBreakdown: { breakfastMinor: 1_800n, lunchMinor: 2_000n, dinnerMinor: 3_400n },
    firstLastDayFactorPermille: 750n,
  };
  it("a full day: min(lodging, ceiling) + full M&IE", () => {
    const r = perDiemDayEntitlement(rateRef, { actualLodgingMinor: 17_000n, isFirstOrLast: false, providedMeals: [] });
    expect(r.state === "entitled" && r.amountMinor).toBe(15_000n + 8_000n);
  });
  it("first/last day: lodging FULL, M&IE at 75% — the factor never touches lodging", () => {
    const r = perDiemDayEntitlement(rateRef, { actualLodgingMinor: 14_000n, isFirstOrLast: true, providedMeals: [] });
    expect(r.state === "entitled" && r.amountMinor).toBe(14_000n + 6_000n);
  });
  it("provided meals deduct from the rate ref's own breakdown", () => {
    const r = perDiemDayEntitlement(rateRef, { actualLodgingMinor: 0n, isFirstOrLast: false, providedMeals: ["lunch", "dinner"] });
    expect(r.state === "entitled" && r.amountMinor).toBe(8_000n - 2_000n - 3_400n);
  });
  it("a provided-meal flag with no breakdown is undeterminable — no guessed fraction", () => {
    const r = perDiemDayEntitlement({ ...rateRef, mieBreakdown: null }, { actualLodgingMinor: 0n, isFirstOrLast: false, providedMeals: ["dinner"] });
    expect(r.state).toBe("undeterminable");
  });
  it("the 300% actual-expense ceiling is a rule that FAILS, not a clamp", () => {
    expect(actualExpenseCeilingCheck(24_001n, 8_000n).pass).toBe(false);
    expect(actualExpenseCeilingCheck(24_000n, 8_000n).pass).toBe(true);
  });
});

describe("§16.5 mileage — the two traps", () => {
  it("trap 1: a boundary-spanning trip splits into date segments, each at its own rate", () => {
    const periods = [
      { fromDate: "2026-01-01", toDate: "2026-06-30", ratePerUnitMinor: 725n, unitSystem: "miles" as const },
      { fromDate: "2026-07-01", toDate: "2026-12-31", ratePerUnitMinor: 760n, unitSystem: "miles" as const },
    ];
    const r = mileageEntitlement(
      [
        { date: "2026-06-28", distance: 100n, unitSystem: "miles" },
        { date: "2026-07-02", distance: 100n, unitSystem: "miles" },
      ],
      periods,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.state !== "entitled") return;
    expect(r.value.amountMinor).toBe(100n * 725n + 100n * 760n); // never one blended rate
  });
  it("a kilometre distance against a per-mile rate refuses", () => {
    const r = mileageEntitlement(
      [{ date: "2026-03-01", distance: 100n, unitSystem: "kilometres" }],
      [{ fromDate: "2026-01-01", toDate: "2026-12-31", ratePerUnitMinor: 725n, unitSystem: "miles" }],
    );
    expect(!r.ok && r.refusal.kind).toBe("unit_system_mismatch");
  });
  it("trap 2: an absent year-to-date snapshot is UNDETERMINABLE — zero is not a default", () => {
    const r = tieredMileageEntitlement(1_000n, 10_000n, 45n, 25n, undefined);
    expect(r.state).toBe("undeterminable");
  });
  it("the tier boundary is cumulative: miles already claimed move this claim across it", () => {
    // 9,800 miles claimed; 1,000 more → 200 at 45p, 800 at 25p.
    const r = tieredMileageEntitlement(1_000n, 10_000n, 45n, 25n, { milesToDate: 9_800n, asOf: "2026-08-30" });
    expect(r.state === "entitled" && r.amountMinor).toBe(200n * 45n + 800n * 25n);
  });
});

describe("§16.6/§16.7 card matching — ordinal ranks, and candidates that are not accusations", () => {
  const candidate = (transactionRef: string, overrides?: Partial<CardCandidate>): CardCandidate => ({
    transactionRef,
    amountExact: true,
    amountWithinTolerance: true,
    dateExact: true,
    dateWithinWindow: true,
    merchantMatch: true,
    ...overrides,
  });
  it("R1 unique matches; R1 tie is ambiguous listing all candidates", () => {
    expect(matchCardLine([candidate("t1")], false).outcome).toBe("matched");
    const tie = matchCardLine([candidate("t1"), candidate("t2")], false);
    expect(tie.outcome).toBe("ambiguous");
    if (tie.outcome === "ambiguous") expect(tie.candidates).toHaveLength(2);
  });
  it("R4 (amount within tolerance only) is ambiguous ALWAYS — the two-lunches-same-day rule", () => {
    const r = matchCardLine([candidate("t1", { amountExact: false })], true);
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome === "ambiguous") expect(r.rank).toBe("R4");
  });
  it("amount alone is never a match", () => {
    const r = matchCardLine(
      [candidate("t1", { amountExact: false, dateExact: false, dateWithinWindow: false, merchantMatch: false })],
      true,
    );
    expect(r.outcome).toBe("no-match");
  });
  it("R3 single candidate matches only under the tenant's explicit auto-match setting", () => {
    const r3only = [candidate("t1", { dateExact: false, merchantMatch: false })];
    expect(matchCardLine(r3only, false).outcome).toBe("ambiguous");
    expect(matchCardLine(r3only, true).outcome).toBe("matched");
  });
  it("a personal-charge candidate has no verdict and carries every reply path", () => {
    const c = personalChargeCandidate("t9", 4_200n, 31);
    expect("verdict" in c).toBe(false);
    expect(c.resolutionPaths).toEqual(["claim-as-business", "acknowledge-personal", "dispute-transaction"]);
    expect(c.eventName).toBe("expense.card.charge.unmatched");
  });
});

describe("§16.8 coding — an explicit refusal, never a suspense account", () => {
  const table = new Map([["US:meals", "6410-meals"]]);
  it("derives from the table with the derivation recorded", () => {
    const r = deriveCoding("meals", "US", table);
    expect(r.ok && r.value.accountRef).toBe("6410-meals");
  });
  it("no mapping refuses — a defaulted account is how miscoded spend becomes invisible", () => {
    const r = deriveCoding("travel", "US", table);
    expect(!r.ok && r.refusal.kind).toBe("no_mapping");
  });
});

// ── Guards for both Family 5 packages ───────────────────────────────────────

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

describe("guards — expenseiq, invoiceiq", () => {
  const roots = ["expenseiq", "invoiceiq"].map((p) => join(process.cwd(), "packages", p, "src"));
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no float leaks", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("G-11b: the word fraud appears nowhere in expenseiq source", () => {
    for (const f of files.filter((x) => x.path.includes("expenseiq"))) {
      expect(/fraud/i.test(f.text), f.path).toBe(false);
    }
  });
  it("G-9: confirmed-duplicate is assigned only inside recordDuplicateDecision", () => {
    const invoiceFiles = files.filter((x) => x.path.includes("invoiceiq"));
    for (const f of invoiceFiles) {
      // Type declaration + the parameter/record path only; no computed path.
      const computedAssignment = /disposition:\s*"confirmed-duplicate"(?!\s*\|)/.test(f.text);
      expect(computedAssignment, f.path).toBe(false);
    }
    // The literal does exist in the codebase (the human-decision path).
    const total = invoiceFiles.reduce((a, f) => a + f.text.split('"confirmed-duplicate"').length - 1, 0);
    expect(total).toBeGreaterThan(0);
  });
});
