// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createEventIq, type EventAuthority } from "@proworks-hub/eventiq";
import { repairBotLease, repairCandidateSchema, type AgentLease, type DriftFinding } from "@proworks-hub/repair-learning";

import {
  FOUNDRY_EVENT_TYPES,
  SYNCHRONOUS_ONLY,
  createAgentRuntime,
  createEvolutionControl,
  createFoundryEventPublisher,
  createMissionControl,
  foundryEventSeams,
  mayBePerformedAsynchronously,
  type FoundryEventContext,
  type WorkspaceContainment,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Foundry events on EventIQ, with direct contracts retained for synchronous
// operations.
// ─────────────────────────────────────────────────────────────────────────────

const at = () => new Date("2026-08-29T10:00:00.000Z");

const permits: EventAuthority = {
  mayPublish: () => ({ permitted: true, reason: "ok", decisionId: "gd-pub" }),
  mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd-replay" }),
};

const context: FoundryEventContext = {
  tenant: { organizationId: "ksix", roles: [] },
  correlationId: "cor-1",
  executionId: "exec-1",
  governanceDecisionId: "gd-4471",
};

const objective = {
  statement: "Make the consumer idempotent.",
  derivedFrom: "dx_1",
  successCriteria: ["one work order per delivery"],
};

const scope = {
  components: ["hive.specialized.workorderiq"],
  repository: "proworks-engine-suite",
  environment: "SIMULATION" as const,
  maxFiles: 5,
  maxComponents: 1,
  maxDurationMs: 3_600_000,
};

const lease = (): AgentLease =>
  repairBotLease({
    agentId: "bot_1",
    mission: "m",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    governanceReference: "gd-1",
    sentinelSession: "sen-1",
  });

const candidate = () =>
  repairCandidateSchema.parse({
    repairCandidateId: "rc_1",
    diagnosisId: "dx_1",
    repairClass: "IDEMPOTENCY",
    description: "Key on the delivery identifier.",
    targetComponents: ["hive.specialized.workorderiq"],
    affectedResources: ["intake.ts"],
    proposedActions: [{ verb: "add", target: "code", subject: "intake.ts", rationale: "check the key" }],
    expectedEffect: "No second work order.",
    risk: "LOW",
    blastRadius: "WORK_ORDER",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["foundry.repair.simulation"],
    requiredValidators: ["forbidden-shortcut"],
    rollbackPlan: "Revert.",
    forbiddenShortcutsChecked: true,
    authoredBy: "bot_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
  });

const containment: WorkspaceContainment = {
  async freeze() {},
  workspacesOf: () => [],
};

/** EventIQ with a subscription already listening, so events are pollable. */
const wired = () => {
  const eventiq = createEventIq({ authority: permits, now: at });
  eventiq.subscribe({
    subscriptionId: "sub_all",
    consumerGroup: "grp_observer",
    consumerId: "hive.control-plane",
    messageTypes: ["*"],
    tenant: "ksix",
    systemScoped: false,
    expectation: { guarantee: "at-least-once", maxAttempts: 3 },
    idempotent: true,
    createdAt: "2026-08-29T09:00:00.000Z",
  });
  const publisher = createFoundryEventPublisher({ eventiq, now: at });
  return { eventiq, publisher };
};

describe("what travels as an event, and what never does", () => {
  it("keeps every decision a caller acts on out of the bus", () => {
    // A `promote()` that published "may I promote?" and continued would be a
    // promotion that happened before anybody said yes. EventIQ's own doctrine:
    // events say what happened, not what is authorized next.
    for (const operation of SYNCHRONOUS_ONLY) {
      expect(mayBePerformedAsynchronously(operation), operation).toBe(false);
    }
  });

  it("names containment, authorization and validation among them", () => {
    for (const operation of ["leasePermits", "supervise", "validate", "promote", "authorize"]) {
      expect(SYNCHRONOUS_ONLY as readonly string[], operation).toContain(operation);
    }
  });

  it("lets an ordinary notification travel asynchronously", () => {
    expect(mayBePerformedAsynchronously("missionStateChanged")).toBe(true);
  });

  it("publishes only past-tense event types", () => {
    // Foundry reports what happened; it does not instruct.
    for (const type of FOUNDRY_EVENT_TYPES) {
      expect(type.startsWith("foundry."), type).toBe(true);
      expect(/\.(proposed|authorized|state_changed|completed|failed|spawned|terminated|authored|validated|rejected|promoted|promotion_refused|detected)$/.test(type), type).toBe(true);
    }
  });
});

describe("events reach a subscriber through EventIQ", () => {
  it("publishes a mission transition as an EVENT, not a COMMAND", () => {
    // An EVENT needs no `producedUnderAuthority`, which is correct: reporting a
    // fact requires no authority over the recipient.
    const { eventiq, publisher } = wired();
    const missions = createMissionControl({ now: at, ...foundryEventSeams(publisher, context).missionControl });

    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "governance");

    const polled = eventiq.poll("sub_all");
    expect(polled).toHaveLength(1);
    expect(polled[0]!.message.category).toBe("EVENT");
    expect(polled[0]!.message.messageType).toBe("foundry.mission.state_changed");
    expect(polled[0]!.message.producedUnderAuthority).toBeUndefined();
  });

  it("publishes an agent termination with its containment facts", () => {
    const { eventiq, publisher } = wired();
    const seams = foundryEventSeams(publisher, context);
    const missions = createMissionControl({ now: at });
    const runtime = createAgentRuntime({
      missions,
      containment,
      now: at,
      ...seams.agentRuntime,
    });

    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "governance");
    missions.provision("mis_1", "bot_1", "foundry");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 86_400_000, maxValidationRuns: 2 },
    });

    return runtime.terminate("bot_1", "SENTINEL_FINDING", "isolated").then(() => {
      const polled = eventiq.poll("sub_all");
      const termination = polled.find((p) => p.message.messageType === "foundry.agent.terminated")!;
      const payload = termination.message.payload as Record<string, unknown>;
      expect(payload.cause).toBe("SENTINEL_FINDING");
      expect(payload.credentialRevoked).toBe(true);
      expect(payload.evidencePreserved).toBe(true);
    });
  });

  it("publishes a refused production promotion as loudly as a success", () => {
    // A refused production promotion is the most interesting thing Foundry does
    // all day.
    const { eventiq, publisher } = wired();
    const evolution = createEvolutionControl({
      now: at,
      ...foundryEventSeams(publisher, context).evolutionControl,
    });

    evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "AUTONOMOUS_REPAIR", because: ["small"] },
    });
    evolution.promote("chg_1", "PRODUCTION", "foundry");

    const refused = eventiq
      .poll("sub_all")
      .find((p) => p.message.messageType === "foundry.change.promotion_refused")!;
    expect(refused).toBeDefined();
    expect((refused.message.payload as Record<string, unknown>).target).toBe("PRODUCTION");
  });

  it("publishes a drift finding", () => {
    const { eventiq, publisher } = wired();
    const finding: DriftFinding = {
      findingId: "drift_1",
      kind: "MISSING_GOVERNANCE_HOOK",
      severity: "CRITICAL",
      componentId: "hive.specialized.workorderiq",
      declared: "requiresGovernance: true",
      actual: "does not call Governance",
      detail: "detail",
      scenarioWorthy: true,
    };
    publisher.driftDetected(finding, context);

    const polled = eventiq.poll("sub_all");
    expect(polled[0]!.message.messageType).toBe("foundry.drift.detected");
    expect((polled[0]!.message.payload as Record<string, unknown>).severity).toBe("CRITICAL");
  });

  it("carries references and scalars, never the change itself", () => {
    // EventIQ is not the source of truth for what Foundry did. An event
    // carrying the whole candidate would make it a second store of every repair.
    const { eventiq, publisher } = wired();
    publisher.candidateAuthored(candidate(), context);

    const payload = eventiq.poll("sub_all")[0]!.message.payload as Record<string, unknown>;
    for (const value of Object.values(payload)) {
      expect(typeof value).not.toBe("object");
    }
    expect(JSON.stringify(payload)).not.toContain("proposedActions");
    expect(JSON.stringify(payload)).not.toContain("rollbackPlan");
  });

  it("carries the tenant through to the event", () => {
    const { eventiq, publisher } = wired();
    publisher.candidateAuthored(candidate(), context);
    expect(eventiq.poll("sub_all")[0]!.message.tenant?.organizationId).toBe("ksix");
  });

  it("marks a tenantless activity system-scoped rather than leaving it blank", () => {
    const eventiq = createEventIq({ authority: permits, now: at });
    eventiq.subscribe({
      subscriptionId: "sub_sys",
      consumerGroup: "grp_sys",
      consumerId: "hive.control-plane",
      messageTypes: ["*"],
      tenant: null,
      systemScoped: true,
      expectation: { guarantee: "at-least-once", maxAttempts: 3 },
      idempotent: true,
      createdAt: "2026-08-29T09:00:00.000Z",
    });
    const publisher = createFoundryEventPublisher({ eventiq, now: at });

    publisher.candidateAuthored(candidate(), { ...context, tenant: null });
    const polled = eventiq.poll("sub_sys");
    expect(polled[0]!.message.systemScoped).toBe(true);
  });
});

