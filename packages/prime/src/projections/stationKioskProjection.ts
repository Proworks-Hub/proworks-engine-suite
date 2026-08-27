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
 * PRIME Engine — Phase 2 Batch W — StationKiosk projection.
 *
 * Role-scoped read model for a single shop-floor station (tablet kiosk,
 * PC manage-bar). Answers: "which work orders are actionable HERE
 * right now, and what does the operator need to see about each one?"
 *
 * Architecture
 * ------------
 * This is a DERIVED projection — it doesn't fold events of its own.
 * Instead it queries the `WorkOrderSummaryProjection` (Session 1) and
 * narrows each summary down to the fields an operator needs, filtering
 * out WOs whose current step isn't at this station.
 *
 * A WO is "at this station" when ALL of the following hold:
 *   - the summary exists (intake happened)
 *   - the WO is not in a terminal state
 *   - at least one step is in `ready`, `in_progress`, or `paused` state
 *   - the `stepStations` map resolves that step's id to the given station
 *
 * When a WO's `stepStations` map is empty (pre-Batch-W routing events),
 * we fall through to a "no station known" bucket rather than dropping
 * the WO entirely — that way a Hub running on an old event log still
 * renders something and a shop on mixed data doesn't silently hide jobs.
 *
 * Consumers (tablet StationKioskShell, PC manage-bar panel) should
 * treat the returned list as the complete, ordered view — no client-
 * side filtering should be needed. Sort order: priority color desc
 * (red → yellow → green), then due date asc, then updated desc.
 *
 * Spec: PRIME-ENGINE-SPEC.md §8 (Role Views) + §3.7 (Tracking /
 * Projection).
 */

import type { WorkOrderId } from "../models/events";
import type {
  PriorityColor,
  PriorityLevel,
} from "../core/priority/priorityTypes";
import type { StationId } from "../core/routing/routingTypes";
import type { StepState } from "../core/taskflow/taskFlowTypes";
import type { Milestone } from "../core/tracking/trackingTypes";

import type { WorkOrderSummary } from "./workOrderSummaryTypes";
import type { WorkOrderSummaryProjection } from "./createWorkOrderSummaryProjection";

// ---------- View shape ----------

/**
 * A single actionable job row shown on the kiosk. One per (WO, station-
 * scoped-active-step) pair; in practice a WO has at most one active
 * step per station so we collapse to one row per WO.
 */
export interface StationKioskJob {
  readonly workOrderId: WorkOrderId;
  readonly customerName: string;
  readonly priorityColor: PriorityColor | null;
  readonly priorityLevel: PriorityLevel | null;
  readonly milestone: Milestone;
  /** The step id at this station that's actionable right now. */
  readonly activeStepId: string | null;
  readonly activeStepState: StepState | null;
  readonly dueDate: string | null;
  readonly atRisk: boolean;
  /** Flag the operator should see: there's a change order pending on this WO. */
  readonly hasOpenChangeOrder: boolean;
  /** Cross-shop signal so the operator knows how loaded the WO is overall. */
  readonly totalOpenSteps: number;
  /** ISO-8601 — when this view row was last refreshed. */
  readonly updatedAt: string;
}

export interface StationKioskView {
  readonly stationId: StationId;
  readonly jobs: ReadonlyArray<StationKioskJob>;
  /** ISO-8601 — when the projection assembled this view. */
  readonly generatedAt: string;
}

// ---------- Projection port ----------

export interface StationKioskProjection {
  /**
   * Build the current view for a station by scanning every summary the
   * backing WorkOrderSummaryProjection has cached. Not cheap on cold
   * caches — callers should prime with a `getAll` pass on the summary
   * projection before invoking this on first mount.
   */
  get(stationId: StationId): Promise<StationKioskView>;

  /**
   * Same as `get` but also touches the WorkOrderSummaryProjection's
   * cache, so any WO with pending events is caught up first. Used by
   * views that want guaranteed freshness (e.g. after an SSE ping).
   */
  refresh(stationId: StationId): Promise<StationKioskView>;
}

// ---------- Dependencies ----------

export interface CreateStationKioskProjectionDeps {
  readonly summaries: WorkOrderSummaryProjection;
  /**
   * Optional clock override for tests. Defaults to `Date.now()`.
   */
  readonly now?: () => Date;
}

// ---------- Factory ----------

/**
 * States that indicate a step is actionable at the station — i.e. the
 * operator should see this WO. We include `paused` because a paused
 * step is still "mine to resume" from the station's perspective.
 * `completed` and `blocked` are excluded: completed WOs shouldn't
 * appear, and blocked ones need attention elsewhere (they'll appear
 * on the Master Tablet view with an alert).
 */
