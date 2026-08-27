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
 * PRIME Engine — Phase 2 Batch W — MasterTablet projection.
 *
 * Supervisor-facing shop-wide view. Answers: "what's live, what's
 * slipping, what needs a decision?" Opposite scope from StationKiosk
 * (which is single-station) — this is everybody's jobs in one feed,
 * with color-coded priority, blocker counts, and pending-change-order
 * flags so a supervisor can triage without opening each WO.
 *
 * Like StationKioskProjection this is a DERIVED projection over the
 * WorkOrderSummaryProjection — no event fold of its own. The only
 * thing we do here is narrow + sort + aggregate counts. Phase-3
 * upgrades (decision-aware actions, reroute suggestions, station load
 * live dashboard) layer on top without touching this file.
 *
 * Spec: PRIME-ENGINE-SPEC.md §8 (Role Views) — Master Tablet entry.
 */

import type { WorkOrderId } from "../models/events.js";
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
 * Narrowed supervisor-view row. Aggregated step counts let the
 * supervisor see "3 paused, 1 blocked" without having to dig into the
 * per-step list. Keep this tight — adding more fields makes the live
 * dashboard chatty and harder to scan at a glance.
 */
export interface MasterTabletJob {
  readonly workOrderId: WorkOrderId;
  readonly customerName: string;
  readonly priorityColor: PriorityColor | null;
  readonly priorityLevel: PriorityLevel | null;
  readonly milestone: Milestone;
  readonly dueDate: string | null;
  /** ISO-8601 from the tracking projection's ETA field. */
  readonly estimatedCompletionAt: string | null;
  readonly atRisk: boolean;
  readonly riskReasons: ReadonlyArray<EtaRiskReason>;
  readonly activeStepCount: number;
  readonly readyStepCount: number;
  readonly pausedStepCount: number;
  readonly blockedStepCount: number;
  readonly openChangeOrderCount: number;
  readonly reworkCount: number;
  readonly issueFlagCount: number;
  /** ISO-8601 — from the most-recently-folded event in the summary. */
  readonly updatedAt: string;
}

export interface MasterTabletView {
  readonly jobs: ReadonlyArray<MasterTabletJob>;
  /** Count of open (non-terminal) WOs surfaced on this view. */
  readonly totalOpen: number;
  /** Open WOs whose ETA confidence is `at_risk`. */
  readonly totalAtRisk: number;
  /** Open WOs with at least one blocked step. */
  readonly totalBlocked: number;
  /** Open WOs with a red priority color. Supervisor's "do-this-now" count. */
  readonly totalRed: number;
  /** Open WOs with one or more pending change orders. */
  readonly totalPendingChanges: number;
  /** ISO-8601 — when this view was assembled. */
  readonly generatedAt: string;
}

// ---------- Projection port ----------

export interface MasterTabletProjection {
  get(): Promise<MasterTabletView>;
  /**
   * Touch the summary cache before building the view. Same tradeoff
   * note as StationKioskProjection.refresh — hosts should still do a
   * batch warm-up at boot so per-WO replays don't fan out on every
   * invocation.
   */
  refresh(): Promise<MasterTabletView>;
}

// ---------- Deps ----------

export interface CreateMasterTabletProjectionDeps {
  readonly summaries: WorkOrderSummaryProjection;
  readonly now?: () => Date;
}

// ---------- Factory ----------

function summaryToMasterJob(summary: WorkOrderSummary): MasterTabletJob {
  return {
    workOrderId: summary.workOrderId,
    customerName: summary.customerName,
    priorityColor: summary.priorityColor,
    priorityLevel: summary.priorityLevel,
    milestone: summary.milestone,
    dueDate: summary.dueDate,
    estimatedCompletionAt: summary.eta.estimatedCompletionAt,
    atRisk: summary.eta.atRisk,
    riskReasons: summary.eta.riskReasons,
    activeStepCount: summary.activeStepCount,
    readyStepCount: summary.readyStepCount,
    pausedStepCount: summary.pausedStepCount,
    blockedStepCount: summary.blockedStepCount,
    openChangeOrderCount: summary.openChangeOrderIds.length,
    reworkCount: summary.reworkCount,
    issueFlagCount: summary.issueFlagCount,
    updatedAt: summary.updatedAt,
  };
}

const COLOR_WEIGHT: Record<NonNullable<PriorityColor>, number> = {
  red: 0,
  yellow: 1,
  green: 2,
};

/**
 * Supervisor sort: red at the top, then blocked jobs (needs action),
 * then by due date asc, then recent activity first. Blocked is ranked
 * high regardless of color because a blocked job is actively costing
 * shop throughput.
 */
function compareMasterJobs(a: MasterTabletJob, b: MasterTabletJob): number {
  // Red before anything else.
  const ca = a.priorityColor ? COLOR_WEIGHT[a.priorityColor] : 3;
  const cb = b.priorityColor ? COLOR_WEIGHT[b.priorityColor] : 3;
  if (ca !== cb) return ca - cb;
  // Blocked jobs bubble above their color peers.
  const ba = a.blockedStepCount > 0 ? 0 : 1;
  const bb = b.blockedStepCount > 0 ? 0 : 1;
  if (ba !== bb) return ba - bb;
  // Then at-risk.
  const ra = a.atRisk ? 0 : 1;
  const rb = b.atRisk ? 0 : 1;
  if (ra !== rb) return ra - rb;
  // Due date asc.
  const da = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
  const db = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  // Most recent activity first.
  const ua = Date.parse(a.updatedAt) || 0;
  const ub = Date.parse(b.updatedAt) || 0;
  return ub - ua;
}

export function createMasterTabletProjection(
  deps: CreateMasterTabletProjectionDeps,
): MasterTabletProjection {
  const now = deps.now ?? (() => new Date());

  function buildView(): MasterTabletView {
    const summaries = deps.summaries.getAll();
    const jobs: MasterTabletJob[] = [];
    let totalOpen = 0;
    let totalAtRisk = 0;
    let totalBlocked = 0;
    let totalRed = 0;
    let totalPendingChanges = 0;
    for (const summary of summaries.values()) {
      if (summary.terminalState !== null) continue;
      totalOpen++;
      const row = summaryToMasterJob(summary);
      if (row.atRisk) totalAtRisk++;
      if (row.blockedStepCount > 0) totalBlocked++;
      if (row.priorityColor === "red") totalRed++;
      if (row.openChangeOrderCount > 0) totalPendingChanges++;
      jobs.push(row);
    }
    jobs.sort(compareMasterJobs);
    return Object.freeze({
      jobs: Object.freeze(jobs),
      totalOpen,
      totalAtRisk,
      totalBlocked,
      totalRed,
      totalPendingChanges,
      generatedAt: now().toISOString(),
    });
  }

  async function refreshAll(): Promise<void> {
    const cached = deps.summaries.getAll();
    await Promise.all(
      Array.from(cached.keys()).map((id) => deps.summaries.get(id)),
    );
  }

  return Object.freeze<MasterTabletProjection>({
    async get() {
      return buildView();
    },
    async refresh() {
      await refreshAll();
      return buildView();
    },
  });
}
