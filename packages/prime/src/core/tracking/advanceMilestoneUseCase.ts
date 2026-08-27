// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — advanceMilestone use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7.
 *
 * Takes the current `TrackedStep[]` plus the caller's last-known
 * `WorkOrderProjection` and:
 *   1. Computes a fresh projection using `milestoneRules.ts`.
 *   2. Compares against the previous projection and emits between 0 and 3
 *      events:
 *        - `work_order.milestone.advanced` — milestone changed forward
 *        - `work_order.eta.updated`        — ETA drift ≥ threshold OR
 *                                            ETA went from absent → present
 *                                            OR present → absent
 *        - `work_order.eta.at_risk`        — risk transitioned false → true
 *   3. Returns the new projection + a list of emitted event types.
 *
 * Stateless: the caller persists the projection; this use case just
 * validates inputs, computes, and appends events.
 *
 * Idempotency: if nothing material changed, the use case emits zero
 * events. That lets consumers poll liberally without polluting the log.
 */

import type {
  EventActor,
  WorkOrderEventType,
} from "../../models/events.js";
import type {
  Clock,
  EventLog,
} from "../logging/eventLog.js";
import type {
  EtaAtRiskPayload,
  EtaConfidence,
  EtaUpdatedPayload,
  MilestoneAdvancedPayload,
  TrackedStep,
  TrackingError,
  WorkOrderProjection,
} from "./trackingTypes.js";
import { ETA_DRIFT_THRESHOLD_MINUTES } from "./trackingTypes.js";
import {
  assessEtaRisk,
  computeProgress,
  deriveMilestone,
  estimateCompletionAt,
  isForwardTransition,
} from "./milestoneRules.js";

// ---------- Public surface ----------

export type EmittedTrackingEvent =
  | "work_order.milestone.advanced"
  | "work_order.eta.updated"
  | "work_order.eta.at_risk";

export interface AdvanceMilestoneInput {
  readonly workOrderId: string;
  readonly trackedSteps: ReadonlyArray<TrackedStep>;
  readonly hasRoutingEvent: boolean;
  /**
   * The caller's last-known projection for this work order. Absent on the
   * very first call — the use case treats that as "baseline" and may emit
   * an initial eta.updated so consumers get a starting ETA.
   */
  readonly previousProjection?: WorkOrderProjection;
}

export type AdvanceMilestoneResult =
  | {
      readonly ok: true;
      readonly projection: WorkOrderProjection;
      readonly emitted: ReadonlyArray<EmittedTrackingEvent>;
    }
  | { readonly ok: false; readonly error: TrackingError };

export interface AdvanceMilestoneUseCaseDeps {
  readonly eventLog: EventLog;
  /** Injected for deterministic tests. Defaults to wall clock. */
  readonly clock?: Clock;
}

export interface AdvanceMilestoneUseCase {
  execute(
    input: AdvanceMilestoneInput,
    actor: EventActor
  ): Promise<AdvanceMilestoneResult>;
}

// ---------- Factory ----------

export function createAdvanceMilestoneUseCase(
  deps: AdvanceMilestoneUseCaseDeps
): AdvanceMilestoneUseCase {
  const { eventLog } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async execute(input, actor) {
      // ---- Validation ----
      const validation = validateInput(input);
      if (validation) {
        return { ok: false, error: validation };
      }

      const now = clock();
      const projection = buildProjection(input, now);
      const emitted: EmittedTrackingEvent[] = [];

      // ---- milestone.advanced ----
      const previous = input.previousProjection;
      const previousMilestone = previous?.currentMilestone ?? "intake";
      if (
        projection.currentMilestone !== previousMilestone &&
        isForwardTransition(previousMilestone, projection.currentMilestone)
      ) {
        await append(
          eventLog,
          input.workOrderId,
          "work_order.milestone.advanced",
          actor,
          {
            fromMilestone: previousMilestone,
            toMilestone: projection.currentMilestone,
            completedStepCount: projection.completedStepCount,
            totalStepCount: projection.totalStepCount,
            percentComplete: projection.percentComplete,
          } satisfies MilestoneAdvancedPayload
        );
        emitted.push("work_order.milestone.advanced");
      }

      // ---- eta.updated ----
      if (shouldEmitEtaUpdate(previous, projection)) {
        const driftMinutes = computeDriftMinutes(
          previous?.estimatedCompletionAt,
          projection.estimatedCompletionAt
        );
        await append(
          eventLog,
          input.workOrderId,
          "work_order.eta.updated",
          actor,
          {
            previousEtaAt: previous?.estimatedCompletionAt?.toISOString(),
            newEtaAt: projection.estimatedCompletionAt?.toISOString(),
            driftMinutes,
            confidence: projection.etaConfidence,
          } satisfies EtaUpdatedPayload
        );
        emitted.push("work_order.eta.updated");
      }

      // ---- eta.at_risk ----
      const wasAtRisk = previous?.etaConfidence === "at_risk";
      if (projection.etaConfidence === "at_risk" && !wasAtRisk) {
        // assessEtaRisk returns the same structure we used to set
        // etaRiskReason on the projection; re-run so we also have
        // `minutesOverBaseline` for the payload.
        const risk = assessEtaRisk(input.trackedSteps);
        if (risk.reason) {
          await append(
            eventLog,
            input.workOrderId,
            "work_order.eta.at_risk",
            actor,
            {
              riskReason: risk.reason,
              minutesOverBaseline: risk.minutesOverBaseline,
              currentMilestone: projection.currentMilestone,
            } satisfies EtaAtRiskPayload
          );
          emitted.push("work_order.eta.at_risk");
        }
      }

      return { ok: true, projection, emitted };
    },
  };
}

