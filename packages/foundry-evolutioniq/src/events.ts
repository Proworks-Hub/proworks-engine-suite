// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  HIVE_MESSAGE_SCHEMA_VERSION,
  type HiveMessage,
} from "@proworks-hub/contracts";
import type { EventIq } from "@proworks-hub/eventiq";
import type { RepairCandidate, DriftFinding } from "@proworks-hub/repair-learning";

import type { CandidateChange, PromotionTarget } from "./evolution/control.js";
import type { Mission, MissionTransition } from "./mission/mission.js";
import type { TerminationRecord } from "./agents/runtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// Foundry and Repair Learning events, published through EventIQ.
//
// WHAT GOES ON THE BUS AND WHAT DOES NOT
//
// The instruction was to wire events into EventIQ while RETAINING DIRECT
// CONTRACTS FOR SYNCHRONOUS OPERATIONS, and that distinction is the whole
// design here. It is not a performance choice.
//
// ASYNCHRONOUS (published): notifications that something HAPPENED. A mission
// changed state. An agent was terminated. A candidate was authored. Drift was
// found. Nobody is waiting on the answer, several parties may care, and losing
// one costs observability rather than correctness.
//
// SYNCHRONOUS (direct contracts, unchanged): anything where the caller needs
// the answer to proceed. `leasePermits()`, `validate()`, `promote()`,
// `supervise()`, `authorize()`. Every one of those is a decision the caller
// acts on immediately, and routing a decision through a queue means the caller
// either blocks on a bus or proceeds without an answer.
//
// The second failure mode is the dangerous one. A `promote()` that published
// "may I promote?" and continued would be a promotion that happened before
// anybody said yes. EventIQ's own charter puts it plainly: "Events tell the
// Hive what happened. They do not decide what should be authorized next."
//
// So: containment, authorization and validation stay direct calls, forever.
// This module publishes the record of what those calls decided.
//
// PUBLISHING IS BEST-EFFORT AND SAYS SO
//
// A failed publish never fails the operation that produced it. Foundry
// terminating a runaway agent must not be undone because the event bus was
// full. Failures are counted and surfaced through `publishFailures()`, which is
// the honest position: the containment happened, and the notification did not.
// ─────────────────────────────────────────────────────────────────────────────

/** Event types Foundry publishes. Past tense, because they already happened. */
export const FOUNDRY_EVENT_TYPES = [
  "foundry.mission.proposed",
  "foundry.mission.authorized",
  "foundry.mission.state_changed",
  "foundry.mission.completed",
  "foundry.mission.failed",
  "foundry.agent.spawned",
  "foundry.agent.terminated",
  "foundry.candidate.authored",
  "foundry.candidate.validated",
  "foundry.candidate.rejected",
  "foundry.change.promoted",
  "foundry.change.promotion_refused",
  "foundry.drift.detected",
] as const;
export type FoundryEventType = (typeof FOUNDRY_EVENT_TYPES)[number];

/**
 * Operations that must never travel as events.
 *
 * Exported and tested rather than left as a convention. Each of these is a
 * decision a caller acts on immediately; publishing one would mean either
 * blocking on a bus or proceeding without an answer.
 */
export const SYNCHRONOUS_ONLY = [
  "leasePermits",
  "changeWithinScope",
  "validate",
  "promote",
  "supervise",
  "authorize",
  "admit",
  "classifyChange",
] as const;

export interface FoundryEventContext {
  readonly tenant: { organizationId: string; roles: readonly string[] } | null;
  readonly correlationId: string;
  readonly executionId?: string;
  /** The Governance decision the activity runs under. */
  readonly governanceDecisionId?: string;
}

export interface PublishFailure {
  readonly eventType: FoundryEventType;
  readonly reason: string;
  readonly at: string;
}

