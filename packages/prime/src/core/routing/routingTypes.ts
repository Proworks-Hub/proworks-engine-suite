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
 * PRIME Engine — Routing types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.3 (Routing Module).
 *
 * Routing converts `TentativeStep[]` (class-level placeholders from the
 * Template Resolver) into `RoutedStep[]` (concrete `stationId` per step).
 *
 * Phase 1 scope:
 * - Hard constraints only: workstation class match + all required skill tags
 *   must be available at the station + station status must not be `down` or
 *   `maintenance`.
 * - Soft constraints (operator continuity, minimum setup changes) — deferred.
 * - Reroute suggestions (`work_order.routing.reroute_suggested`) — deferred.
 * - Batching (`work_order.routing.batched_with`) — deferred.
 *
 * Hard constraints are modeled entirely through `requiredSkillTags`. The
 * spec's example "heavy acrylic jobs only on the large-bed laser" becomes
 * a skill tag like `large-bed-capable` that only the large-bed station
 * advertises.
 */

import type { WorkOrderId } from "../../models/events.js";
import type {
  SkillTag,
  WorkstationClass,
} from "../template/templateTypes.js";

// ---------- Stations ----------

// StationId is part of the shared event vocabulary; re-exported here so
// routing consumers keep importing it from this module.
import type { StationId } from "../../models/events.js";
export type { StationId };

/**
 * Coarse station status. `busy` is still eligible (we queue work); only
 * `down` and `maintenance` exclude a station from assignment.
 */
export type StationStatus = "available" | "busy" | "down" | "maintenance";

export interface Station {
  readonly id: StationId;
  readonly label: string;
  readonly workstationClass: WorkstationClass;
  /**
   * Skill tags the station + its current operator(s) can perform.
   * A step with `requiredSkillTags` ⊈ `availableSkillTags` is not eligible.
   */
  readonly availableSkillTags: ReadonlyArray<SkillTag>;
  readonly status: StationStatus;
  /**
   * Current queue depth (informational). Routing uses this for tiebreaking
   * among otherwise-equal eligible stations.
   */
  readonly queueDepth: number;
}

// ---------- Routed step (output) ----------

/**
 * Why the router picked a particular station. Kept on the routed step for
 * audit and for the learning layer (PRIME spec §21).
 */
export type RoutingReason =
  /** Only one station satisfied the hard constraints. */
  | "only_eligible_station"
  /** Supervisor / pre-production explicitly picked this station. */
  | "manual_pick"
  /** Multiple eligible stations; shortest queue depth won the pick. */
  | "shortest_queue";

export interface RoutedStep {
  readonly tentativeStepId: string;
  readonly stationId: StationId;
  readonly lineItemId: string;
  readonly templateId: string;
  readonly templateStepId: string;
  readonly label: string;
  readonly workstationClass: WorkstationClass;
  readonly requiredSkillTags: ReadonlyArray<SkillTag>;
  readonly estimatedDurationMinutes?: number;
  /** Still referencing tentative-step ids; the graph topology survives routing. */
  readonly dependsOn: ReadonlyArray<string>;
  readonly optional: boolean;
  readonly routingReason: RoutingReason;
}

// ---------- Routing errors ----------

export type RoutingErrorCode =
  /** No station matched the workstation class at all. */
  | "no_eligible_station"
  /** Class matches exist but none carry all required skill tags. */
  | "required_skill_unavailable"
  /** Eligible stations exist but all are currently down or in maintenance. */
  | "all_eligible_stations_down"
  /** Caller passed a manual override but the chosen station is not eligible. */
  | "manual_override_ineligible";

export interface RoutingError {
  readonly code: RoutingErrorCode;
  readonly message: string;
  readonly tentativeStepId: string;
  readonly workstationClass: WorkstationClass;
  /** Present on `manual_override_ineligible` — which station the caller tried to force. */
  readonly attemptedStationId?: StationId;
}

// ---------- Station registry port ----------

export interface StationEligibilityQuery {
  readonly workstationClass: WorkstationClass;
  readonly requiredSkillTags: ReadonlyArray<SkillTag>;
}

/**
 * Narrow port over "the shop's current station state". Real adapters will
 * combine a stations table with live telemetry (queue depth, operator
 * login, maintenance flags). The in-memory adapter is fine for tests + dev.
 *
 * The registry is responsible for applying STATIC eligibility filters
 * (class match, skill availability, status != down/maintenance). The
 * routing use case applies the DYNAMIC pick logic (shortest queue, manual
 * override handling).
 */
export interface StationRegistry {
  listEligibleStations(
    query: StationEligibilityQuery
  ): Promise<ReadonlyArray<Station>>;

  /** Get a single station by id. Returns null if unknown. */
  getById(stationId: StationId): Promise<Station | null>;
}

// ---------- Event payloads (§16 event catalog) ----------

export interface RoutingAssignedPayload {
  readonly stepCount: number;
  /** stationId → number of steps assigned. Drives load UIs without re-scanning routed steps. */
  readonly stationLoadSummary: ReadonlyArray<{
    readonly stationId: StationId;
    readonly stepCount: number;
  }>;
  /**
   * Batch W — per-step station map. Optional for backward compatibility
   * with the Phase 1 emitters that only populated `stationLoadSummary`.
   * Projections that need "which station owns stepX?" (StationKiosk,
   * MasterTablet) read from here. When absent, those projections fall
   * back to empty maps and can't filter by station; older events in the
   * log thus won't break the summary fold — they just produce less
   * precise kiosk views for historical WOs. New emitters should always
   * populate this.
   */
  readonly routedSteps?: ReadonlyArray<{
    readonly stepId: string;
    readonly stationId: StationId;
  }>;
}

/** Payload shape for the (deferred) `work_order.routing.reroute_suggested` event. */
export interface RouteRerouteSuggestedPayload {
  readonly workOrderId: WorkOrderId;
  readonly tentativeStepId: string;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
}

/** Payload shape for the (deferred) `work_order.routing.batched_with` event. */
export interface RouteBatchedWithPayload {
  readonly stationId: StationId;
  readonly batchedWorkOrderIds: ReadonlyArray<WorkOrderId>;
}
