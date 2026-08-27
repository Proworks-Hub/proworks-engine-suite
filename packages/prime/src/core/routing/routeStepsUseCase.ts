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
 * PRIME Engine — routeSteps use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.3 (Routing Module).
 *
 * Takes a `WorkOrderId` + `TentativeStep[]` (from Template Resolver §3.2),
 * optionally a map of manual `stepId → stationId` overrides, and:
 *   1. For each step, asks the `StationRegistry` for eligible stations.
 *   2. Honors manual override when supplied (firm — errors if station isn't eligible).
 *   3. Otherwise picks the eligible station with the shortest queue depth,
 *      breaking ties by station id for determinism.
 *   4. If any step can't be routed, returns errors and emits NO event. Partial
 *      routing doesn't advance a WO — same philosophy as template resolution.
 *   5. On full success, appends exactly one `work_order.routing.assigned`
 *      event with a `stationLoadSummary`.
 *
 * Phase 1 does NOT:
 * - Emit `work_order.routing.reroute_suggested` (advisory; comes with soft constraints).
 * - Emit `work_order.routing.batched_with` (batching feature).
 * - Model "material at station" or "operator logged in" as first-class blockers —
 *   those show up in Task Flow (§3.5), not Routing.
 * - Update the registry's queue depth between steps in one batch. Queue depth
 *   reflects the registry's live snapshot at the start of the pass. Good
 *   enough for tests + small shops; future versions can do a mutating pass.
 */

import type {
  EventActor,
  WorkOrderId,
} from "../../models/events";
import type { EventLog } from "../logging/eventLog";
import type { TentativeStep } from "../template/templateTypes";
import type {
  RoutedStep,
  RoutingAssignedPayload,
  RoutingError,
  RoutingReason,
  Station,
  StationId,
  StationRegistry,
} from "./routingTypes";

// ---------- Public surface ----------

export interface RouteStepsInput {
  readonly workOrderId: WorkOrderId;
  readonly tentativeSteps: ReadonlyArray<TentativeStep>;
  /**
   * Optional firm overrides. Keyed by `tentativeStepId`. When present, the
   * chosen station MUST be eligible (matches class, carries required skills,
   * not down/maintenance). If it's not eligible, we return a
   * `manual_override_ineligible` error rather than silently falling back to auto.
   */
  readonly manualOverrides?: ReadonlyMap<string, StationId>;
}

export type RouteStepsResult =
  | { readonly ok: true; readonly routedSteps: ReadonlyArray<RoutedStep> }
  | { readonly ok: false; readonly errors: ReadonlyArray<RoutingError> };

export interface RouteStepsUseCaseDeps {
  readonly eventLog: EventLog;
  readonly stationRegistry: StationRegistry;
}

export interface RouteStepsUseCase {
  execute(input: RouteStepsInput, actor: EventActor): Promise<RouteStepsResult>;
}

// ---------- Factory ----------

export function createRouteStepsUseCase(
  deps: RouteStepsUseCaseDeps
): RouteStepsUseCase {
  const { eventLog, stationRegistry } = deps;

  return {
    async execute(input, actor) {
      const errors: RoutingError[] = [];
      const routedSteps: RoutedStep[] = [];

      for (const step of input.tentativeSteps) {
        const eligible = await stationRegistry.listEligibleStations({
          workstationClass: step.workstationClass,
          requiredSkillTags: step.requiredSkillTags,
        });

        // ---- Manual override path ----
        const overrideStationId = input.manualOverrides?.get(step.id);
        if (overrideStationId !== undefined) {
          const overrideStation = eligible.find(
            (s) => s.id === overrideStationId
          );
          if (!overrideStation) {
            errors.push({
              code: "manual_override_ineligible",
              message: `Manual override station '${overrideStationId}' is not eligible for step '${step.label}' (id=${step.id})`,
              tentativeStepId: step.id,
              workstationClass: step.workstationClass,
              attemptedStationId: overrideStationId,
            });
            continue;
          }
          routedSteps.push(toRoutedStep(step, overrideStation, "manual_pick"));
          continue;
        }

        // ---- Auto pick ----
        if (eligible.length === 0) {
          errors.push(diagnoseInfeasibility(step));
          continue;
        }

        const pick = pickShortestQueue(eligible);
        const reason: RoutingReason =
          eligible.length === 1 ? "only_eligible_station" : "shortest_queue";
        routedSteps.push(toRoutedStep(step, pick, reason));
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      await eventLog.append<RoutingAssignedPayload>({
        workOrderId: input.workOrderId,
        type: "work_order.routing.assigned",
        actor,
        payload: {
          stepCount: routedSteps.length,
          stationLoadSummary: summarizeLoad(routedSteps),
          // Batch W — per-step station map for the StationKiosk +
          // MasterTablet projections. Previously only the aggregate
          // `stationLoadSummary` shipped, which told you "how many
          // jobs on each station" but not "which step of which WO
          // lives at which station." Downstream role-scoped views
          // need the latter to filter correctly.
          routedSteps: routedSteps.map((s) => ({
            stepId: s.tentativeStepId,
            stationId: s.stationId,
          })),
        },
      });

      return { ok: true, routedSteps };
    },
  };
}

// ---------- Helpers ----------

function toRoutedStep(
  step: TentativeStep,
  station: Station,
  reason: RoutingReason
): RoutedStep {
  return Object.freeze({
    tentativeStepId: step.id,
    stationId: station.id,
    lineItemId: step.lineItemId,
    templateId: step.templateId,
    templateStepId: step.templateStepId,
    label: step.label,
    workstationClass: step.workstationClass,
    requiredSkillTags: step.requiredSkillTags,
    estimatedDurationMinutes: step.estimatedDurationMinutes,
    dependsOn: step.dependsOn,
    optional: step.optional,
    routingReason: reason,
  });
}

function pickShortestQueue(stations: ReadonlyArray<Station>): Station {
  // Stable, deterministic: shortest queueDepth wins; ties break on id.
  return [...stations].sort((a, b) => {
    if (a.queueDepth !== b.queueDepth) return a.queueDepth - b.queueDepth;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

function summarizeLoad(
  routed: ReadonlyArray<RoutedStep>
): ReadonlyArray<{ readonly stationId: StationId; readonly stepCount: number }> {
  const counts = new Map<StationId, number>();
  for (const s of routed) {
    counts.set(s.stationId, (counts.get(s.stationId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stationId, stepCount]) => ({ stationId, stepCount }))
    .sort((a, b) => (a.stationId < b.stationId ? -1 : 1));
}

/**
 * When auto pick fails, classify WHY so the UI / operator gets a useful error.
 * We differentiate "wrong class entirely", "class matches but skills missing",
 * and "stations exist but all are down". The registry already filters the
 * down/maintenance case out of eligibility, so we re-query without the skill
 * filter to make the distinction.
 *
 * Note: this function is sync-returning a synthetic error. A richer diagnosis
 * (querying the registry for class-only matches to distinguish cases) would
 * make this async. We keep it synchronous in Phase 1 — the registry is the
 * source of truth and any step that falls through is "no_eligible_station"
 * from the use case's perspective. Refinement is future work.
 */
function diagnoseInfeasibility(step: TentativeStep): RoutingError {
  return {
    code: "no_eligible_station",
    message: `No station satisfies class '${step.workstationClass}' with required skills [${step.requiredSkillTags.join(", ") || "none"}] for step '${step.label}' (id=${step.id})`,
    tentativeStepId: step.id,
    workstationClass: step.workstationClass,
  };
}
