// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  classifyChange,
  createEvolutionControl,
  createMissionControl,
  foundryHasProductionDeploymentAuthority,
  objectiveMet,
} from "@proworks-hub/foundry-evolutioniq";
import { repairCandidateSchema } from "@proworks-hub/repair-learning";
import { HIVE_MAP } from "@proworks-hub/contracts";
import { chamberCreatesAuthority, chambersAreSovereignEngines } from "@proworks-hub/prime";

// ─────────────────────────────────────────────────────────────────────────────
// MIS-PRIME-P1 — the governed record for the Nexus / Pulse split.
//
// Through the real Foundry machinery, like the three missions before it. The
// change moves SYNCHRONOUS_ONLY into contracts so Prime can enforce it without
// importing Foundry, which touches a contract — so the classifier's answer here
// is not the same as MIS-SCALE-QD's, and it is asked rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T19:00:00.000Z");

const objective = {
  statement:
    "Establish Prime as one constitutional engine composed of a Nexus command chamber and a Pulse continuity chamber, neither sovereign and neither able to create authority.",
  derivedFrom: "Prime Phase 1",
  successCriteria: [
    "one Prime composes exactly one Nexus and one Pulse",
    "neither chamber is registered as a sovereign engine",
    "neither chamber can create authority",
    "an execution must name a tenant or declare itself system-scoped",
    "all eight synchronous-only operations are refused as asynchronous steps",
    "an unevaluated dependency blocks rather than proceeds",
    "recovery is refused under a changed authorization",
    "overlapping recovery of one execution is refused",
    "in-memory continuity reports itself non-durable",
    "WorkOrderIQ business logic stays outside Prime",
  ],
};

const scope = {
  components: ["hive.prime.prime", "hive.platform.contracts"],
  repository: "proworks-engine-suite",
  environment: "VALIDATION" as const,
  maxFiles: 10,
  maxComponents: 2,
  maxDurationMs: 7_200_000,
};

const candidate = repairCandidateSchema.parse({
  repairCandidateId: "rc_prime_phase1_chambers",
  diagnosisId: "PRIME-P1",
  repairClass: "OWNERSHIP_BOUNDARY",
  description:
    "Split Prime into Nexus and Pulse chambers with an explicit execution context, a continuity port that reports its durability, and enforcement of the eight synchronous-only operations.",
  targetComponents: ["hive.prime.prime", "hive.platform.contracts"],
  affectedResources: [
    "contracts/src/synchronousOnly.ts",
    "prime/src/context.ts",
    "prime/src/nexus/nexus.ts",
    "prime/src/pulse/pulse.ts",
    "prime/src/prime.ts",
  ],
  proposedActions: [
    {
      verb: "add",
      target: "code",
      subject: "Prime Nexus and Prime Pulse chambers with a composed facade",
      rationale:
        "Prime had one undivided surface; command and continuity have different rules about authority.",
    },
    {
      verb: "migrate",
      target: "contract",
      subject: "SYNCHRONOUS_ONLY from foundry-evolutioniq to contracts",
      rationale:
        "Prime must enforce the same eight operations. The alternatives were Prime importing Foundry, or two lists that drift.",
    },
    {
      verb: "add",
      target: "tenant_check",
      subject: "scope comparison before checkpoint and before taking a recovery lease",
      rationale:
        "A checkpoint filed under the wrong scope is how one tenant's execution later resumes as another's.",
    },
  ],
  expectedEffect:
    "Prime coordinates authorized work through two chambers, neither of which can permit work or resume it under changed authority.",
  risk: "MODERATE",
  blastRadius: "ARCHITECTURE",
  reversibility: "REVERSIBLE",
  requiredAuthority: ["human.constitutional.authority"],
  requiredValidators: ["forbidden-shortcut", "sentinel"],
  rollbackPlan:
    "The chambers are additive: createPrimeEngine and the workflow runner are unchanged and every existing caller still compiles. Reverting removes the new modules and restores SYNCHRONOUS_ONLY to Foundry.",
  forbiddenShortcutsChecked: true,
  authoredBy: "human.steven",
  authoredAt: "2026-08-29T19:00:00.000Z",
});

