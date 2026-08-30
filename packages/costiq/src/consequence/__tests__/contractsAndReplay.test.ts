/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import type { CostRate } from "../../domain/costModel.js";
import {
  COST_EVIDENCE_CONTRACT,
  answerCostQuestion,
  isAuthorization,
  type CostedOption,
} from "../costConsequence.js";
import {
  NO_GOVERNANCE,
  WHY_GOVERNED,
  engineMayAuthorizeItself,
  governanceRequestSchema,
  requestAuthorization,
  type CostGovernancePort,
  type GovernanceDecision,
} from "../../ports/governance.js";
import {
  acceptEvidence,
  acceptLookup,
  externalEvidenceQuerySchema,
  providerMaySetStrength,
  type ExternalEvidenceQuery,
} from "../../ports/externalEvidence.js";
import {
  explainHistoricalDifference,
  inForceAt,
  rateInForceAt,
  reconstructInputs,
} from "../../replay/historicalReplay.js";

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// Four boundaries: what another engine may conclude, what CostIQ may authorize,
// what an evidence provider may claim, and what "the rate at the time" means.
// ─────────────────────────────────────────────────────────────────────────────

const option = (over: Partial<CostedOption> & Pick<CostedOption, "optionId">): CostedOption => ({
  label: over.optionId,
  totalCost: d("100.00"),
  currency: "GBP",
  assumptions: [],
  evidenceScore: 90,
  ...over,
});

const ask = (options: readonly CostedOption[], materiality = "0.05") =>
  answerCostQuestion({
    questionId: "q1",
    askedBy: "SchedulingIQ",
    options,
    materialityFraction: d(materiality),
    scale: 6,
    mode: "HALF_EVEN",
  });