describe("publishing is best-effort and never fails the operation", () => {
  it("does not undo a termination because the bus refused", () => {
    // Foundry terminating a runaway agent must not be undone because the event
    // bus was full.
    const eventiq = createEventIq({
      authority: {
        mayPublish: () => ({ permitted: false, reason: "bus restricted", decisionId: "gd-deny" }),
        mayReplay: permits.mayReplay,
      },
      now: at,
    });
    const publisher = createFoundryEventPublisher({ eventiq, now: at });
    const seams = foundryEventSeams(publisher, context);

    const missions = createMissionControl({ now: at });
    const runtime = createAgentRuntime({ missions, containment, now: at, ...seams.agentRuntime });

    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "governance");
    missions.provision("mis_1", "bot_1", "foundry");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 86_400_000, maxValidationRuns: 2 },
    });

    return runtime.terminate("bot_1", "SENTINEL_FINDING", "isolated").then(() => {
      // The containment happened.
      expect(runtime.get("bot_1")!.state).toBe("TERMINATED");
      expect(runtime.get("bot_1")!.credential.revokedAt).not.toBeNull();
      // And the notification did not, visibly.
      expect(publisher.publishFailures().length).toBeGreaterThan(0);
      expect(publisher.publishFailures()[0]!.reason).toContain("Governance refused");
    });
  });

  it("surfaces publish failures rather than swallowing them", () => {
    // Non-empty means Foundry is acting and nobody is being told, which is a
    // quieter problem than Foundry not acting.
    const seen: string[] = [];
    const eventiq = createEventIq({
      authority: {
        mayPublish: () => ({ permitted: false, reason: "restricted", decisionId: "gd-deny" }),
        mayReplay: permits.mayReplay,
      },
      now: at,
    });
    const publisher = createFoundryEventPublisher({
      eventiq,
      now: at,
      onPublishFailure: (f) => seen.push(f.eventType),
    });

    publisher.candidateAuthored(candidate(), context);
    expect(seen).toEqual(["foundry.candidate.authored"]);
  });

  it("reports no failures on a healthy bus", () => {
    const { publisher } = wired();
    publisher.candidateAuthored(candidate(), context);
    expect(publisher.publishFailures()).toEqual([]);
  });
});

