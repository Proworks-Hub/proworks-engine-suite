// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  BASELINE_VALIDATORS,
  VETO_DIMENSIONS,
  agentLeaseSchema,
  repairCandidateSchema,
  scoreRepair,
  selectRepair,
  V1_DEFAULT_ACTIONS,
  validate,
  type AgentLease,
  type ChangeSet,
  type RepairCandidate,
  type ValidationContext,
  type Validator,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase D — Validate.
//
// §20: "A repair that fixes the bug but fails constitutional integrity must be
// rejected regardless of aggregate score."
// ─────────────────────────────────────────────────────────────────────────────

const lease = (): AgentLease =>
  agentLeaseSchema.parse({
    agentId: "agent_1",
    agentType: "REPAIR_BOT",
    mission: "Restore idempotent work-order intake.",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    targetEnvironment: "SIMULATION",
    allowedActions: V1_DEFAULT_ACTIONS,
    prohibitedActions: [],
    toolScope: [],
    dataScope: [],
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    maxChangeScope: { maxFiles: 5, maxComponents: 1 },
    deploymentAuthority: false,
    governanceReference: "gd-1",
    sentinelSession: "sen-1",
    requiredValidators: ["forbidden-shortcut"],
    terminationConditions: ["expiry"],
  });

const candidate = (over: Record<string, unknown> = {}): RepairCandidate =>
  repairCandidateSchema.parse({
    repairCandidateId: "rc_1",
    diagnosisId: "dx_1",
    repairClass: "IDEMPOTENCY",
    description: "Make the work-order consumer idempotent on the delivery key.",
    targetComponents: ["hive.specialized.workorderiq"],
    affectedResources: ["workorderiq/src/intake.ts"],
    proposedActions: [
      { verb: "add", target: "code", subject: "intake.ts", rationale: "Check the idempotency key." },
    ],
    expectedEffect: "A duplicate delivery no longer creates a second work order.",
    risk: "LOW",
    blastRadius: "WORK_ORDER",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["foundry.repair.simulation"],
    requiredValidators: ["forbidden-shortcut", "sentinel"],
    rollbackPlan: "Revert the intake change.",
    forbiddenShortcutsChecked: true,
    authoredBy: "bot_repair_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

const changeSet = (over: Partial<ChangeSet> = {}): ChangeSet => ({
  changes: [],
  filesChanged: 1,
  componentsTouched: 1,
  linesAdded: 12,
  linesRemoved: 2,
  testsRemoved: [],
  contractsTouched: [],
  dependenciesTouched: [],
  ...over,
});

const context = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  candidate: candidate(),
  changeSet: changeSet(),
  lease: lease(),
  scenarioForbiddenActions: [],
  replay: { originalScenarioNowPasses: true, relatedScenariosRun: 4, relatedScenariosFailed: 0 },
  regression: { testsRun: 1900, testsFailed: 0, newFailures: [] },
  contracts: { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 3 },
  ...over,
});

describe("the author cannot be the only validator", () => {
  it("refuses when every result came from the authoring agent", () => {
    // §16, and the Overwatch principle: a system shall not be the sole author,
    // approver, tester and validator of its own change.
    const selfValidator: Validator = {
      name: "forbidden-shortcut",
      veto: false,
      ownedBy: "bot_repair_1",
      validate: () => ({
        validatorName: "forbidden-shortcut",
        outcome: "PASSED",
        detail: "looks fine to me",
        evidenceIds: [],
        veto: false,
        ranBy: "bot_repair_1",
      }),
    };

    const verdict = validate(context(), [selfValidator]);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("cannot be the only validator");
  });

  it("checks independence before weighing results", () => {
    // A pipeline that evaluates first and checks independence afterwards is
    // one where somebody eventually reads the passing results and stops.
    const selfValidator: Validator = {
      name: "everything",
      veto: false,
      ownedBy: "bot_repair_1",
      validate: () => ({
        validatorName: "everything",
        outcome: "PASSED",
        detail: "all good",
        evidenceIds: [],
        veto: false,
        ranBy: "bot_repair_1",
      }),
    };
    const verdict = validate(context(), [selfValidator]);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).not.toContain("Required validator");
  });

  it("accepts an independently validated candidate", () => {
    expect(validate(context(), BASELINE_VALIDATORS).valid).toBe(true);
  });
});

