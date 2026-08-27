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
 * PRIME Engine — Phase 2 Batch X — PreProduction projection.
 *
 * Role view for the intake / pre-production lead. This person lives
 * in the pre-production milestone: they take the order, confirm
 * scope, resolve templates, review the initial routing, and send
 * proofs. They need a single pane that shows everything inbound
 * and everything stuck before the floor picks it up.
 *
 * Scope
 * -----
 * This is a derived projection like StationKiosk / MasterTablet —
 * we narrow and filter `WorkOrderSummary` entries rather than
 * folding events ourselves. Jobs are included when they're in an
 * "inbound" milestone (intake → routed → prioritized) OR when
 * they've got open change orders or rework flags (something the
 * lead must triage even if the job has moved to production).
 *
 * Deliberately out of scope here (each owned by another module):
 *   - Actual cost numbers (CostIQ subscribes to PRIME events and
 *     maintains its own projection — we just expose the "cost-
 *     sensitive flags are set" booleans).
 *   - Per-line-item material status (Task Flow blocker payloads
 *     would be the source; surface that here in a later batch).
 *   - Proof asset URLs / customer preview links (Proofs module
 *     owns that; it'll expose its own projection for the File-
 *     ready gate).
 *
 * A future `usePrimeProjections` hook joins this with the Proofs
 * module's data for a fully-featured pre-production dashboard. This
 * projection delivers the PRIME-side half of that join.
 *
 * Spec: PRIME-ENGINE-SPEC.md §8 (Role Views).
 */

import type { WorkOrderId } from "../models/events.js";
import type { IntakePriority } from "../core/intake/intakeTypes.js";
import type {
  PriorityColor,
  PriorityLevel,
} from "../core/priority/priorityTypes.js";
import type {
  EtaRiskReason,
  Milestone,
} from "../core/tracking/trackingTypes.js";

import type { WorkOrderSummary } from "./workOrderSummaryTypes.js";
import type { WorkOrderSummaryProjection } from "./createWorkOrderSummaryProjection.js";

// ---------- View shape ----------

/**
 * One WO row on the pre-production feed. Narrower than MasterTablet
 * because the lead doesn't care about per-step state the way a
 * supervisor does — they care about "is this routed yet, are
 * customer-facing fields locked in, and are there any pending
 * changes I have to approve."
 */
export interface PreProductionJob {
  readonly workOrderId: WorkOrderId;
  readonly customerName: string;
  readonly source: string;
  readonly intakePriority: IntakePriority;
  readonly priorityColor: PriorityColor | null;
  readonly priorityLevel: PriorityLevel | null;
  readonly milestone: Milestone;
  /** ISO-8601 from the intake.created event. */
  readonly intakeAt: string;
  readonly dueDate: string | null;
  readonly estimatedCompletionAt: string | null;
  readonly atRisk: boolean;
  readonly riskReasons: ReadonlyArray<EtaRiskReason>;
  readonly lineItemCount: number;
  /** Null until routing.assigned fires. Drives the "ready for production?" badge. */
  readonly totalSteps: number | null;
  /** Count of open change orders — each is a decision the lead must make. */
  readonly openChangeOrderCount: number;
  readonly reworkCount: number;
  readonly issueFlagCount: number;
  readonly updatedAt: string;
}

/**
 * Why a particular WO surfaced in the pre-production view. Drives
 * the badge next to the row so the lead knows at a glance whether
 * to approve, triage, or confirm.
 */
export type PreProductionInclusionReason =
  /** Milestone is still pre-floor (intake / routed / prioritized). */
  | "pre_floor"
  /** One or more change orders are awaiting a decision. */
  | "pending_change_order"
  /** Rework has been logged and needs pre-production resolution. */
  | "rework_flagged"
  /** Operator-flagged issue bubbled back to pre-production for review. */
  | "issue_flagged";

export interface PreProductionRow {
  readonly job: PreProductionJob;
  readonly reasons: ReadonlyArray<PreProductionInclusionReason>;
}

export interface PreProductionView {
  readonly rows: ReadonlyArray<PreProductionRow>;
  /** WOs still at intake — the lead's first-action queue. */
  readonly intakeCount: number;
  /** WOs routed but not yet on the floor. */
  readonly pendingReleaseCount: number;
  /** WOs with at least one open change order. */
  readonly pendingChangeCount: number;
  /** WOs with reworks / issues the lead should see. */
  readonly needsTriageCount: number;
  readonly generatedAt: string;
}

// ---------- Projection port ----------

export interface PreProductionProjection {
  get(): Promise<PreProductionView>;
  refresh(): Promise<PreProductionView>;
}

export interface CreatePreProductionProjectionDeps {
  readonly summaries: WorkOrderSummaryProjection;
  readonly now?: () => Date;
}

// ---------- Factory ----------

/**
 * Milestones the lead still owns. Anything past this set means the
 * floor has picked up the WO and the lead's view drops it unless
 * there's an explicit re-entry reason (change order / rework / issue).
 *
 * Note: the exact Milestone values depend on what the tracking module
 * emits (see `trackingTypes.ts`). We reference the union type via
 * `Milestone` so TypeScript catches any rename; the runtime check is
 * a plain `Set.has`. Names here must match PRIME spec §3.7.
 */
const PRE_FLOOR_MILESTONES: ReadonlySet<Milestone> = new Set<Milestone>([
  "intake",
  "routed",
]);

function inclusionReasons(
  summary: WorkOrderSummary,
): ReadonlyArray<PreProductionInclusionReason> {
  const reasons: PreProductionInclusionReason[] = [];
  if (PRE_FLOOR_MILESTONES.has(summary.milestone)) reasons.push("pre_floor");
  if (summary.openChangeOrderIds.length > 0) reasons.push("pending_change_order");
  if (summary.reworkCount > 0) reasons.push("rework_flagged");
  if (summary.issueFlagCount > 0) reasons.push("issue_flagged");
  return Object.freeze(reasons);
}

function summaryToPreProductionJob(summary: WorkOrderSummary): PreProductionJob {
  return {
    workOrderId: summary.workOrderId,
    customerName: summary.customerName,
    source: summary.source,
    intakePriority: summary.intakePriority,
    priorityColor: summary.priorityColor,
    priorityLevel: summary.priorityLevel,
    milestone: summary.milestone,
    intakeAt: summary.createdAt,
    dueDate: summary.dueDate,
    estimatedCompletionAt: summary.eta.estimatedCompletionAt,
    atRisk: summary.eta.atRisk,
    riskReasons: summary.eta.riskReasons,
    lineItemCount: summary.lineItemCount,
    totalSteps: summary.totalSteps,
    openChangeOrderCount: summary.openChangeOrderIds.length,
    reworkCount: summary.reworkCount,
    issueFlagCount: summary.issueFlagCount,
    updatedAt: summary.updatedAt,
  };
}

/**
 * Sort: pending-change first (something to decide), then pre-floor
 * intakes oldest-first (oldest is most at-risk of slipping), then
 * triage items by updatedAt desc (most recent issue first).
 */
function comparePreProductionRows(a: PreProductionRow, b: PreProductionRow): number {
  const aPending = a.reasons.includes("pending_change_order") ? 0 : 1;
  const bPending = b.reasons.includes("pending_change_order") ? 0 : 1;
  if (aPending !== bPending) return aPending - bPending;

  const aPreFloor = a.reasons.includes("pre_floor") ? 0 : 1;
  const bPreFloor = b.reasons.includes("pre_floor") ? 0 : 1;
  if (aPreFloor !== bPreFloor) return aPreFloor - bPreFloor;

  // Within pre-floor, oldest intake first.
  if (aPreFloor === 0 && bPreFloor === 0) {
    const ia = Date.parse(a.job.intakeAt) || 0;
    const ib = Date.parse(b.job.intakeAt) || 0;
    if (ia !== ib) return ia - ib;
  }

  const ua = Date.parse(a.job.updatedAt) || 0;
  const ub = Date.parse(b.job.updatedAt) || 0;
  return ub - ua;
}

export function createPreProductionProjection(
  deps: CreatePreProductionProjectionDeps,
): PreProductionProjection {
  const now = deps.now ?? (() => new Date());

  function buildView(): PreProductionView {
    const summaries = deps.summaries.getAll();
    const rows: PreProductionRow[] = [];
    let intakeCount = 0;
    let pendingReleaseCount = 0;
    let pendingChangeCount = 0;
    let needsTriageCount = 0;

    for (const summary of summaries.values()) {
      // Terminal WOs leave the lead's scope entirely.
      if (summary.terminalState !== null) continue;
      const reasons = inclusionReasons(summary);
      if (reasons.length === 0) continue; // on the floor, nothing to do here
      rows.push({
        job: summaryToPreProductionJob(summary),
        reasons,
      });

      if (summary.milestone === "intake") intakeCount++;
      if (summary.milestone === "routed") pendingReleaseCount++;
      if (summary.openChangeOrderIds.length > 0) pendingChangeCount++;
      if (summary.reworkCount > 0 || summary.issueFlagCount > 0) needsTriageCount++;
    }

    rows.sort(comparePreProductionRows);

    return Object.freeze({
      rows: Object.freeze(rows),
      intakeCount,
      pendingReleaseCount,
      pendingChangeCount,
      needsTriageCount,
      generatedAt: now().toISOString(),
    });
  }

  async function refreshAll(): Promise<void> {
    const cached = deps.summaries.getAll();
    await Promise.all(
      Array.from(cached.keys()).map((id) => deps.summaries.get(id)),
    );
  }

  return Object.freeze<PreProductionProjection>({
    async get() {
      return buildView();
    },
    async refresh() {
      await refreshAll();
      return buildView();
    },
  });
}
