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
 * PRIME Engine — Phase 2 Batch X — Customer-facing projection.
 *
 * External-safe view of a work order: what we show the CUSTOMER, not
 * what the shop sees internally. Deliberately narrow — no station
 * names, no step-level detail, no operator IDs, no internal priority
 * color / risk reasons. Customer-facing language only ("We're making
 * your order" beats "in_production step s-4 at Laser #2").
 *
 * The output is the Pizza-Hut-style milestone bar:
 *
 *     Ordered → Proof sent → Approved → In production → Packing → Shipped
 *
 * Each customer-facing phase maps from one or more internal milestones
 * so future changes to PRIME's internal milestone taxonomy don't leak
 * to the customer surface. The mapping lives in `internalToCustomerPhase`
 * below — that's the one knob to turn when the marketing / UX team
 * wants to rename a phase without touching the event model.
 *
 * Spec: PRIME-ENGINE-SPEC.md §8 (Role Views) — Customer entry.
 *
 * Not in scope (explicit):
 *   - Delivery tracking numbers — owned by shipping integration module.
 *   - Proof preview URLs — owned by Proofs module; this projection just
 *     signals "there's a proof to review" via the phase name.
 *   - Payment status — not a PRIME concern; billing module owns it.
 */

import type { WorkOrderId } from "../models/events.js";
import type { Milestone } from "../core/tracking/trackingTypes.js";

import type { WorkOrderSummary } from "./workOrderSummaryTypes.js";
import type { WorkOrderSummaryProjection } from "./createWorkOrderSummaryProjection.js";

// ---------- Customer-facing phase enum ----------

/**
 * The six phases the customer sees. Kept tight — each one is
 * something the customer can look at and immediately understand
 * "where my order is right now." Do not add implementation-detail
 * phases here; PRIME's internal milestones stay internal.
 *
 * If the customer order is cancelled we collapse to `cancelled` —
 * not shown as a phase in the bar, but returned as the view's
 * `currentPhase` so the UI can render a terminal message instead
 * of the normal progress bar.
 */
export type CustomerPhase =
  | "ordered"
  | "proof_sent"
  | "proof_approved"
  | "in_production"
  | "packing"
  | "shipped"
  | "cancelled";

export const CUSTOMER_PHASE_ORDER: ReadonlyArray<CustomerPhase> = Object.freeze([
  "ordered",
  "proof_sent",
  "proof_approved",
  "in_production",
  "packing",
  "shipped",
]);

/**
 * Map from PRIME's internal `Milestone` to the customer-facing phase.
 * Explicit so the compiler catches any future milestone value we haven't
 * mapped. `proof_sent` and `proof_approved` don't currently have their
 * own internal milestones — those come from the Proofs module. Until
 * the Proofs module emits events we can subscribe to, we leave the
 * customer at `ordered` until `in_production` begins; this is the
 * "proof skipped or fast-approved" path. A future batch wires in the
 * proofs module's events to differentiate.
 */
const MILESTONE_TO_PHASE: Readonly<Record<Milestone, CustomerPhase>> = {
  intake: "ordered",
  routed: "ordered",
  in_production: "in_production",
  quality_check: "in_production",
  ready_for_pickup: "packing",
  completed: "shipped",
};

// ---------- View shape ----------

export interface CustomerView {
  readonly workOrderId: WorkOrderId;
  readonly customerName: string;
  readonly currentPhase: CustomerPhase;
  /** Zero-based index into `CUSTOMER_PHASE_ORDER`, or `-1` if cancelled. */
  readonly currentPhaseIndex: number;
  /**
   * Percent complete — useful for rendering a progress bar without
   * iterating phase order. 0–100 inclusive. Cancelled orders return 0.
   */
  readonly percentComplete: number;
  /** ISO-8601 — customer-facing "expected by" date. Null if not yet computed. */
  readonly estimatedCompletionAt: string | null;
  /**
   * Soft flag — "your order is running a bit late" without leaking
   * internal risk reason detail. True iff the ETA has slipped past
   * the due date or atRisk fired. We never tell the customer *why*
   * (staff shortage, station down) — just that it's running behind.
   */
  readonly runningBehind: boolean;
  /** ISO-8601 — when this snapshot was computed. */
  readonly generatedAt: string;
}

// ---------- Projection port ----------

export interface CustomerProjection {
  get(workOrderId: WorkOrderId): Promise<CustomerView | null>;
  refresh(workOrderId: WorkOrderId): Promise<CustomerView | null>;
}

export interface CreateCustomerProjectionDeps {
  readonly summaries: WorkOrderSummaryProjection;
  readonly now?: () => Date;
}

// ---------- Factory ----------

function percentForPhase(phase: CustomerPhase): number {
  if (phase === "cancelled") return 0;
  const idx = CUSTOMER_PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 0;
  // Evenly spaced across the bar, with "shipped" landing at 100.
  const total = CUSTOMER_PHASE_ORDER.length - 1;
  return Math.round((idx / total) * 100);
}

function summaryToCustomerView(
  summary: WorkOrderSummary,
  generatedAt: string,
): CustomerView {
  let phase: CustomerPhase;
  if (summary.terminalState === "cancelled") {
    phase = "cancelled";
  } else if (summary.terminalState === "completed") {
    phase = "shipped";
  } else {
    phase = MILESTONE_TO_PHASE[summary.milestone] ?? "ordered";
  }
  const phaseIndex =
    phase === "cancelled" ? -1 : CUSTOMER_PHASE_ORDER.indexOf(phase);
  const runningBehind = computeRunningBehind(summary);
  return Object.freeze({
    workOrderId: summary.workOrderId,
    customerName: summary.customerName,
    currentPhase: phase,
    currentPhaseIndex: phaseIndex,
    percentComplete: percentForPhase(phase),
    estimatedCompletionAt: summary.eta.estimatedCompletionAt,
    runningBehind,
    generatedAt,
  });
}

/**
 * Determine the "running behind" flag without leaking internal details.
 * Two triggers:
 *   1. Tracking projection marked the ETA as at_risk.
 *   2. The due date is already in the past and we're not yet in a
 *      terminal state (completed / cancelled).
 * Either one flips the flag; the customer sees a single soft banner.
 */
function computeRunningBehind(summary: WorkOrderSummary): boolean {
  if (summary.terminalState !== null) return false;
  if (summary.eta.atRisk) return true;
  if (summary.dueDate) {
    const dueMs = Date.parse(summary.dueDate);
    if (Number.isFinite(dueMs) && dueMs < Date.now()) return true;
  }
  return false;
}

export function createCustomerProjection(
  deps: CreateCustomerProjectionDeps,
): CustomerProjection {
  const now = deps.now ?? (() => new Date());

  async function build(
    workOrderId: WorkOrderId,
    source: WorkOrderSummary | null,
  ): Promise<CustomerView | null> {
    const summary = source ?? (await deps.summaries.get(workOrderId));
    if (!summary) return null;
    return summaryToCustomerView(summary, now().toISOString());
  }

  return Object.freeze<CustomerProjection>({
    async get(workOrderId) {
      const summary = await deps.summaries.get(workOrderId);
      return build(workOrderId, summary);
    },
    async refresh(workOrderId) {
      const summary = await deps.summaries.refresh(workOrderId);
      return build(workOrderId, summary);
    },
  });
}
