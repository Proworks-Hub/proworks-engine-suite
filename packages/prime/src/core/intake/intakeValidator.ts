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
 * PRIME Engine — Intake Validator
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.1.
 *
 * Pure function. No I/O, no clock beyond what's injected. Enumerates ALL
 * errors it finds (does not bail on first). This lets UIs show every field
 * that needs attention in a single pass.
 *
 * Contract:
 * - Input is treated as untrusted (may have been built from a form, JSON
 *   payload, or upstream webhook).
 * - Returns a discriminated union — callers switch on `result.valid`.
 * - Never mutates input.
 * - Uses an injected `now` so tests are deterministic and so the same
 *   validator can run "at intake time" (server clock) or "at replay time"
 *   (event-timestamp clock) without re-tripping the due-date check.
 */

import type {
  IntakeInput,
  IntakeValidationError,
  IntakeValidationResult,
} from "./intakeTypes.js";

export function validateIntakeInput(
  input: IntakeInput,
  now: Date = new Date()
): IntakeValidationResult {
  const errors: IntakeValidationError[] = [];

  // ---- Customer identity ----
  if (!isNonEmptyString(input.customerId)) {
    errors.push({
      code: "customer_id_missing",
      message: "customerId is required",
      path: "customerId",
    });
  }
  if (!isNonEmptyString(input.customerName)) {
    errors.push({
      code: "customer_name_missing",
      message: "customerName is required",
      path: "customerName",
    });
  }

  // ---- Source ----
  if (!isNonEmptyString(input.source)) {
    errors.push({
      code: "source_missing",
      message: "source is required",
      path: "source",
    });
  }

  // ---- Line items ----
  if (!input.lineItems || input.lineItems.length === 0) {
    errors.push({
      code: "line_items_empty",
      message: "at least one line item is required",
      path: "lineItems",
    });
  } else {
    input.lineItems.forEach((item, idx) => {
      if (!isNonEmptyString(item?.id)) {
        errors.push({
          code: "line_item_id_missing",
          message: "line item id is required",
          path: `lineItems[${idx}].id`,
        });
      }
      if (!isNonEmptyString(item?.label)) {
        errors.push({
          code: "line_item_label_missing",
          message: "line item label is required",
          path: `lineItems[${idx}].label`,
        });
      }
      if (!isPositiveInteger(item?.quantity)) {
        errors.push({
          code: "line_item_quantity_invalid",
          message: "line item quantity must be a positive integer",
          path: `lineItems[${idx}].quantity`,
        });
      }
    });
  }

  // ---- Due date (optional, but if present must be valid + not in past) ----
  if (input.dueDate !== undefined) {
    const parsed = new Date(input.dueDate);
    if (Number.isNaN(parsed.getTime())) {
      errors.push({
        code: "due_date_invalid",
        message: "dueDate must be a valid ISO-8601 date",
        path: "dueDate",
      });
    } else if (parsed.getTime() < startOfDay(now).getTime()) {
      errors.push({
        code: "due_date_in_past",
        message: "dueDate cannot be before today",
        path: "dueDate",
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------- helpers ----------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/**
 * Normalize `now` to the start of its UTC day so a dueDate of "today" is
 * not rejected as "in the past" just because `now` happens to be later
 * in the same day.
 */
function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
}