export interface FoundryEventPublisher {
  missionProposed(mission: Mission, context: FoundryEventContext): void;
  missionStateChanged(mission: Mission, transition: MissionTransition, context: FoundryEventContext): void;
  agentSpawned(input: { agentId: string; missionId: string }, context: FoundryEventContext): void;
  agentTerminated(record: TerminationRecord, context: FoundryEventContext): void;
  candidateAuthored(candidate: RepairCandidate, context: FoundryEventContext): void;
  candidateValidated(input: { candidateId: string; admissible: boolean }, context: FoundryEventContext): void;
  candidateRejected(input: { candidateId: string; reason: string; vetoedBy?: string }, context: FoundryEventContext): void;
  changePromoted(change: CandidateChange, target: PromotionTarget, context: FoundryEventContext): void;
  promotionRefused(input: { changeId: string; target: string; reason: string }, context: FoundryEventContext): void;
  driftDetected(finding: DriftFinding, context: FoundryEventContext): void;

  /**
   * Publishes that failed.
   *
   * Should be empty. Non-empty means Foundry is acting and nobody is being
   * told, which is a different and quieter problem than Foundry not acting.
   */
  publishFailures(): readonly PublishFailure[];
}

export interface FoundryEventPublisherOptions {
  eventiq: EventIq;
  now?: () => Date;
  generateId?: () => string;
  onPublishFailure?: (failure: PublishFailure) => void;
}

let sequence = 0;

export function createFoundryEventPublisher(
  options: FoundryEventPublisherOptions,
): FoundryEventPublisher {
  const now = options.now ?? (() => new Date());
  const newId = options.generateId ?? (() => `evt_foundry_${(sequence += 1)}`);
  const failures: PublishFailure[] = [];

  /**
   * Builds and publishes one event.
   *
   * Every payload here is flat and non-sensitive: ids, states, counts, booleans.
   * Not the candidate's diff, not the workspace contents, not the evidence.
   * EventIQ is not the source of truth for what Foundry did, and an event
   * carrying the whole change would make it a second store of every repair.
   */
  const publish = (
    eventType: FoundryEventType,
    context: FoundryEventContext,
    payload: Readonly<Record<string, string | number | boolean | null>>,
  ): void => {
    const message: HiveMessage = {
      messageId: newId(),
      // EVENT, not COMMAND. Foundry is reporting, not instructing — and an
      // EVENT needs no `producedUnderAuthority`, which is correct: reporting a
      // fact requires no authority over the recipient.
      category: "EVENT",
      messageType: eventType,
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.constitutional.foundry",
      ...(context.tenant
        ? { tenant: { organizationId: context.tenant.organizationId, roles: [...context.tenant.roles] } }
        : {}),
      systemScoped: context.tenant === null,
      ...(context.executionId ? { executionId: context.executionId } : {}),
      trace: { correlationId: context.correlationId },
      timestamp: now().toISOString(),
      dataClassification: "internal",
      payload,
    } as HiveMessage;

    const result = options.eventiq.publish(message);
    if (!result.accepted) {
      // Best-effort by design. Foundry terminating a runaway agent must not be
      // undone because the bus was full.
      const failure: PublishFailure = {
        eventType,
        reason: result.reason,
        at: now().toISOString(),
      };
      failures.push(failure);
      options.onPublishFailure?.(failure);
    }
  };

  return {
    missionProposed(mission, context) {
      publish("foundry.mission.proposed", context, {
        missionId: mission.missionId,
        objective: mission.objective.statement,
        environment: mission.scope.environment,
        components: mission.scope.components.join(","),
      });
    },

    missionStateChanged(mission, transition, context) {
      publish("foundry.mission.state_changed", context, {
        missionId: mission.missionId,
        from: transition.from,
        to: transition.to,
        by: transition.by,
        reason: transition.reason,
      });

      // A completion and a failure are separately interesting, and a consumer
      // that only cares about one should not have to filter the other out of a
      // generic stream.
      if (transition.to === "COMPLETED") {
        publish("foundry.mission.completed", context, { missionId: mission.missionId });
      } else if (mission.failureReason !== null && transition.to !== "RUNNING") {
        publish("foundry.mission.failed", context, {
          missionId: mission.missionId,
          state: transition.to,
          reason: mission.failureReason,
        });
      }
    },

    agentSpawned(input, context) {
      publish("foundry.agent.spawned", context, {
        agentId: input.agentId,
        missionId: input.missionId,
      });
    },

    agentTerminated(record, context) {
      publish("foundry.agent.terminated", context, {
        agentId: record.agentId,
        missionId: record.missionId,
        cause: record.cause,
        missionState: record.missionState,
        credentialRevoked: record.credentialRevoked,
        workspacesFrozen: record.workspacesFrozen.length,
        evidencePreserved: record.evidencePreserved,
      });
    },

    candidateAuthored(candidate, context) {
      publish("foundry.candidate.authored", context, {
        candidateId: candidate.repairCandidateId,
        diagnosisId: candidate.diagnosisId,
        repairClass: candidate.repairClass,
        risk: candidate.risk,
        authoredBy: candidate.authoredBy,
      });
    },

    candidateValidated(input, context) {
      publish("foundry.candidate.validated", context, {
        candidateId: input.candidateId,
        admissible: input.admissible,
      });
    },

    candidateRejected(input, context) {
      publish("foundry.candidate.rejected", context, {
        candidateId: input.candidateId,
        reason: input.reason,
        vetoedBy: input.vetoedBy ?? null,
      });
    },

    changePromoted(change, target, context) {
      publish("foundry.change.promoted", context, {
        changeId: change.changeId,
        missionId: change.missionId,
        target,
        level: change.level,
      });
    },

    promotionRefused(input, context) {
      // Published as loudly as a success. A refused production promotion is the
      // most interesting thing Foundry does all day.
      publish("foundry.change.promotion_refused", context, {
        changeId: input.changeId,
        target: input.target,
        reason: input.reason,
      });
    },

    driftDetected(finding, context) {
      publish("foundry.drift.detected", context, {
        findingId: finding.findingId,
        kind: finding.kind,
        severity: finding.severity,
        componentId: finding.componentId,
        scenarioWorthy: finding.scenarioWorthy,
      });
    },

    publishFailures: () => [...failures],
  };
}

