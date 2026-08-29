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
// MIS-E2E03 — the governed mission record for the idempotency change.
//
// Run through the real Foundry machinery rather than written by hand. A mission
// record that was typed into a document proves nothing about the system that
// is supposed to govern missions; this one goes through the same state machine,
// the same classifier and the same promotion wall as any other change, and
// fails if any of them disagree.
//
// The change was authorized by a human before any code was written. This
// records it, classifies it, and demonstrates that even with authorization the
// wall still refuses production.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T15:00:00.000Z");

const objective = {
  statement:
    "Close E2E-03: repeating create-work-order with one idempotency key must yield one work order and one reservation set.",
  derivedFrom: "E2E-03",
  successCriteria: [
    "repeated create with one key returns one canonical work order",
    "repeated reservation for that operation creates one reservation set",
    "concurrent duplicates create neither a second work order nor a double reserve",
    "same key with a materially different payload fails with an explicit conflict",
    "idempotency state is tenant-scoped",
    "a 4-sheet job reserves exactly 4 sheets after repeated and concurrent duplicates",
  ],
};

const scope = {
  components: ["hive.specialized.workorderiq", "hive.specialized.inventoryiq"],
  repository: "proworks-engine-suite",
  environment: "VALIDATION" as const,
  maxFiles: 8,
  maxComponents: 2,
  maxDurationMs: 7_200_000,
};

/** The change as it was actually made. */
const candidate = repairCandidateSchema.parse({
  repairCandidateId: "rc_e2e03_idempotency",
  diagnosisId: "E2E-03",
  repairClass: "IDEMPOTENCY",
  description:
    "Add a tenant-scoped idempotency claim to work-order creation and derive a deduplication identity for material reservation, enforced at the use-case boundary.",
  targetComponents: ["hive.specialized.workorderiq", "hive.specialized.inventoryiq"],
  affectedResources: [
    "workorderiq/src/core/intake/idempotency.ts",
    "workorderiq/src/core/intake/createWorkOrderUseCase.ts",
    "inventoryiq/src/reservations.ts",
  ],
  proposedActions: [
    {
      verb: "add",
      target: "idempotency_check",
      subject: "createWorkOrderUseCase intake path",
      rationale: "No idempotency key existed; two identical creates produced two work orders.",
    },
    {
      verb: "add",
      target: "idempotency_check",
      subject: "reserveMaterial dedup on (org, workOrder, material, location, quantity)",
      rationale: "Derived from the existing listByWorkOrder rather than adding a port.",
    },
    {
      verb: "add",
      target: "test",
      subject: "unit, concurrency, persistence and cross-engine tests",
      rationale: "Prove the guarantee rather than assert it.",
    },
  ],
  expectedEffect:
    "A repeated or concurrent duplicate of the same logical operation resolves to one work order holding one reservation set.",
  risk: "MODERATE",
  blastRadius: "WORK_ORDER",
  reversibility: "REVERSIBLE",
  requiredAuthority: ["human.constitutional.authority"],
  requiredValidators: ["forbidden-shortcut", "sentinel"],
  rollbackPlan:
    "Revert both engines. The idempotency parameter is optional, so reverting restores prior behaviour with no caller changes; work orders created under a key remain valid.",
  forbiddenShortcutsChecked: true,
  authoredBy: "human.steven",
  authoredAt: "2026-08-29T15:00:00.000Z",
});

