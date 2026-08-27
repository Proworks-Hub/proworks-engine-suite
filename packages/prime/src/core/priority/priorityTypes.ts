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
 * PRIME Engine — Priority types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.4 (Priority Module).
 *
 * Priority has three outputs:
 *   1. `priorityLevel` — categorical (rush/high/medium/low). Comes from intake
 *      or a bump decision.
 *   2. `priorityScore` — numeric. What queues and dashboards sort by. Derived
 *      from level + aging + due-date urgency.
 *   3. `priorityColor` — 🔴/🟡/🟢 for UI. Derived from level + due-date risk.
 *
 * Color and score are SNAPSHOTTED onto the `PrioritizedStep` at assignment
 * time. This matches the event-sourced model: priority.assigned captures a
 * point-in-time decision. When state changes (aging, due-date nearness,
 * supervisor bump) a new event fires.
 *
 * Phase 1 scope:
 * - `work_order.priority.assigned` only.
 * - `priority.escalated` / `priority.deescalated` — deferred.
 * - Customer-tier bumps, upstream-delay inputs — deferred.
 */

import type { WorkOrderId } from "../../models/events.js";
import type { RoutedStep } from "../routing/routingTypes.js";

// ---------- Priority primitives ----------

export type PriorityLevel = "rush" | "high" | "medium" | "low";

export type PriorityColor = "red" | "yellow" | "green";

/** Numeric score. Higher = earlier. Queues sort on this. */
export type PriorityScore = number;

/**
 * Why a particular priority score landed where it did. Kept on the
 * prioritized step for audit and the learning layer.
 */
export interface PriorityScoreBreakdown {
  readonly base: number;
  readonly agingBump: number;
  readonly dueDateUrgency: number;
  readonly total: number;
}

// ---------- Prioritized step (output) ----------

/**
 * A routed step augmented with priority. Consumers (Task Flow, station
 * queues, customer-facing ETA) take these.
 *
 * `workOrderId` is promoted onto the step here — Priority is the first layer
 * in the pipeline that reasons across WOs, not just within one.
 */
export interface PrioritizedStep {
  readonly tentativeStepId: string;
  readonly workOrderId: WorkOrderId;
  readonly stationId: string;
  readonly lineItemId: string;
  readonly templateId: string;
  readonly templateStepId: string;
  readonly label: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly optional: boolean;
  readonly estimatedDurationMinutes?: number;

  readonly priorityLevel: PriorityLevel;
  readonly priorityScore: PriorityScore;
  readonly priorityColor: PriorityColor;
  readonly priorityScoreBreakdown: PriorityScoreBreakdown;

  /** ISO-8601. Mirror of the parent WO's due date, snapshotted for sort stability. */
  readonly dueDate?: string;
}

// ---------- Use-case input ----------

export interface AssignPriorityInput {
  readonly workOrderId: WorkOrderId;
  readonly priorityLevel: PriorityLevel;
  /** ISO-8601. Needed for aging bump. */
  readonly createdAt: string;
  /** ISO-8601. Optional — absent means "no due date", no urgency bump. */
  readonly dueDate?: string;
  readonly routedSteps: ReadonlyArray<RoutedStep>;
}

// ---------- Event payloads (§16 event catalog) ----------

export interface PriorityAssignedPayload {
  readonly priorityLevel: PriorityLevel;
  readonly priorityScore: PriorityScore;
  readonly priorityColor: PriorityColor;
  readonly scoreBreakdown: PriorityScoreBreakdown;
  readonly stepCount: number;
  readonly dueDate?: string;
}

/** Payload shape for the (deferred) `work_order.priority.escalated` event. */
export interface PriorityEscalatedPayload {
  readonly fromLevel: PriorityLevel;
  readonly toLevel: PriorityLevel;
  readonly reason: "aging" | "due_date_risk" | "manual" | "advisory_accepted";
  readonly scoreDelta: number;
}

/** Payload shape for the (deferred) `work_order.priority.deescalated` event. */
export interface PriorityDeescalatedPayload {
  readonly fromLevel: PriorityLevel;
  readonly toLevel: PriorityLevel;
  readonly reason: "manual" | "advisory_accepted";
  readonly scoreDelta: number;
}
