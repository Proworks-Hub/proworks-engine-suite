// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { WorkOrderId } from "../../models/events.js";
import type { IntakeInput } from "./intakeTypes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent work-order creation.
//
// Closes E2E-03: "create-WO twice with the same idempotencyKey → one WO, one
// reservation set". Before this, no idempotency key existed anywhere in
// WorkOrderIQ, and two identical creates produced two work orders.
//
// THE CLAIM CARRIES ITS OWN TENANT, AND THAT IS DELIBERATE
//
// `IntakeInput` has no `organizationId` and `EventActor` has none either —
// WorkOrderIQ is tenant-agnostic at the intake boundary today. The mission
// requires idempotency state to obey tenant boundaries, so the claim is scoped
// explicitly rather than by restructuring WorkOrderIQ's tenancy model. Adding
// `organizationId` to `IntakeInput` would touch every caller and change what a
// work order IS, which is a wider change than this authorization covers.
//
// The consequence is worth stating plainly: two tenants may use the same
// idempotency key string and get two different work orders, which is correct.
// One tenant reusing its own key gets one.
//
// THREE OUTCOMES, NOT TWO
//
//   FIRST      no claim exists. Proceed and record.
//   REPLAY     same key, same payload. Return the original work order.
//   CONFLICT   same key, DIFFERENT payload. Refuse, explicitly.
//
// The third is the one that matters and the one a naive implementation gets
// wrong. Silently returning the original for a changed payload means a caller
// that fixed a typo and retried gets the uncorrected work order and no
// indication; silently overwriting means the first caller's work order changes
// under them. Both are worse than an error, so it is an error.
//
// WHAT COUNTS AS "MATERIALLY DIFFERENT"
//
// The fingerprint covers every field of `IntakeInput` except the key itself,
// canonicalized so that key order and array-of-object field order do not
// matter. That is deliberately conservative: a caller who changed anything at
// all gets a conflict rather than a silent replay, because deciding which
// fields are immaterial is a judgement this module cannot make for every
// caller — and being wrong about it means silently discarding a real change.
// ─────────────────────────────────────────────────────────────────────────────

/** A recorded claim on an idempotency key. */
export interface IdempotencyRecord {
  readonly organizationId: string;
  readonly key: string;
  /** The work order the first call produced. */
  readonly workOrderId: WorkOrderId;
  /** Hash of the payload that produced it. */
  readonly fingerprint: string;
  readonly claimedAt: string;
}

/**
 * Where claims live.
 *
 * A port, matching how every other durable thing in these engines works —
 * `StockLedger`, `ReservationStore`, `EventLog` are all host-supplied. Survival
 * across restart is therefore the host's to provide, exactly as stock levels
 * are: bind a database-backed store and claims persist; bind the in-memory one
 * and they do not.
 *
 * `claim` is the concurrency primitive. It must be atomic in the host's
 * implementation — check-and-insert in one operation — because two concurrent
 * creates with one key are precisely the case this exists for. The in-memory
 * implementation below is atomic by virtue of JavaScript's single-threaded
 * execution; a SQL implementation should use an insert with a unique
 * constraint and treat the violation as `existing`.
 */
export interface IdempotencyStore {
  /**
   * Atomically claims a key, or returns the claim that already holds it.
   *
   * Returns `{ claimed: true }` when this caller won, `{ claimed: false,
   * existing }` when somebody else already holds it.
   */
  claim(record: IdempotencyRecord): Promise<
    { claimed: true } | { claimed: false; existing: IdempotencyRecord }
  >;
  get(organizationId: string, key: string): Promise<IdempotencyRecord | null>;
}

/** An in-memory store. Atomic because JavaScript is single-threaded. */
export function createInMemoryIdempotencyStore(): IdempotencyStore & { clear(): void } {
  const claims = new Map<string, IdempotencyRecord>();
  const scopedKey = (organizationId: string, key: string) => `${organizationId}::${key}`;

  return {
    async claim(record) {
      const k = scopedKey(record.organizationId, record.key);
      const existing = claims.get(k);
      // Check and insert with no `await` between them. An await here would open
      // the window this method exists to close.
      if (existing) return { claimed: false, existing };
      claims.set(k, record);
      return { claimed: true };
    },
    async get(organizationId, key) {
      return claims.get(scopedKey(organizationId, key)) ?? null;
    },
    clear() {
      claims.clear();
    },
  };
}

/** The idempotency scope a caller supplies alongside the intake input. */
export interface IdempotencyClaim {
  readonly organizationId: string;
  readonly key: string;
}

/**
 * Canonical fingerprint of an intake payload.
 *
 * IT IS THE CANONICAL STRING ITSELF, NOT A HASH.
 *
 * My first version hashed it with `node:crypto`. The portability guard refused:
 * WorkOrderIQ is one of the PURE_PACKAGES, which may not import a Node builtin
 * — a pure engine that needs `node:crypto` does not run in a browser, a worker,
 * or Deno, and the suite is right to stop it.
 *
 * Reaching for a hand-rolled hash instead would have been the wrong repair. A
 * weak hash can COLLIDE, and a collision here means two different payloads
 * share a fingerprint, so the second silently receives the first's work order —
 * the precise failure this whole change exists to prevent, reintroduced by the
 * fix for it.
 *
 * An exact string comparison cannot collide. It costs storage proportional to
 * the payload, which for an idempotency claim is a fair trade and has the
 * side benefit that a conflict can be diffed by a human rather than compared as
 * two opaque digests.
 *
 * Key order is sorted at every level, because the same payload serialized two
 * ways must compare equal — otherwise a caller retrying with a
 * differently-ordered object gets a spurious conflict. Arrays keep their order,
 * because the order of line items is meaningful.
 */
export function fingerprintIntake(input: IntakeInput): string {
  const canonical = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  };

  return canonical(input);
}

export const IDEMPOTENCY_CONFLICT = "idempotency_key_conflict" as const;

/** What a conflict says. Exported so a caller can match on it. */
export interface IdempotencyConflict {
  readonly code: typeof IDEMPOTENCY_CONFLICT;
  readonly key: string;
  readonly organizationId: string;
  /** The work order the key already resolves to. */
  readonly existingWorkOrderId: WorkOrderId;
  readonly message: string;
}

export function conflictFor(
  claim: IdempotencyClaim,
  existing: IdempotencyRecord,
): IdempotencyConflict {
  return {
    code: IDEMPOTENCY_CONFLICT,
    key: claim.key,
    organizationId: claim.organizationId,
    existingWorkOrderId: existing.workOrderId,
    message:
      `Idempotency key "${claim.key}" already resolves to work order ${existing.workOrderId} for a different payload. ` +
      "Returning the original would silently discard this request's changes; overwriting it would change a work order " +
      "under whoever created it. Use a new key, or resend the original payload.",
  };
}