describe("a veto cannot be outweighed", () => {
  it("rejects a candidate that widens authority even when everything else passes", () => {
    // The seductive failure: fixes the bug perfectly, regresses nothing, and
    // quietly widens an authority grant.
    const verdict = validate(
      context({
        candidate: candidate({
          proposedActions: [
            {
              verb: "widen",
              target: "authority_grant",
              subject: "workorderiq.write",
              rationale: "Grant the consumer the write scope it needs.",
            },
          ],
        }),
      }),
      BASELINE_VALIDATORS,
    );

    expect(verdict.valid).toBe(false);
    if (!verdict.valid) {
      expect(verdict.vetoedBy).toBe("forbidden-shortcut");
      expect(verdict.reason).toContain("regardless of any other score");
    }
  });

  it("rejects a candidate that deletes the failing test", () => {
    const verdict = validate(
      context({ changeSet: changeSet({ testsRemoved: ["intake.test.ts"] }) }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.vetoedBy).toBe("sentinel");
  });

  it("lets Sentinel object to a dependency change as a supply-chain surface", () => {
    const verdict = validate(
      context({ changeSet: changeSet({ dependenciesTouched: ["package.json"] }) }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("supply-chain surface");
  });

  it("vetoes a breaking contract change", () => {
    const verdict = validate(
      context({
        contracts: { breakingChanges: ["removed field orderId"], deprecatedFieldsUsed: [], consumersChecked: 3 },
      }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.vetoedBy).toBe("contract-compatibility");
  });

  it("vetoes a repair that fixes a bug by coupling to a vendor", () => {
    const verdict = validate(
      context({
        candidate: candidate({
          description: "Switch the queue to Kafka so the duplicate cannot occur.",
        }),
        changeSet: changeSet({ dependenciesTouched: ["package.json"], testsRemoved: [] }),
      }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
  });
});

describe("a validator that could not run has not passed", () => {
  it("treats an absent contract analysis as NOT_RUN, not compatible", () => {
    // A consumer can break on behaviour that no schema file records.
    const verdict = validate(context({ contracts: undefined }), BASELINE_VALIDATORS);
    expect(verdict.notRun).toContain("contract-compatibility");
  });

  it("refuses when a required validator did not run", () => {
    const verdict = validate(
      context({ candidate: candidate({ requiredValidators: ["scenario-replay"] }), replay: undefined }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("not one that passed");
  });

  it("fails a replay where the original scenario still fails", () => {
    const verdict = validate(
      context({
        replay: { originalScenarioNowPasses: false, relatedScenariosRun: 4, relatedScenariosFailed: 0 },
      }),
      BASELINE_VALIDATORS,
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("scenario-replay");
  });

  it("fails a fix that breaks its neighbours", () => {
    const results = validate(
      context({
        replay: { originalScenarioNowPasses: true, relatedScenariosRun: 4, relatedScenariosFailed: 2 },
      }),
      BASELINE_VALIDATORS,
    ).results;
    const replay = results.find((r) => r.validatorName === "scenario-replay")!;
    expect(replay.outcome).toBe("FAILED");
    expect(replay.detail).toContain("has moved the problem");
  });
});

describe("scoring keeps every dimension inspectable", () => {
  const scored = (over: Partial<ValidationContext> = {}) => {
    const ctx = context(over);
    return scoreRepair({
      candidate: ctx.candidate,
      changeSet: ctx.changeSet,
      verdict: validate(ctx, BASELINE_VALIDATORS),
      diagnosticConfidence: "confirmed",
    });
  };

  it("stores each dimension separately", () => {
    // §20: "Do not use one opaque AI score."
    const fitness = scored().fitness;
    expect(Object.keys(fitness).length).toBeGreaterThanOrEqual(13);
    expect(fitness.faultFixed).toBe(1);
    expect(fitness.constitutionalIntegrity).toBe(1);
  });

  it("reports an unmeasured dimension as null, never as 0 or 1", () => {
    // Zero reads as "measured and terrible"; one reads as "measured and
    // perfect". Both are lies about a measurement that did not happen.
    const s = scored({ regression: undefined });
    expect(s.fitness.regressions).toBeNull();
    expect(s.unmeasured).toContain("regressions");
  });

  it("leaves blast radius unscored", () => {
    // Sixteen heterogeneous values with no honest ordering between a financial
    // blast radius and an architectural one. Stored on the candidate, shown to
    // a human, and not a number in an average.
    expect(scored().fitness.blastRadius).toBeNull();
  });

  it("excludes unmeasured dimensions from the aggregate rather than counting them", () => {
    const withAll = scored();
    const withFewer = scored({ regression: undefined, contracts: undefined });
    expect(withAll.advisoryAggregate).not.toBeNull();
    expect(withFewer.advisoryAggregate).not.toBeNull();
  });

  it("names the aggregate advisory", () => {
    // Ranking needs a number. Admissibility does not come from one.
    expect(Object.keys(scored())).toContain("advisoryAggregate");
    expect(Object.keys(scored())).toContain("admissible");
  });

  it("makes an unmeasured veto dimension inadmissible", () => {
    // "We did not check whether this widens authority" is not a reason to
    // proceed. Treating unmeasured as acceptable is how the unchecked path
    // becomes the default path.
    const s = scored({ contracts: undefined });
    expect(s.fitness.contractCompatibility).toBeNull();
    expect(s.admissible).toBe(false);
    expect(s.inadmissibleBecause.join()).toContain("not a passing one");
  });

  it("keeps the veto dimension list explicit", () => {
    expect(VETO_DIMENSIONS).toContain("constitutionalIntegrity");
    expect(VETO_DIMENSIONS).toContain("tenantIsolation");
    expect(VETO_DIMENSIONS).not.toContain("performance");
  });

  it("is inadmissible when it fixes the bug but fails constitutionally", () => {
    // §20's sentence, exactly.
    const ctx = context({
      candidate: candidate({
        proposedActions: [
          { verb: "remove", target: "tenant_check", subject: "guard", rationale: "simplify" },
        ],
      }),
    });
    const s = scoreRepair({
      candidate: ctx.candidate,
      changeSet: ctx.changeSet,
      verdict: validate(ctx, BASELINE_VALIDATORS),
    });

    expect(s.fitness.faultFixed).toBe(1);
    expect(s.fitness.constitutionalIntegrity).toBe(0);
    expect(s.admissible).toBe(false);
  });
});

describe("selection filters before it ranks", () => {
  const scoreOf = (c: RepairCandidate, over: Partial<ValidationContext> = {}) => {
    const ctx = context({ candidate: c, ...over });
    return {
      candidate: c,
      score: scoreRepair({
        candidate: c,
        changeSet: ctx.changeSet,
        verdict: validate(ctx, BASELINE_VALIDATORS),
        diagnosticConfidence: "confirmed",
      }),
    };
  };

  it("never selects an inadmissible candidate, however well it scores", () => {
    const cheating = candidate({
      repairCandidateId: "rc_cheat",
      proposedActions: [
        { verb: "disable", target: "governance", subject: "hook", rationale: "unblock the flow" },
      ],
    });
    const selection = selectRepair([scoreOf(cheating)]);
    expect(selection.selected).toBeNull();
    if (selection.selected === null) {
      expect(selection.reason).toContain("Producing no repair is a valid outcome");
    }
  });

  it("prefers the reversible repair over the irreversible one", () => {
    const reversible = candidate({ repairCandidateId: "rc_rev", reversibility: "REVERSIBLE" });
    const containFirst = candidate({ repairCandidateId: "rc_contain", reversibility: "CONTAIN_FIRST" });
    const selection = selectRepair([scoreOf(containFirst), scoreOf(reversible)]);
    expect(selection.selected?.repairCandidateId).toBe("rc_rev");
  });

  it("prefers lower risk when reversibility ties", () => {
    const low = candidate({ repairCandidateId: "rc_low", risk: "LOW" });
    const high = candidate({
      repairCandidateId: "rc_high",
      risk: "HIGH",
      requiredValidators: ["forbidden-shortcut", "sentinel"],
    });
    const selection = selectRepair([scoreOf(high), scoreOf(low)]);
    expect(selection.selected?.repairCandidateId).toBe("rc_low");
  });

  it("does not optimize solely for the fix working", () => {
    // §21. A candidate that fixes the bug but is irreversible loses to a
    // reversible one, even though both fix it.
    const irreversibleFix = candidate({
      repairCandidateId: "rc_irreversible",
      reversibility: "NOT_APPLICABLE",
    });
    const reversibleFix = candidate({ repairCandidateId: "rc_reversible", reversibility: "REVERSIBLE" });
    const selection = selectRepair([scoreOf(irreversibleFix), scoreOf(reversibleFix)]);
    expect(selection.selected?.repairCandidateId).toBe("rc_reversible");
  });

  it("explains every rejection", () => {
    const cheating = candidate({
      repairCandidateId: "rc_cheat",
      proposedActions: [{ verb: "remove", target: "test", subject: "t", rationale: "r" }],
    });
    const honest = candidate({ repairCandidateId: "rc_honest" });
    const selection = selectRepair([scoreOf(cheating), scoreOf(honest)]);
    expect(selection.selected?.repairCandidateId).toBe("rc_honest");
    expect(selection.rejected.find((r) => r.id === "rc_cheat")?.because).toBeTruthy();
  });
});