// ---------- Helpers ----------

function validateInput(input: AdvanceMilestoneInput): TrackingError | null {
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "advanceMilestone: workOrderId must be a non-empty string",
    };
  }
  if (
    input.previousProjection !== undefined &&
    input.previousProjection.workOrderId !== input.workOrderId
  ) {
    return {
      code: "work_order_mismatch",
      message: `advanceMilestone: previousProjection.workOrderId '${input.previousProjection.workOrderId}' != input.workOrderId '${input.workOrderId}'`,
    };
  }
  return null;
}

function buildProjection(
  input: AdvanceMilestoneInput,
  now: Date
): WorkOrderProjection {
  const milestone = deriveMilestone(
    input.trackedSteps,
    input.hasRoutingEvent
  );
  const progress = computeProgress(input.trackedSteps);
  const { eta, tentative } = estimateCompletionAt(input.trackedSteps, now);
  const risk = assessEtaRisk(input.trackedSteps);

  const confidence: EtaConfidence = risk.atRisk
    ? "at_risk"
    : tentative
      ? "tentative"
      : "firm";

  return Object.freeze({
    workOrderId: input.workOrderId,
    currentMilestone: milestone,
    completedStepCount: progress.completedStepCount,
    totalStepCount: progress.totalStepCount,
    percentComplete: progress.percentComplete,
    estimatedCompletionAt: eta,
    etaConfidence: confidence,
    etaRiskReason: risk.atRisk ? risk.reason : undefined,
    lastUpdated: now,
  });
}

function shouldEmitEtaUpdate(
  previous: WorkOrderProjection | undefined,
  next: WorkOrderProjection
): boolean {
  const prevEta = previous?.estimatedCompletionAt;
  const nextEta = next.estimatedCompletionAt;

  // Initial baseline announcement if there's now an ETA and there wasn't one.
  if (!prevEta && nextEta) return true;
  // ETA disappeared (e.g. estimates removed) — worth announcing.
  if (prevEta && !nextEta) return true;
  // Both absent — nothing to say.
  if (!prevEta && !nextEta) return false;
  // Both present — emit only if drift crosses the threshold.
  const drift = Math.abs(computeDriftMinutes(prevEta, nextEta));
  return drift >= ETA_DRIFT_THRESHOLD_MINUTES;
}

/**
 * Signed drift in whole minutes (`next - previous`). Returns 0 when either
 * side is absent — the use case handles the "appear"/"disappear" cases
 * explicitly in `shouldEmitEtaUpdate`.
 */
function computeDriftMinutes(
  previous: Date | undefined,
  next: Date | undefined
): number {
  if (!previous || !next) return 0;
  const deltaMs = next.getTime() - previous.getTime();
  return Math.round(deltaMs / 60_000);
}

async function append<T>(
  eventLog: EventLog,
  workOrderId: string,
  type: WorkOrderEventType,
  actor: EventActor,
  payload: T
): Promise<void> {
  await eventLog.append<T>({
    workOrderId,
    type,
    actor,
    payload,
  });
}
