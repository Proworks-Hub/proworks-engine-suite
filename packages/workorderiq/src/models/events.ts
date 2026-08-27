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
 * PRIME Engine — Event model
 *
 * Canonical `WorkOrderEvent` type and event-type discriminated union
 * per PRIME-ENGINE-SPEC.md §13 (data model) and §16 (event catalog).
 *
 * Events are the single source of truth for PRIME. The event log is append-only;
 * every other piece of state (task-flow projection, schedule projection,
 * customer milestone bar, cost actuals, learning inputs) is a projection
 * rebuildable from the log.
 *
 * Design rules:
 * 1. Events are immutable once appended. Never mutate.
 * 2. Corrections are new events that supersede; the original is kept.
 * 3. Each event carries `sequenceNumber` for monotonic ordering and
 *    `timestamp` (ISO 8601) for human readability / analytics.
 * 4. `payload` is typed per-event at call sites; the log itself treats it
 *    as opaque so new event types don't force a log-schema change.
 */

// ---------- Identifier aliases (narrow string types, stable across refactors) ----------

export type EventId = string;
export type WorkOrderId = string;
export type WorkOrderStepId = string;
export type StationId = string;
export type UserId = string;
export type CustomerId = string;

// ---------- Actors ----------

/**
 * Who (or what) caused the event. Every event must carry an actor for audit
 * and role-based filtering.
 *
 * - `user`  — a human, identified by userId and role. Covers operators,
 *             supervisors, pre-production, admin.
 * - `system` — an automated actor within Hub. `source` identifies which
 *              subsystem (e.g. "prime.routing", "prime.priority", "cost-iq",
 *              "sentinel").
 * - `customer` — an external customer acting through the portal
 *                (acknowledging a change order, confirming pickup, etc.).
 */
export type EventActor =
  | { readonly kind: "user"; readonly userId: UserId; readonly role: ActorRole }
  | { readonly kind: "system"; readonly source: string }
  | { readonly kind: "customer"; readonly customerId: CustomerId };

export type ActorRole =
  | "admin"
  | "pre_production"
  | "supervisor"
  | "operator"
  | "customer";

// ---------- Event type discriminator ----------

/**
 * Canonical event-type strings per PRIME-ENGINE-SPEC.md §16.
 * Keep in sync with the spec's event catalog. Extend only in-spec.
 */
export type WorkOrderEventType =
  // Intake
  | "work_order.intake.created"
  | "work_order.intake.validation_failed"
  // Template
  | "work_order.template.resolved"
  | "work_order.template.overridden"
  // Routing
  | "work_order.routing.assigned"
  | "work_order.routing.reroute_suggested"
  | "work_order.routing.batched_with"
  // Priority
  | "work_order.priority.assigned"
  | "work_order.priority.escalated"
  | "work_order.priority.deescalated"
  // Task Flow (step lifecycle)
  | "step.ready"
  | "step.started"
  | "step.paused"
  | "step.resumed"
  | "step.completed"
  | "step.blocked"
  | "step.issue_flagged"
  | "step.rework.logged"
  // Change / Rework / Reroute
  | "work_order.change_order.created"
  | "work_order.change_order.approved"
  | "work_order.change_order.rejected"
  | "work_order.reroute.executed"
  | "work_order.reroute.approval_requested"
  | "work_order.reroute.approval_approved"
  | "work_order.reroute.approval_rejected"
  // Change-order consequence engine (Batch V)
  | "work_order.change.applied"
  | "work_order.routing.recomputed"
  | "work_order.tasks.regenerated"
  | "work_order.eta.recalculated"
  // Tracking / Projection
  | "work_order.milestone.advanced"
  | "work_order.eta.updated"
  | "work_order.eta.at_risk"
  // Quality — what an inspection FOUND, as distinct from it having happened.
  | "quality.inspection.passed"
  | "quality.inspection.failed"
  // Packaging — the real work between "steps are done" and "a parcel exists".
  | "packaging.started"
  | "packaging.completed"
  // Terminal
  | "work_order.completed"
  | "work_order.cancelled";

// ---------- Event record ----------

/**
 * A single event in the PRIME event log.
 *
 * `TPayload` lets callers narrow the payload shape per event type at use sites
 * (e.g. `WorkOrderEvent<IntakeCreatedPayload>`). The log itself is agnostic.
 *
 * All fields are `readonly` to encode the append-only rule in the type system.
 */
export interface WorkOrderEvent<TPayload = unknown> {
  readonly id: EventId;
  /** Monotonically increasing within a single log instance. Assigned at append time. */
  readonly sequenceNumber: number;
  readonly workOrderId: WorkOrderId;
  /** Present only for step-level events. */
  readonly stepId?: WorkOrderStepId;
  readonly type: WorkOrderEventType;
  readonly actor: EventActor;
  /** ISO-8601 UTC timestamp. Assigned at append time. */
  readonly timestamp: string;
  readonly payload: TPayload;
}

/**
 * Input shape when appending an event. The log assigns `id`, `sequenceNumber`,
 * and `timestamp` — callers must not supply them.
 */
export interface AppendEventInput<TPayload = unknown> {
  readonly workOrderId: WorkOrderId;
  readonly stepId?: WorkOrderStepId;
  readonly type: WorkOrderEventType;
  readonly actor: EventActor;
  readonly payload: TPayload;
}

// ---------- Type guards ----------

export function isUserActor(
  actor: EventActor
): actor is Extract<EventActor, { kind: "user" }> {
  return actor.kind === "user";
}

export function isSystemActor(
  actor: EventActor
): actor is Extract<EventActor, { kind: "system" }> {
  return actor.kind === "system";
}

export function isCustomerActor(
  actor: EventActor
): actor is Extract<EventActor, { kind: "customer" }> {
  return actor.kind === "customer";
}
