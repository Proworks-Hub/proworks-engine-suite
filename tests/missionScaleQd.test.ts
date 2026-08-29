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
  type MissionTransition,
} from "@proworks-hub/foundry-evolutioniq";
import { repairCandidateSchema } from "@proworks-hub/repair-learning";

// ─────────────────────────────────────────────────────────────────────────────
// MIS-SCALE-QD — the governed record for the deterministic queue-depth gate.
//
// Run through the real Foundry machinery, like MIS-E2E03 and MIS-MC12 before
// it: the same state machine, the same classifier, the same wall. A mission
// record typed into a document proves nothing about the system meant to govern
// missions.
//
// The change is an OBSERVATION seam. It adds a counter to the in-memory job
// queue and replaces a wall-clock assertion with integer work counts. It grants
// nothing, changes no queue behaviour, and touches no contract — and the
// classifier is asked rather than told.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T17:00:00.000Z");

const objective = {
  statement:
    "Replace the wall-clock queue-depth gate with deterministic measurement of the work claim() performs, without changing queue behaviour.",
  derivedFrom: "MIS-SCALE-QD",
  successCriteria: [
    "the queue-depth gate no longer decides pass or fail on elapsed time",
    "claim work is counted as integers produced by the algorithm",
    "zero measurement fails rather than passing",
    "a constant-factor regression is caught",
    "a super-linear regression is caught",
    "queue behaviour is identical with and without the observer",
    "the observer receives no job payload, tenant or trace material",
  ],
};

const scope = {
  components: ["hive.platform.platform-runtime"],
  repository: "proworks-engine-suite",
  environment: "VALIDATION" as const,
  maxFiles: 5,
  maxComponents: 1,
  maxDurationMs: 7_200_000,
};

/** The change as it was actually made. */
const candidate = repairCandidateSchema.parse({
  repairCandidateId: "rc_scale_qd_observation",
  diagnosisId: "MIS-SCALE-QD",
  repairClass: "PERFORMANCE",
  description:
    "Add an optional counting observer to createInMemoryJobQueue's claim path, and replace the wall-clock queue-depth assertion with deterministic work counts.",
  targetComponents: ["hive.platform.platform-runtime"],
  affectedResources: [
    "platform-runtime/src/inMemoryJobQueue.ts",
    "platform-runtime/src/__tests__/runtime.test.ts",
    "tests/scale/scale.test.ts",
  ],
  proposedActions: [
    {
      verb: "add",
      target: "code",
      subject: "observeClaimWork counter on the claim path",
      rationale:
        "The queue had no seam to count traversal through, which is why the gate was timing instead of counting.",
    },
    {
      verb: "replace",
      target: "test",
      subject: "the wall-clock queue-depth ratio",
      rationale:
        "It was flaky AND measuring the enqueue loop rather than the claim it was named for.",
    },
    {
      verb: "add",
      target: "test",
      subject: "zero-measurement, mutation and behavioural-equivalence tests",
      rationale: "Prove the gate discriminates rather than asserting that it does.",
    },
  ],
  expectedEffect:
    "The queue-depth gate fails on a real complexity regression and cannot be moved by machine speed.",
  risk: "LOW",
  blastRadius: "ENGINE",
  reversibility: "REVERSIBLE",
  requiredAuthority: ["human.constitutional.authority"],
  requiredValidators: ["forbidden-shortcut", "sentinel"],
  rollbackPlan:
    "Remove the optional option and restore the previous assertion. The seam is optional and absent from every production path, so reverting requires no caller change.",
  forbiddenShortcutsChecked: true,
  authoredBy: "human.steven",
  authoredAt: "2026-08-29T17:00:00.000Z",
});