describe("answering another engine's economic question", () => {
  it("orders by cost and says the gap", () => {
    const r = ask([option({ optionId: "b", totalCost: d("130") }), option({ optionId: "a", totalCost: d("100") })]);
    expect(r.byCost.map((o) => o.optionId)).toEqual(["a", "b"]);
    expect(n(r.marginFraction!)).toBe("0.3");
  });

  it("calls the ordering EVIDENCE, in the text a consumer will read", () => {
    const r = ask([option({ optionId: "a", totalCost: d("100") }), option({ optionId: "b", totalCost: d("130") })]);
    expect(r.evidenceSummary).toContain("cost evidence, not an authorization and not a decision");
  });

  it("is never an authorization, and that is assertable from the consumer's side", () => {
    expect(isAuthorization()).toBe(false);
  });

  it("says a difference inside materiality does not separate the options", () => {
    // The common case for cross-engine questions, and the one most likely to be
    // consumed as a ranking by code nobody reads twice.
    const r = ask([option({ optionId: "a", totalCost: d("100") }), option({ optionId: "b", totalCost: d("102") })]);
    expect(r.tooCloseToDistinguish).toBe(true);
    expect(r.evidenceSummary).toContain("too small to distinguish");
    expect(r.stillToDecide.join()).toContain("could reverse on an input being slightly wrong");
  });

  it("does not call a wide gap too close", () => {
    const r = ask([option({ optionId: "a", totalCost: d("100") }), option({ optionId: "b", totalCost: d("200") })]);
    expect(r.tooCloseToDistinguish).toBe(false);
  });

  it("FLAGS the cheapest option also having the weakest evidence", () => {
    // The pattern an underestimate makes, and it looks identical to a win.
    const r = ask([
      option({ optionId: "cheap", totalCost: d("100"), evidenceScore: 20 }),
      option({ optionId: "known", totalCost: d("200"), evidenceScore: 95 }),
    ]);
    expect(r.cheapestIsLeastEvidenced).toBe(true);
    expect(r.stillToDecide.join()).toContain("genuinely cheapest or merely least known");
  });

  it("does not flag it when the cheapest is also the best evidenced", () => {
    const r = ask([
      option({ optionId: "cheap", totalCost: d("100"), evidenceScore: 95 }),
      option({ optionId: "other", totalCost: d("200"), evidenceScore: 40 }),
    ]);
    expect(r.cheapestIsLeastEvidenced).toBe(false);
  });

  it("carries the assumptions across the boundary, labelled by option", () => {
    const r = ask([
      option({ optionId: "a", assumptions: ["Steel holds at March price"] }),
      option({ optionId: "b", totalCost: d("200"), assumptions: ["Overtime available"] }),
    ]);
    expect(r.unresolvedAssumptions).toEqual(["a: Steel holds at March price", "b: Overtime available"]);
  });

  it("always leaves something for the asking engine to decide", () => {
    const r = ask([option({ optionId: "a" }), option({ optionId: "b", totalCost: d("500") })]);
    expect(r.stillToDecide.length).toBeGreaterThan(0);
    expect(r.stillToDecide.join()).toContain("usually is not the only one");
  });

  it("REFUSES a comparison of one", () => {
    // Otherwise a consumer reads "the cheapest option is X" from a set with no
    // alternative in it.
    expect(() => ask([option({ optionId: "a" })])).toThrow(/at least two options/);
  });

  it("REFUSES to compare across currencies", () => {
    expect(() =>
      ask([option({ optionId: "a" }), option({ optionId: "b", currency: "USD" })]),
    ).toThrow(/convert deliberately before asking/);
  });

  it("breaks cost ties deterministically, so one question has one answer", () => {
    const r = ask([option({ optionId: "zulu" }), option({ optionId: "alpha" })]);
    expect(r.byCost.map((o) => o.optionId)).toEqual(["alpha", "zulu"]);
  });

  it("states what a consumer must NOT conclude", () => {
    const forbidden = COST_EVIDENCE_CONTRACT.doesNotEntitle.join(" ");
    expect(forbidden).toContain("did not weigh them against anything else that matters");
    expect(forbidden).toContain("acting on noise");
    expect(forbidden).toContain("It is cheaper.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const govRequest = (over: Record<string, unknown> = {}) => ({
  instanceId: "hub-1",
  tenantId: "ksix",
  principalId: "user-42",
  action: "SAVE_APPROVED_RATE",
  resourceId: "basis:steel",
  isTest: false,
  ...over,
});

const allowingPort = (over: Partial<GovernanceDecision> = {}): CostGovernancePort => ({
  authorize: async () => ({
    allowed: true,
    decisionId: "dec-1",
    reason: "Approved by the rate committee.",
    decidedAt: "2026-08-30T00:00:00.000Z",
    ...over,
  }),
});

describe("CostIQ asks permission and cannot answer itself", () => {
  it("never authorizes its own actions", () => {
    expect(engineMayAuthorizeItself()).toBe(false);
  });

  it("passes a well-formed request through and returns the decision", async () => {
    const outcome = await requestAuthorization(allowingPort(), govRequest());
    expect(outcome.authorized).toBe(true);
    if (outcome.authorized) expect(outcome.decision.decisionId).toBe("dec-1");
  });

  it("REFUSES everything when no port is bound", async () => {
    // The failure mode this prevents: safe in production, wide open anywhere
    // somebody forgot to wire it up.
    const outcome = await requestAuthorization(NO_GOVERNANCE, govRequest());
    expect(outcome.authorized).toBe(false);
    if (outcome.authorized) throw new Error("should have refused");
    expect(outcome.reason).toContain("fail-closed default");
  });

  it("explains WHY the action is governed when it refuses", async () => {
    const outcome = await requestAuthorization(NO_GOVERNANCE, govRequest({ action: "PROMOTE_KNOWLEDGE" }));
    if (outcome.authorized) throw new Error("should have refused");
    expect(outcome.reason).toContain("unverified starts being treated as fact");
  });

  it("treats a thrown port as a refusal", async () => {
    // Failing open here would fail open exactly when something is already wrong.
    const throwing: CostGovernancePort = {
      authorize: async () => {
        throw new Error("authorizer unreachable");
      },
    };
    const outcome = await requestAuthorization(throwing, govRequest());
    expect(outcome.authorized).toBe(false);
    if (outcome.authorized) throw new Error("should have refused");
    expect(outcome.reason).toContain("fail open exactly when something is already wrong");
  });

  it("does not quote what the port threw", async () => {
    // A thrown value from a bound port is untrusted, and the reason goes into
    // an audit log.
    const throwing: CostGovernancePort = {
      authorize: async () => {
        throw new Error("secret-token-sk-abc123");
      },
    };
    const outcome = await requestAuthorization(throwing, govRequest());
    if (outcome.authorized) throw new Error("should have refused");
    expect(outcome.reason).not.toContain("secret-token");
  });

  it("treats an unreadable answer as a refusal", async () => {
    const nonsense = { authorize: async () => ({ yes: true }) } as unknown as CostGovernancePort;
    const outcome = await requestAuthorization(nonsense, govRequest());
    expect(outcome.authorized).toBe(false);
    if (outcome.authorized) throw new Error("should have refused");
    expect(outcome.reason).toContain("unreadable answer is not a yes");
  });

  it("treats an allow with no decision id as a refusal", async () => {
    // An allow nobody can point at later is not an allow.
    const anonymous = { authorize: async () => ({ allowed: true, decisionId: "" }) } as unknown as CostGovernancePort;
    expect((await requestAuthorization(anonymous, govRequest())).authorized).toBe(false);
  });

  it("does not even ask when the request is malformed", async () => {
    let asked = false;
    const watching: CostGovernancePort = {
      authorize: async () => {
        asked = true;
        return { allowed: true, decisionId: "d", reason: "", decidedAt: "" };
      },
    };
    const outcome = await requestAuthorization(watching, { action: "SAVE_APPROVED_RATE" });
    expect(outcome.authorized).toBe(false);
    expect(asked).toBe(false);
  });

  it("refuses an action outside the closed list", () => {
    expect(governanceRequestSchema.safeParse(govRequest({ action: "DELETE_EVERYTHING" })).success).toBe(false);
  });

  it("requires test identity with no default", () => {
    const { isTest, ...withoutRealm } = govRequest();
    expect(governanceRequestSchema.safeParse(withoutRealm).success).toBe(false);
  });

  it("gives every governed action a stated reason for being governed", () => {
    for (const action of Object.keys(WHY_GOVERNED)) {
      expect(WHY_GOVERNED[action as keyof typeof WHY_GOVERNED].length).toBeGreaterThan(0);
    }
  });

  it("returns a refusal decision that can be found later", async () => {
    const refusing: CostGovernancePort = {
      authorize: async () => ({
        allowed: false,
        decisionId: "dec-refused-9",
        reason: "Outside the requester's authority.",
        decidedAt: "2026-08-30T00:00:00.000Z",
      }),
    };
    const outcome = await requestAuthorization(refusing, govRequest());
    expect(outcome.authorized).toBe(false);
    if (outcome.authorized) throw new Error("should have refused");
    // "We asked and were told no" must be distinguishable from never asking.
    expect(outcome.decision?.decisionId).toBe("dec-refused-9");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const query: ExternalEvidenceQuery = {
  subjectRef: "material:steel-3mm",
  requiredUnit: "kg",
  requiredCurrency: "GBP",
  asOf: "2026-08-30T00:00:00.000Z",
  tenantId: "ksix",
  isTest: false,
};

const evidence = (over: Record<string, unknown> = {}) => ({
  sourceRef: "INV-1001",
  sourceSystem: "ReceiptIQ",
  sourceKind: "SUPPLIER_QUOTE",
  amount: "2.40",
  currency: "GBP",
  unit: "kg",
  observedAt: "2026-08-01T00:00:00.000Z",
  caveats: [],
  ...over,
});

describe("evidence from outside is still untrusted", () => {
  it("accepts well-formed evidence and grades it here", () => {
    const outcome = acceptEvidence(evidence(), query);
    expect(outcome.accepted).toBe(true);
    // SUPPLIER_QUOTE is 75 in the strength table. The provider did not say so.
    if (outcome.accepted) expect(outcome.strength).toBe(75);
  });

  it("never lets a provider state its own strength", () => {
    expect(providerMaySetStrength()).toBe(false);
    // And there is no field for it, so a provider that tried would be refused.
    expect(acceptEvidence({ ...evidence(), sourceStrength: 100 }, query).accepted).toBe(false);
  });

  it("refuses a source kind outside the closed list", () => {
    expect(acceptEvidence(evidence({ sourceKind: "TRUST_ME" }), query).accepted).toBe(false);
  });

  it("refuses an amount that is not a decimal string", () => {
    expect(acceptEvidence(evidence({ amount: 2.4 }), query).accepted).toBe(false);
  });

  it("REFUSES a unit mismatch rather than converting inside a lookup", () => {
    const outcome = acceptEvidence(evidence({ unit: "tonne" }), query);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toContain("hide a unit assumption inside a lookup");
  });

  it("REFUSES a currency mismatch rather than converting silently", () => {
    const outcome = acceptEvidence(evidence({ currency: "USD" }), query);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toContain("evidence in their own right");
  });

  it("REFUSES evidence observed after the moment being asked about", () => {
    // Answering a question about the past with information from the future.
    // The number is perfectly plausible, which is why nobody looks for it.
    const outcome = acceptEvidence(evidence({ observedAt: "2026-09-15T00:00:00.000Z" }), query);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toContain("could never be reproduced as it stood");
  });

  it("accepts evidence observed at exactly the moment asked about", () => {
    expect(acceptEvidence(evidence({ observedAt: query.asOf }), query).accepted).toBe(true);
  });

  it("requires the query to name a moment", () => {
    const { asOf, ...withoutDate } = query;
    expect(externalEvidenceQuerySchema.safeParse(withoutDate).success).toBe(false);
  });

  it("distinguishes 'found nothing' from 'could not look'", () => {
    // The two need completely different responses, and an empty array reads the
    // same as a failed call.
    expect(acceptLookup([], query).result.outcome).toBe("NONE_AVAILABLE");
    expect(acceptLookup(null, query).result.outcome).toBe("UNAVAILABLE");
    expect(acceptLookup("nonsense", query).result.outcome).toBe("UNAVAILABLE");
  });

  it("warns not to conclude a subject is unpriced from a failed lookup", () => {
    const r = acceptLookup(undefined, query);
    expect(r.result.outcome).toBe("UNAVAILABLE");
    if (r.result.outcome === "UNAVAILABLE") {
      expect(r.result.note).toContain("do not fall back to a default");
    }
  });

  it("keeps the usable evidence from a mixed batch", () => {
    const r = acceptLookup([evidence(), evidence({ currency: "USD" }), evidence({ sourceRef: "INV-2" })], query);
    expect(r.result.outcome).toBe("FOUND");
    if (r.result.outcome === "FOUND") expect(r.result.evidence).toHaveLength(2);
    expect(r.rejected.map((x) => x.index)).toEqual([1]);
  });

  it("says when a provider had something and none of it fit", () => {
    // Not the same as none existing, and the difference is actionable.
    const r = acceptLookup([evidence({ currency: "USD" })], query);
    expect(r.result.outcome).toBe("NONE_AVAILABLE");
    if (r.result.outcome === "NONE_AVAILABLE") {
      expect(r.result.note).toContain("not the same as none existing");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const rate = (over: Partial<CostRate> & Pick<CostRate, "rateId">): CostRate =>
  ({
    amount: "2.00",
    currency: "GBP",
    unit: "kg",
    sourceKind: "SUPPLIER_QUOTE",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as CostRate;

describe("the rate that was in force, not the rate in force now", () => {
  it("treats the interval as half-open: start inclusive, end exclusive", () => {
    const r = rate({
      rateId: "r1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-06-01T00:00:00.000Z",
    });
    expect(inForceAt(r, "2025-12-31T23:59:59.999Z")).toBe(false);
    expect(inForceAt(r, "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(inForceAt(r, "2026-05-31T23:59:59.999Z")).toBe(true);
    // Exclusive: on the instant it ends, it is no longer in force.
    expect(inForceAt(r, "2026-06-01T00:00:00.000Z")).toBe(false);
  });

  it("treats a rate with no end as still in force", () => {
    expect(inForceAt(rate({ rateId: "r1" }), "2030-01-01T00:00:00.000Z")).toBe(true);
  });

  it("picks the rate in force at the moment asked about", () => {
    const history = [
      rate({ rateId: "old", amount: "2.00", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-06-01T00:00:00.000Z" }),
      rate({ rateId: "new", amount: "3.00", effectiveFrom: "2026-06-01T00:00:00.000Z" }),
    ];
    const selection = rateInForceAt(history, "2026-03-01T00:00:00.000Z");
    expect(selection.found).toBe(true);
    if (selection.found) expect(selection.rate.rateId).toBe("old");
  });

  it("does not treat a rate ending where another begins as an overlap", () => {
    // The whole reason the interval is half-open. Getting this wrong makes two
    // rates in force on the boundary day, silently.
    const history = [
      rate({ rateId: "old", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-06-01T00:00:00.000Z" }),
      rate({ rateId: "new", effectiveFrom: "2026-06-01T00:00:00.000Z" }),
    ];
    const selection = rateInForceAt(history, "2026-06-01T00:00:00.000Z");
    expect(selection.found).toBe(true);
    if (selection.found) expect(selection.rate.rateId).toBe("new");
  });

  it("REFUSES a genuine overlap rather than picking the first", () => {
    // Picking one would make the replay depend on the order rows came back.
    const history = [
      rate({ rateId: "a", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
      rate({ rateId: "b", effectiveFrom: "2026-02-01T00:00:00.000Z" }),
    ];
    const selection = rateInForceAt(history, "2026-03-01T00:00:00.000Z");
    expect(selection.found).toBe(false);
    if (!selection.found) expect(selection.reason).toContain("depend on the order");
  });

  it("says an empty history is not a rate of zero", () => {
    const selection = rateInForceAt([], "2026-03-01T00:00:00.000Z");
    expect(selection.found).toBe(false);
    if (!selection.found) expect(selection.reason).toContain('not "the rate was zero"');
  });

  it("says when a history exists but covers nothing at that moment", () => {
    const history = [rate({ rateId: "later", effectiveFrom: "2027-01-01T00:00:00.000Z" })];
    const selection = rateInForceAt(history, "2026-03-01T00:00:00.000Z");
    expect(selection.found).toBe(false);
    if (!selection.found) expect(selection.reason).toContain("this history does not contain");
  });
});

describe("reconstructing what the engine would have seen", () => {
  const histories = new Map<string, readonly CostRate[]>([
    ["steel", [rate({ rateId: "s1", amount: "2.00", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-06-01T00:00:00.000Z" }), rate({ rateId: "s2", amount: "3.00", effectiveFrom: "2026-06-01T00:00:00.000Z" })]],
    ["labour", [rate({ rateId: "l1", amount: "40.00", effectiveFrom: "2026-01-01T00:00:00.000Z" })]],
  ]);

  it("resolves every basis to the rate in force then", () => {
    const r = reconstructInputs(histories, "2026-03-01T00:00:00.000Z");
    expect(r.complete).toBe(true);
    expect(r.rates.get("steel")!.amount).toBe("2.00");
    expect(r.note).toContain("stronger claim than recomputing from today's rates");
  });

  it("refuses to call a partial reconstruction a replay", () => {
    const gappy = new Map(histories);
    gappy.set("finish", []);
    const r = reconstructInputs(gappy, "2026-03-01T00:00:00.000Z");
    expect(r.complete).toBe(false);
    expect(r.note).toContain("NOT a replay");
    expect(r.unresolved.map((u) => u.basisId)).toEqual(["finish"]);
  });

  it("produces the same reconstruction whatever order the bases arrive in", () => {
    const reversed = new Map([...histories.entries()].reverse());
    const a = reconstructInputs(histories, "2026-03-01T00:00:00.000Z");
    const b = reconstructInputs(reversed, "2026-03-01T00:00:00.000Z");
    expect(b.note).toBe(a.note);
    expect([...b.rates.keys()].sort()).toEqual([...a.rates.keys()].sort());
  });

  it("lists UNRESOLVED bases in a stable order too", () => {
    // Where the sort actually earns its place. With everything resolving, the
    // note is built from counts and reads the same either way; it is the
    // unresolved list that would otherwise follow Map insertion order, and a
    // diff that reorders itself is a diff people stop reading.
    const gappy = new Map<string, readonly CostRate[]>([
      ["zinc", []],
      ["alloy", []],
      ["steel", histories.get("steel")!],
    ]);
    const reversed = new Map([...gappy.entries()].reverse());

    expect(reconstructInputs(gappy, "2026-03-01T00:00:00.000Z").unresolved.map((u) => u.basisId)).toEqual([
      "alloy",
      "zinc",
    ]);
    expect(reconstructInputs(reversed, "2026-03-01T00:00:00.000Z").unresolved.map((u) => u.basisId)).toEqual([
      "alloy",
      "zinc",
    ]);
  });
});

describe("why an old estimate does or does not reproduce", () => {
  const complete = reconstructInputs(
    new Map([["steel", [rate({ rateId: "s1", amount: "2.00" })]]]),
    "2026-03-01T00:00:00.000Z",
  );

  it("confirms an exact reproduction", () => {
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map([["steel", rate({ rateId: "s1", amount: "2.00" })]]),
      recordedMethodVersion: "direct-job-cost@1.0.0",
      recordedTotal: "412.80",
      replayedTotal: "412.80",
    });
    expect(r.reproduced).toBe(true);
  });

  it("notes when a reproduction only worked because history was used", () => {
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map([["steel", rate({ rateId: "s2", amount: "3.00" })]]),
      recordedMethodVersion: "direct-job-cost@1.0.0",
      recordedTotal: "412.80",
      replayedTotal: "412.80",
    });
    expect(r.reproduced).toBe(true);
    if (r.reproduced) expect(r.note).toContain("would not have matched");
  });

  it("refuses to compare when the inputs could not be rebuilt", () => {
    const partial = reconstructInputs(new Map([["steel", []]]), "2026-03-01T00:00:00.000Z");
    const r = explainHistoricalDifference({
      reconstructed: partial,
      currentRates: new Map(),
      recordedMethodVersion: "m@1",
      recordedTotal: "1",
      replayedTotal: "1",
    });
    expect(r.reproduced).toBe(false);
    if (!r.reproduced) expect(r.cause).toBe("INPUTS_UNAVAILABLE");
  });

  it("does not let a matching total imply reproduction when the method is unknown", () => {
    // The common case for anything migrated from v1. A match proves today's
    // method agrees, which is a much weaker claim.
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map([["steel", rate({ rateId: "s1", amount: "2.00" })]]),
      recordedMethodVersion: null,
      recordedTotal: "412.80",
      replayedTotal: "412.80",
    });
    expect(r.reproduced).toBe(false);
    if (!r.reproduced) {
      expect(r.cause).toBe("METHOD_VERSION_UNKNOWN");
      expect(r.note).toContain("much weaker claim");
    }
  });

  it("blames changed rates before the arithmetic", () => {
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map([["steel", rate({ rateId: "s2", amount: "3.00" })]]),
      recordedMethodVersion: "m@1",
      recordedTotal: "412.80",
      replayedTotal: "500.00",
    });
    if (!r.reproduced) {
      expect(r.cause).toBe("RATES_CHANGED");
      expect(r.changedBases).toEqual([{ basisId: "steel", then: "2.00", now: "3.00" }]);
      expect(r.note).toContain("boundary of an effective interval is the usual culprit");
    }
  });

  it("reports a missing current rate as changed rather than as unchanged", () => {
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map(),
      recordedMethodVersion: "m@1",
      recordedTotal: "412.80",
      replayedTotal: "500.00",
    });
    if (!r.reproduced) expect(r.changedBases[0]!.now).toBe("(no current rate)");
  });

  it("calls it UNEXPLAINED when nothing about the inputs accounts for it", () => {
    const r = explainHistoricalDifference({
      reconstructed: complete,
      currentRates: new Map([["steel", rate({ rateId: "s1", amount: "2.00" })]]),
      recordedMethodVersion: "m@1",
      recordedTotal: "412.80",
      replayedTotal: "500.00",
    });
    if (!r.reproduced) {
      expect(r.cause).toBe("UNEXPLAINED");
      expect(r.note).toContain("a real defect");
    }
  });
});