/**
 * Wires a publisher into the seams Foundry already exposes.
 *
 * Same shape as `auditSeams` in repair-learning, and for the same reason: a
 * host wires this once rather than remembering which callback belongs where.
 * Missing a seam is how an event stream ends up with eleven of thirteen types
 * and nobody noticing which two.
 */
export function foundryEventSeams(
  publisher: FoundryEventPublisher,
  context: FoundryEventContext,
) {
  return {
    /** For `createMissionControl`. */
    missionControl: {
      onTransition: (mission: Mission, transition: MissionTransition) =>
        publisher.missionStateChanged(mission, transition, context),
    },
    /** For `createAgentRuntime`. */
    agentRuntime: {
      onTermination: (record: TerminationRecord) => publisher.agentTerminated(record, context),
    },
    /** For `createEvolutionControl`. */
    evolutionControl: {
      onPromotion: (change: CandidateChange, target: PromotionTarget) =>
        publisher.changePromoted(change, target, context),
      onPromotionRefused: (changeId: string, target: string, reason: string) =>
        publisher.promotionRefused({ changeId, target, reason }, context),
    },
    /** For `createRepairBot`. */
    repairBot: {
      onAuthored: (candidate: RepairCandidate) => publisher.candidateAuthored(candidate, context),
    },
  };
}

/**
 * Whether an operation may be performed by publishing an event.
 *
 * Always false for anything in `SYNCHRONOUS_ONLY`. Exported so a caller
 * wondering whether to move a decision onto the bus finds a function that says
 * no — the answer is the same for every one of them, and the reason is EventIQ's
 * own doctrine: events say what happened, not what is authorized next.
 */
export function mayBePerformedAsynchronously(operation: string): boolean {
  return !(SYNCHRONOUS_ONLY as readonly string[]).includes(operation);
}
