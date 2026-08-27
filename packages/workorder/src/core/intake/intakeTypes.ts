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
 * PRIME Engine — Intake module types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.1 (Intake Module).
 *
 * These types are PRIME's own internal model. They are intentionally thin and
 * orthogonal to the legacy `@/modules/work-orders/types/WorkOrder` shape, which
 * has accumulated deep platform/adapter/proof/billing metadata over time.
 * PRIME treats intake as a clean domain event: "a new work order entered the
 * shop, here's what we know about it." Translation to / from the legacy
 * WorkOrder storage layer happens in an adapter — not here.
 *
 * Contract:
 * - All shapes are `readonly`. Intake inputs and drafts are value objects.
 * - Validation errors are coded (stable `IntakeValidationCode`) so UIs and
 *   downstream event consumers can switch on them without string matching.
 * - `WorkOrderDraft` is what the Intake Module hands off to the
 *   Template Resolver (§3.2). It is always in `status: "draft"`.
 */

import type { CustomerId, WorkOrderId } from "../../models/events.js";

// ---------- Priority ----------

/**
 * PRIME priority levels per spec §3.4.
 * The color system (🔴 / 🟡 / 🟢) is a render-time concern driven by
 * priority + age + due-date buffer — not a field on the intake input.
 */
export type IntakePriority = "rush" | "high" | "medium" | "low";

export const DEFAULT_INTAKE_PRIORITY: IntakePriority = "medium";

// ---------- Source ----------

/**
 * Where the intake originated. Intake accepts from any source (spec §3.1)
 * but the source is recorded for routing hints, analytics, and learning.
 */
export type IntakeSource =
  /** Supervisor / pre-production typed it in by hand. */
  | "manual"
  /** Customer accepted a quote → spawned a work order. */
  | "quote_accepted"
  /** Customer portal submission. */
  | "portal"
  /** Service ticket spawned a remake. */
  | "service_spawn"
  /** Upstream platform pushed a job via API. */
  | "api_import";

// ---------- Line items & attachments ----------

export interface IntakeLineItem {
  /** Caller-supplied or upstream id. Must be non-empty. */
  readonly id: string;
  /** Human-readable name (e.g. "24x36 acrylic sign"). */
  readonly label: string;
  /** Positive integer. */
  readonly quantity: number;
  /** Optional material selection (not a reservation — just a hint). */
  readonly materialId?: string;
  readonly notes?: string;
}

export interface IntakeAttachmentRef {
  readonly id: string;
  readonly label: string;
  readonly url?: string;
}

export interface IntakeDiscount {
  readonly id: string;
  readonly label: string;
  readonly amountUsd: number;
}

export interface IntakeSurcharge {
  readonly id: string;
  readonly label: string;
  readonly amountUsd: number;
}

// ---------- Intake input ----------

/**
 * The canonical input to `createWorkOrderUseCase.execute`. Any adapter
 * (manual entry form, quote-accepted handler, portal webhook) must
 * normalize to this shape before invoking intake.
 */
export interface IntakeInput {
  readonly customerId: CustomerId;
  readonly customerName: string;
  readonly source: IntakeSource;
  readonly lineItems: ReadonlyArray<IntakeLineItem>;
  /** ISO-8601 date (not datetime required, but must parse). */
  readonly dueDate?: string;
  /** Defaults to `DEFAULT_INTAKE_PRIORITY` when omitted. */
  readonly priority?: IntakePriority;
  readonly customerNotes?: string;
  readonly shopNotes?: string;
  readonly attachments?: ReadonlyArray<IntakeAttachmentRef>;
  readonly discounts?: ReadonlyArray<IntakeDiscount>;
  readonly surcharges?: ReadonlyArray<IntakeSurcharge>;
}

// ---------- Validation ----------

export type IntakeValidationCode =
  | "customer_id_missing"
  | "customer_name_missing"
  | "source_missing"
  | "line_items_empty"
  | "line_item_id_missing"
  | "line_item_label_missing"
  | "line_item_quantity_invalid"
  | "due_date_invalid"
  | "due_date_in_past";

export interface IntakeValidationError {
  readonly code: IntakeValidationCode;
  readonly message: string;
  /** Dot-path to the offending field, e.g. "lineItems[2].quantity". */
  readonly path: string;
}

export type IntakeValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: ReadonlyArray<IntakeValidationError> };

// ---------- Draft work order ----------

/**
 * Output of a successful intake. This is the object the Template Resolver
 * (§3.2) consumes. It carries everything Intake knows; subsequent modules
 * layer on template, routing, priority, etc. by emitting their own events.
 */
export interface WorkOrderDraft {
  readonly workOrderId: WorkOrderId;
  readonly status: "draft";
  readonly customerId: CustomerId;
  readonly customerName: string;
  readonly source: IntakeSource;
  readonly priority: IntakePriority;
  readonly lineItems: ReadonlyArray<IntakeLineItem>;
  readonly dueDate?: string;
  readonly customerNotes?: string;
  readonly shopNotes?: string;
  readonly attachments: ReadonlyArray<IntakeAttachmentRef>;
  readonly discounts: ReadonlyArray<IntakeDiscount>;
  readonly surcharges: ReadonlyArray<IntakeSurcharge>;
  /** ISO-8601 UTC timestamp assigned by the use case. */
  readonly createdAt: string;
}

// ---------- Event payloads (§16 event catalog) ----------

/**
 * Payload for `work_order.intake.created`. Kept narrow — the full draft lives
 * in the projection, the event just captures the intake-relevant facts.
 */
export interface IntakeCreatedPayload {
  readonly source: IntakeSource;
  readonly customerId: CustomerId;
  readonly customerName: string;
  readonly priority: IntakePriority;
  readonly lineItemCount: number;
  readonly dueDate?: string;
}

/**
 * Payload for `work_order.intake.validation_failed`. Carries the structured
 * errors so consumers (UI, learning layer, dashboards) can bucket without
 * re-running validation.
 */
export interface IntakeValidationFailedPayload {
  readonly source: IntakeSource;
  readonly errors: ReadonlyArray<IntakeValidationError>;
  /** Present when the intake provided a customerId, even if invalid. */
  readonly attemptedCustomerId?: string;
}