describe("the direct contracts are unchanged", () => {
  it("still answers a lease question synchronously, without the bus", () => {
    // The whole point of retaining direct contracts: the caller needs the
    // answer to proceed.
    const missions = createMissionControl({ now: at });
    const runtime = createAgentRuntime({ missions, containment, now: at });

    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "governance");
    missions.provision("mis_1", "bot_1", "foundry");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 86_400_000, maxValidationRuns: 2 },
    });

    // Synchronous, immediate, no EventIQ anywhere in the call.
    const verdict = runtime.recordAction({
      agentId: "bot_1",
      action: "run_tests",
      environment: "SIMULATION",
    });
    expect(verdict.permitted).toBe(true);
  });

  it("still refuses a production promotion synchronously", () => {
    const evolution = createEvolutionControl({ now: at });
    evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "AUTONOMOUS_REPAIR", because: ["small"] },
    });
    // The answer arrives from the call, not from a subscription.
    expect(evolution.promote("chg_1", "PRODUCTION", "foundry").promoted).toBe(false);
  });

  it("works with no EventIQ at all", () => {
    // Failure isolation: EventIQ being absent must not stop Foundry acting.
    // Every constructor's event seam is optional.
    const missions = createMissionControl({ now: at });
    const runtime = createAgentRuntime({ missions, containment, now: at });
    const evolution = createEvolutionControl({ now: at });

    expect(missions.propose({ missionId: "mis_1", objective, scope }).ok).toBe(true);
    expect(runtime.running()).toEqual([]);
    expect(evolution.all()).toEqual([]);
  });
});