describe("MIS-PRIME-P1 — the mission record", () => {
  const missions = createMissionControl({ now: () => AT });
  const evolution = createEvolutionControl({ now: () => AT });

  const classification = classifyChange({
    candidate,
    filesChanged: 9,
    componentsTouched: 2,
    // SYNCHRONOUS_ONLY moved into contracts. That is a contract change and the
    // classifier is meant to say so.
    contractsTouched: 1,
    testsRemoved: 0,
    dependenciesTouched: 0,
  });

  it("runs the authorized lifecycle to COMPLETED", () => {
    expect(missions.propose({ missionId: "MIS-PRIME-P1", objective, scope }).ok).toBe(true);
    expect(
      missions.authorize("MIS-PRIME-P1", "human-authorization-2026-08-29-prime-p1", "human.steven").ok,
    ).toBe(true);
    expect(missions.provision("MIS-PRIME-P1", "human.steven", "foundry").ok).toBe(true);
    expect(missions.begin("MIS-PRIME-P1", "INSPECTING", "foundry").ok).toBe(true);
    for (const phase of ["PLANNING", "MUTATING", "TESTING"] as const) {
      expect(missions.advance("MIS-PRIME-P1", phase, "foundry").ok, phase).toBe(true);
    }
    expect(missions.submitForValidation("MIS-PRIME-P1", "foundry").ok).toBe(true);
    expect(
      missions.concludeValidation(
        "MIS-PRIME-P1",
        {
          accepted: true,
          reason:
            "Chamber split enforced by 34 tests; four mutations caught; full suite green; production still refused.",
        },
        "human.steven",
      ).ok,
    ).toBe(true);
    expect(missions.get("MIS-PRIME-P1")!.state).toBe("COMPLETED");
  });

  it("meets every success criterion the objective declared", () => {
    const proved = objectiveMet(missions.get("MIS-PRIME-P1")!, objective.successCriteria);
    expect(proved.met).toBe(true);
    expect(proved.unmet).toEqual([]);
  });

  it("classifies as MATERIAL_CHANGE because it moves a contract", () => {
    // Different answer from MIS-SCALE-QD, and for a reason the classifier
    // reaches on its own: this one changes what other engines may rely on.
    expect(classification.level).toBe("MATERIAL_CHANGE");
    expect(classification.because.join()).toContain("changes what other engines may rely on");
  });

  it("is held for human authorization, and Foundry cannot release its own hold", () => {
    evolution.register({
      changeId: "chg_prime_p1",
      missionId: "MIS-PRIME-P1",
      candidateId: candidate.repairCandidateId,
      workspaceId: "ws_prime_p1",
      baseRevision: "506ef18",
      classification,
    });
    evolution.submit("chg_prime_p1", "foundry");
    evolution.recordValidation(
      "chg_prime_p1",
      { accepted: true, reason: "Full suite green; build and typecheck clean; four mutations caught." },
      "foundry",
    );

    expect(evolution.get("chg_prime_p1")!.state).toBe("AWAITING_HUMAN_AUTHORIZATION");

    // §11: Foundry authorizing its own held change is the violation the hold
    // exists to prevent.
    const selfAuthorized = evolution.authorizeMaterialChange(
      "chg_prime_p1",
      "foundry",
      "Tests pass.",
    );
    expect(selfAuthorized.authorized).toBe(false);
  });

  it("advances only to VALIDATED once a human authorizes it", () => {
    const authorized = evolution.authorizeMaterialChange(
      "chg_prime_p1",
      "human.steven",
      "Prime Phase 1 chamber split reviewed and authorized; the contract move is expressly covered by the directive.",
    );
    expect(authorized.authorized).toBe(true);
    expect(evolution.get("chg_prime_p1")!.state).toBe("VALIDATED");

    expect(evolution.promote("chg_prime_p1", "VALIDATION", "human.steven").promoted).toBe(true);
  });

  it("still refuses production, with the authorization in hand", () => {
    expect(evolution.promote("chg_prime_p1", "STAGING", "human.steven").promoted).toBe(false);
    expect(evolution.promote("chg_prime_p1", "PRODUCTION", "human.steven").promoted).toBe(false);
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });

  it("leaves exactly one Prime in the Hive map", () => {
    // The most likely way this design decays is somebody registering a chamber
    // to make it addressable. Then they are peers, and peers in this
    // architecture talk over a bus — which would put Prime's own sequencing,
    // and "Nexus asks Pulse", onto asynchronous transport.
    const primes = HIVE_MAP.filter((c) => c.tier === "prime");
    expect(primes).toHaveLength(1);
    expect(primes[0]!.id).toBe("prime");

    const ids = HIVE_MAP.map((c) => c.id);
    expect(ids).not.toContain("nexus");
    expect(ids).not.toContain("pulse");
    expect(ids).not.toContain("prime-nexus");
    expect(ids).not.toContain("prime-pulse");

    expect(chambersAreSovereignEngines()).toBe(false);
    expect(chamberCreatesAuthority()).toBe(false);
  });
});