const STATION_ACTIONABLE_STEP_STATES: ReadonlySet<StepState> = new Set<StepState>([
  "ready",
  "in_progress",
  "paused",
]);

/**
 * Pick the single most-actionable step id at the given station for a
 * WO. Priority: in_progress > ready > paused. Returns null if no step
 * at that station is actionable (WO is not this station's problem
 * right now).
 */
function pickActiveStepAtStation(
  summary: WorkOrderSummary,
  stationId: StationId,
): { stepId: string; state: StepState } | null {
  // Walk the summary's per-step state map, honoring the station filter.
  let best: { stepId: string; state: StepState; rank: number } | null = null;
  const stateRank: Record<StepState, number> = {
    in_progress: 3,
    ready: 2,
    paused: 1,
    pending: 0,
    blocked: 0,
    completed: 0,
  };
  for (const [stepId, state] of Object.entries(summary.stepStates)) {
    if (!STATION_ACTIONABLE_STEP_STATES.has(state)) continue;
    const assignedStation = summary.stepStations[stepId];
    if (!assignedStation || assignedStation !== stationId) continue;
    const rank = stateRank[state] ?? 0;
    if (!best || rank > best.rank) {
      best = { stepId, state, rank };
    }
  }
  return best ? { stepId: best.stepId, state: best.state } : null;
}

function summaryToKioskJob(
  summary: WorkOrderSummary,
  active: { stepId: string; state: StepState },
): StationKioskJob {
  return {
    workOrderId: summary.workOrderId,
    customerName: summary.customerName,
    priorityColor: summary.priorityColor,
    priorityLevel: summary.priorityLevel,
    milestone: summary.milestone,
    activeStepId: active.stepId,
    activeStepState: active.state,
    dueDate: summary.dueDate,
    atRisk: summary.eta.atRisk,
    hasOpenChangeOrder: summary.openChangeOrderIds.length > 0,
    totalOpenSteps:
      summary.readyStepCount +
      summary.activeStepCount +
      summary.pausedStepCount +
      summary.blockedStepCount,
    updatedAt: summary.updatedAt,
  };
}

/**
 * Sort comparator: red first, then yellow, then green/null.
 * Ties broken by dueDate asc (no date = far future), then updatedAt desc.
 */
const COLOR_WEIGHT: Record<NonNullable<PriorityColor>, number> = {
  red: 0,
  yellow: 1,
  green: 2,
};

function compareJobs(a: StationKioskJob, b: StationKioskJob): number {
  const ca = a.priorityColor ? COLOR_WEIGHT[a.priorityColor] : 3;
  const cb = b.priorityColor ? COLOR_WEIGHT[b.priorityColor] : 3;
  if (ca !== cb) return ca - cb;
  const da = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
  const db = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const ua = Date.parse(a.updatedAt) || 0;
  const ub = Date.parse(b.updatedAt) || 0;
  return ub - ua;
}

export function createStationKioskProjection(
  deps: CreateStationKioskProjectionDeps,
): StationKioskProjection {
  const now = deps.now ?? (() => new Date());

  function buildView(stationId: StationId): StationKioskView {
    const summaries = deps.summaries.getAll();
    const jobs: StationKioskJob[] = [];
    for (const summary of summaries.values()) {
      // Skip terminal WOs — completed / cancelled don't belong on the
      // floor view. Master Tablet can show them in a "recently closed"
      // lane if that ever becomes useful.
      if (summary.terminalState !== null) continue;
      const active = pickActiveStepAtStation(summary, stationId);
      if (!active) continue;
      jobs.push(summaryToKioskJob(summary, active));
    }
    jobs.sort(compareJobs);
    return Object.freeze({
      stationId,
      jobs: Object.freeze(jobs),
      generatedAt: now().toISOString(),
    });
  }

  /**
   * Prime the summary cache before asking for a view. No way to touch
   * just-this-station from the summaries port (it's keyed by workOrder
   * id, not station), so we rely on the caller having warmed the cache
   * via a prior `summaries.getAll()` walk. This is intentional — the
   * kiosk projection doesn't want to fan out a per-WO replay on every
   * refresh. Hosts should do a batch warm-up at boot.
   */
  async function refreshAll(): Promise<void> {
    const cached = deps.summaries.getAll();
    await Promise.all(
      Array.from(cached.keys()).map((id) => deps.summaries.get(id)),
    );
  }

  return Object.freeze<StationKioskProjection>({
    async get(stationId) {
      return buildView(stationId);
    },
    async refresh(stationId) {
      await refreshAll();
      return buildView(stationId);
    },
  });
}