describe("MIS-SCALE-QD — the mission record", () => {
  const transitions: MissionTransition[] = [];
  const missions = createMissionControl({
    now: () => AT,
    onTransition: (_m, t) => transitions.push(t),
  });
  const evolution = createEvolutionControl({ now: () => AT });

  const classification = classifyChange({
    candidate,
    filesChanged: 4,
    componentsTouched: 1,
    // The seam lives in InMemoryJobQueueOptions, which is the implementation's
    // own construction options — NOT the JobQueue port in contracts. Deliberate:
    // putting it on the port would oblige every future queue to carry an
    // observation surface it may have no way to honour.
    contractsTouched: 0,
    testsRemoved: 0,
    dependenciesTouched: 0,
  });

  it("runs the authorized lifecycle to COMPLETED", () => {
    expect(missions.propose({ missionId: "MIS-SCALE-QD", objective, scope }).ok).toBe(true);

    // Authorized by a human before any code was written. Foundry cannot
    // authorize its own mission (Charter §11).
    expect(
      missions.authorize("MIS-SCALE-QD", "human-authorization-2026-08-29-scale-qd", "human.steven")
        .ok,
    ).toBe(true);
    expect(missions.provision("MIS-SCALE-QD", "human.steven", "foundry").ok).toBe(true);

    expect(missions.begin("MIS-SCALE-QD", "INSPECTING", "foundry").ok).toBe(true);
    for (const phase of ["PLANNING", "MUTATING", "TESTING"] as const) {
      expect(missions.advance("MIS-SCALE-QD", phase, "foundry").ok, phase).toBe(true);
    }

    expect(missions.submitForValidation("MIS-SCALE-QD", "foundry").ok).toBe(true);
    expect(
      missions.concludeValidation(
        "MIS-SCALE-QD",
        {
          accepted: true,
          reason:
            "Claim work measured at exactly 2.000 units per queued job across four depths; both mutations caught; queue behaviour identical with and without the observer.",
        },
        "human.steven",
      ).ok,
    ).toBe(true);

    expect(missions.get("MIS-SCALE-QD")!.state).toBe("COMPLETED");
  });

  it("meets every success criterion the objective declared", () => {
    const mission = missions.get("MIS-SCALE-QD")!;
    const proved = objectiveMet(mission, objective.successCriteria);
    expect(proved.met).toBe(true);
    expect(proved.unmet).toEqual([]);
  });

  it("records what the classifier actually said", () => {
    // Asked, not assumed. One component, no contract, no dependency, no test
    // removed, LOW risk and reversible — so this is NOT material, and recording
    // that honestly matters more than reaching for the stricter-sounding label.
    //
    // The mission was authorized by a human anyway. Authorization above the
    // classification is always available; the reverse is what the hold exists
    // to prevent.
    expect(classification.level).toBe("AUTONOMOUS_REPAIR");
    expect(classification.because.join()).toContain("touches no contract or protection");
  });

  it("would have been held for a human if it had touched the JobQueue contract", () => {
    // The counterfactual, so the classification above is shown to be a verdict
    // rather than a default. Putting the seam on the port instead of the
    // implementation's options changes the answer.
    const onThePort = classifyChange({
      candidate,
      filesChanged: 4,
      componentsTouched: 1,
      contractsTouched: 1,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });
    expect(onThePort.level).toBe("MATERIAL_CHANGE");
    expect(onThePort.because.join()).toContain("changes what other engines may rely on");
  });

  it("promotes only as far as the machinery allows", () => {
    evolution.register({
      changeId: "chg_scale_qd",
      missionId: "MIS-SCALE-QD",
      candidateId: candidate.repairCandidateId,
      workspaceId: "ws_scale_qd",
      baseRevision: "084ad77",
      classification,
    });
    evolution.submit("chg_scale_qd", "foundry");
    evolution.recordValidation(
      "chg_scale_qd",
      {
        accepted: true,
        reason:
          "Full suite green; build and typecheck clean; queue equivalence proven; both regression mutations caught.",
      },
      "foundry",
    );

    // Promotion happens once: it moves the change to PROMOTED, so a second
    // call is refused for a STATE reason rather than by the wall. Worth keeping
    // the two refusals distinguishable — they mean different things.
    expect(evolution.promote("chg_scale_qd", "VALIDATION", "foundry").promoted).toBe(true);

    const again = evolution.promote("chg_scale_qd", "SIMULATION", "foundry");
    expect(again.promoted).toBe(false);
    if (!again.promoted) {
      expect(again.reason).toContain("PROMOTED");
      // Not a wall refusal: SIMULATION is promotable, this change is simply
      // already promoted.
      expect(again.requiresAuthority).toBeNull();
    }
  });

  it("still refuses production", () => {
    // The wall, unchanged. Nothing in this mission acquired deployment
    // authority and nothing tried to.
    const staging = evolution.promote("chg_scale_qd", "STAGING", "human.steven");
    const production = evolution.promote("chg_scale_qd", "PRODUCTION", "human.steven");

    expect(staging.promoted).toBe(false);
    expect(production.promoted).toBe(false);
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });

  it("did not widen what may be promoted", () => {
    // Asserted here rather than trusted, because a mission that quietly added
    // an environment would look exactly like one that did not.
    const change = evolution.get("chg_scale_qd")!;
    expect(change.promotedTo).toBe("VALIDATION");
    for (const target of ["STAGING", "PRODUCTION"] as const) {
      expect(evolution.promote("chg_scale_qd", target, "human.steven").promoted).toBe(false);
    }
  });

  it("leaves a transition record naming who did what", () => {
    expect(transitions.length).toBeGreaterThan(0);
    const authorization = transitions.find((t) => t.to === "AUTHORIZED");
    expect(authorization?.by).toBe("human.steven");

    // Phase advances are recorded as RUNNING → RUNNING with the phase named in
    // the reason, so the working phases are found by reason rather than by
    // state. Foundry drove them; the human authorized and concluded.
    const mutating = transitions.find((t) => t.reason.includes("MUTATING"));
    expect(mutating?.by).toBe("foundry");
    expect(mutating?.from).toBe("RUNNING");

    expect(transitions.find((t) => t.to === "COMPLETED")?.by).toBe("human.steven");
  });
});