describe("MIS-E2E03 — the mission record", () => {
  const transitions: MissionTransition[] = [];
  const missions = createMissionControl({
    now: () => AT,
    onTransition: (_m, t) => transitions.push(t),
  });
  const evolution = createEvolutionControl({ now: () => AT });

  it("runs the authorized lifecycle to COMPLETED", () => {
    expect(missions.propose({ missionId: "MIS-E2E03", objective, scope }).ok).toBe(true);

    // Authorized by a human before any code was written. Foundry cannot
    // authorize its own mission (Charter §11), so the reference is the
    // authorization itself.
    expect(missions.authorize("MIS-E2E03", "human-authorization-2026-08-29", "human.steven").ok).toBe(true);
    expect(missions.provision("MIS-E2E03", "human.steven", "foundry").ok).toBe(true);

    expect(missions.begin("MIS-E2E03", "DIAGNOSING", "foundry").ok).toBe(true);
    for (const phase of ["PLANNING", "MUTATING", "TESTING"] as const) {
      expect(missions.advance("MIS-E2E03", phase, "foundry").ok, phase).toBe(true);
    }

    expect(missions.submitForValidation("MIS-E2E03", "foundry").ok).toBe(true);
    expect(
      missions.concludeValidation(
        "MIS-E2E03",
        { accepted: true, reason: "Full suite green; E2E-03 passes; no invariant weakened." },
        "human.steven",
      ).ok,
    ).toBe(true);

    expect(missions.get("MIS-E2E03")!.state).toBe("COMPLETED");
  });

  it("meets every success criterion the objective declared", () => {
    // Each of these is proved by a test elsewhere in this suite. Listing them
    // here is what makes the mission's own claim checkable rather than a
    // summary somebody wrote afterwards.
    const mission = missions.get("MIS-E2E03")!;
    const proved = objectiveMet(mission, objective.successCriteria);
    expect(proved.met).toBe(true);
    expect(proved.unmet).toEqual([]);
  });

  it("classifies as a MATERIAL_CHANGE and says why", () => {
    // Two components, and it alters work-order creation semantics. The
    // classifier reaches that verdict on its own rather than being told.
    const classification = classifyChange({
      candidate,
      filesChanged: 5,
      componentsTouched: 2,
      contractsTouched: 0,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });

    expect(classification.level).toBe("MATERIAL_CHANGE");
    expect(classification.because.join()).toContain("spans 2 components");
  });

  it("is held for human authorization even though every test passes", () => {
    // §22, and the reason this mission needed authorizing before the work
    // began rather than after it succeeded.
    evolution.register({
      changeId: "chg_e2e03",
      missionId: "MIS-E2E03",
      candidateId: candidate.repairCandidateId,
      workspaceId: "ws_e2e03",
      baseRevision: "7de2374",
      classification: classifyChange({
        candidate,
        filesChanged: 5,
        componentsTouched: 2,
        contractsTouched: 0,
        testsRemoved: 0,
        dependenciesTouched: 0,
      }),
    });
    evolution.submit("chg_e2e03", "foundry");
    evolution.recordValidation(
      "chg_e2e03",
      { accepted: true, reason: "2,348 tests pass; build, typecheck, dependency law and charter validation clean." },
      "foundry",
    );

    const change = evolution.get("chg_e2e03")!;
    expect(change.state).toBe("AWAITING_HUMAN_AUTHORIZATION");
    expect(change.history.at(-1)!.reason).toContain("not deployed merely because tests pass");
  });

  it("still refuses production, with the authorization in hand", () => {
    // The authorization covered the CHANGE. It did not grant deployment
    // authority, and nothing in this mission acquired any.
    const verdict = evolution.promote("chg_e2e03", "PRODUCTION", "human.steven");
    expect(verdict.promoted).toBe(false);
    if (!verdict.promoted) {
      // The production wall answers FIRST — before the change's state, before
      // its classification. I expected the human-authorization reason here and
      // got the wall's, which is the stronger fact: it refuses unconditionally
      // rather than because this particular change is still held.
      expect(verdict.reason).toContain("does not promote to PRODUCTION");
      expect(verdict.reason).toContain("no flag, parameter or authority class");
      expect(verdict.requiresAuthority).toContain("does not exist yet");
    }

    // And a sandbox promotion is still held, for the separate reason that this
    // is a material change.
    const sandbox = evolution.promote("chg_e2e03", "VALIDATION", "human.steven");
    expect(sandbox.promoted).toBe(false);
    if (!sandbox.promoted) {
      expect(sandbox.requiresAuthority).toContain("Human constitutional authority");
    }

    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });

  it("records every transition with who and why", () => {
    // Charter §16: material actions identify what changed and the authority
    // permitting it.
    expect(transitions.length).toBeGreaterThanOrEqual(7);
    const authorization = transitions.find((t) => t.to === "AUTHORIZED")!;
    expect(authorization.by).toBe("human.steven");
    expect(authorization.reason).toContain("human-authorization-2026-08-29");
  });

  it("proposed no forbidden action", () => {
    // Every action is an `add`. Nothing was disabled, removed, or widened —
    // which is what "do not weaken invariants, authorization, tenant isolation
    // or auditability" looks like when checked rather than promised.
    for (const action of candidate.proposedActions) {
      expect(action.verb, `${action.verb} ${action.target}`).toBe("add");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIS-MC12 — the cross-tenant retrieval gate.
//
// Found by MC-12 in the multi-company library. Same shape as the two before it:
// a field declared, stored and never read.
// ─────────────────────────────────────────────────────────────────────────────

describe("MIS-MC12 — the mission record", () => {
  const missions = createMissionControl({ now: () => AT });
  const evolution = createEvolutionControl({ now: () => AT });

  const objectiveMc12 = {
    statement:
      "Close MC-12: cross-tenant knowledge retrieval must not return another tenant's raw RepairCase.",
    derivedFrom: "MC-12",
    successCriteria: [
      "a foreign tenant receives no prior case",
      "the reading tenant still receives its own by exact signature",
      "crossTenantLearningApproved is read rather than merely stored",
    ],
  };

  const candidateMc12 = repairCandidateSchema.parse({
    repairCandidateId: "rc_mc12_tenant_gate",
    diagnosisId: "MC-12",
    repairClass: "TENANT_ISOLATION",
    description:
      "Make readingTenant required on similarTo and findReusableKnowledge, and filter by tenant before scoring.",
    targetComponents: ["hive.constitutional.foundry.repair-learning"],
    affectedResources: [
      "repair-learning/src/knowledge/experience.ts",
      "repair-learning/src/knowledge/patterns.ts",
    ],
    proposedActions: [
      {
        verb: "add",
        target: "tenant_check",
        subject: "ExperienceStore.similarTo",
        rationale:
          "Retrieval had no tenant parameter at all; similarity weights tenantScope at 0.05 so a foreign case matched at ~0.95.",
      },
      {
        verb: "add",
        target: "tenant_check",
        subject: "findReusableKnowledge",
        rationale: "The reuse loop returned bestPriorCase, which is the whole RepairCase.",
      },
      {
        verb: "add",
        target: "test",
        subject: "five gate tests plus MC-12 as the acceptance test",
        rationale: "Prove the gate and prove it did not break legitimate same-tenant reuse.",
      },
    ],
    expectedEffect:
      "A tenant retrieves its own cases and any case Governance approved for cross-tenant learning, and nothing else.",
    risk: "MODERATE",
    blastRadius: "TENANT",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["human.constitutional.authority"],
    requiredValidators: ["forbidden-shortcut", "sentinel"],
    rollbackPlan:
      "Revert both files. Doing so restores the leak, so a rollback needs its own decision rather than being a safe undo.",
    forbiddenShortcutsChecked: true,
    authoredBy: "human.steven",
    authoredAt: "2026-08-29T15:00:00.000Z",
  });

  it("runs the authorized lifecycle to COMPLETED", () => {
    expect(
      missions.propose({
        missionId: "MIS-MC12",
        objective: objectiveMc12,
        scope: {
          components: ["hive.constitutional.foundry.repair-learning"],
          repository: "proworks-engine-suite",
          environment: "VALIDATION",
          maxFiles: 4,
          maxComponents: 1,
          maxDurationMs: 3_600_000,
        },
      }).ok,
    ).toBe(true);

    expect(missions.authorize("MIS-MC12", "human-authorization-2026-08-29", "human.steven").ok).toBe(true);
    expect(missions.provision("MIS-MC12", "human.steven", "foundry").ok).toBe(true);
    expect(missions.begin("MIS-MC12", "MUTATING", "foundry").ok).toBe(true);
    expect(missions.submitForValidation("MIS-MC12", "foundry").ok).toBe(true);
    expect(
      missions.concludeValidation(
        "MIS-MC12",
        { accepted: true, reason: "MC-12 passes; 24/24 multi-company; full suite green." },
        "human.steven",
      ).ok,
    ).toBe(true);

    expect(missions.get("MIS-MC12")!.state).toBe("COMPLETED");
    expect(objectiveMet(missions.get("MIS-MC12")!, objectiveMc12.successCriteria).met).toBe(true);
  });

  it("classifies as MATERIAL_CHANGE — it touches a tenant boundary", () => {
    const classification = classifyChange({
      candidate: candidateMc12,
      filesChanged: 4,
      componentsTouched: 1,
      contractsTouched: 0,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });
    expect(classification.level).toBe("MATERIAL_CHANGE");
    expect(classification.because.join()).toContain("tenant boundary");
  });

  it("proposed no forbidden action", () => {
    for (const action of candidateMc12.proposedActions) {
      expect(action.verb, `${action.verb} ${action.target}`).toBe("add");
    }
  });

  it("is held, and production is still refused", () => {
    evolution.register({
      changeId: "chg_mc12",
      missionId: "MIS-MC12",
      candidateId: candidateMc12.repairCandidateId,
      workspaceId: "ws_mc12",
      baseRevision: "0041625",
      classification: classifyChange({
        candidate: candidateMc12,
        filesChanged: 4,
        componentsTouched: 1,
        contractsTouched: 0,
        testsRemoved: 0,
        dependenciesTouched: 0,
      }),
    });
    evolution.submit("chg_mc12", "foundry");
    evolution.recordValidation("chg_mc12", { accepted: true, reason: "green" }, "foundry");

    expect(evolution.get("chg_mc12")!.state).toBe("AWAITING_HUMAN_AUTHORIZATION");
    expect(evolution.promote("chg_mc12", "PRODUCTION", "human.steven").promoted).toBe(false);
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });
});
