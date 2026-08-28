// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { IDENTITY_FIELD_WORDS, type PlatformEvent } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Following one piece of work across the engines.
//
// This is the console's most powerful feature and its most dangerous one. A
// distributed trace is, by construction, a complete record of what a customer
// ordered, what it cost, and who they are — assembled in one place, on a screen
// that may well be on a wall.
//
// So the rule is inverted from the usual: PAYLOADS ARE HIDDEN BY DEFAULT and
// revealed only on a deliberate, permissioned action. Not hidden behind a
// collapsed section that a click expands, and not "hidden" by being small.
// Absent from the response entirely unless someone asked for them and was
// allowed to.
//
// The default trace view — timings, routes, results, errors — answers almost
// every operational question without a single field of customer data.
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceEntry {
  readonly eventId: string;
  readonly eventType: string;
  readonly source: string;
  readonly destination?: string;
  readonly occurredAt: string;
  /** Since the first event in the trace. What makes a waterfall readable. */
  readonly offsetMs: number;
  /** Until the next event. The closest thing to a processing time available. */
  readonly durationMs?: number;
  readonly aggregate?: { type: string; id: string };
  /** True when this event is one its engine's manifest treats as an alert. */
  readonly isFailure: boolean;
  /**
   * Whether a payload exists at all.
   *
   * Shown so an operator knows there is something to request, without the
   * request having been made for them.
   */
  readonly hasPayload: boolean;
}

export interface Trace {
  readonly correlationId: string;
  readonly entries: readonly TraceEntry[];
  readonly startedAt: string;
  readonly totalMs: number;
  readonly engines: readonly string[];
  readonly failureCount: number;
}

export interface BuildTraceOptions {
  /** Event types each engine treats as failures, from the manifests. */
  failureEventTypes?: ReadonlySet<string>;
}

/**
 * Assembles the events sharing a correlation id into an ordered trace.
 *
 * Sorted by time, not by arrival. An at-least-once bus delivers out of order
 * often enough that a trace built in receipt order regularly shows an effect
 * before its cause — and an operator who sees that once stops believing the
 * next one.
 */
export function buildTrace(
  events: readonly unknown[],
  correlationId: string,
  options: BuildTraceOptions = {},
): Trace | null {
  const failures = options.failureEventTypes ?? new Set<string>();

  const usable = events
    .filter((candidate): candidate is PlatformEvent => {
      if (candidate === null || typeof candidate !== "object") return false;
      const event = candidate as Partial<PlatformEvent>;
      return (
        typeof event.eventId === "string" &&
        typeof event.eventType === "string" &&
        typeof event.source?.service === "string" &&
        event.trace?.correlationId === correlationId
      );
    })
    .map((event) => ({
      event,
      at: Date.parse(event.occurredAt ?? event.publishedAt ?? ""),
    }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at);

  if (usable.length === 0) return null;

  const startedAt = usable[0]!.at;
  const entries: TraceEntry[] = usable.map((entry, index) => {
    const next = usable[index + 1];
    return {
      eventId: entry.event.eventId,
      eventType: entry.event.eventType,
      source: entry.event.source.service,
      occurredAt: new Date(entry.at).toISOString(),
      offsetMs: entry.at - startedAt,
      durationMs: next ? next.at - entry.at : undefined,
      aggregate: entry.event.aggregate,
      isFailure: failures.has(entry.event.eventType),
      hasPayload: entry.event.payload !== undefined && entry.event.payload !== null,
    };
  });

  return {
    correlationId,
    entries,
    startedAt: new Date(startedAt).toISOString(),
    totalMs: usable[usable.length - 1]!.at - startedAt,
    engines: [...new Set(entries.map((e) => e.source))],
    failureCount: entries.filter((e) => e.isFailure).length,
  };
}

// ── Payload inspection ───────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

/**
 * Redacts a payload for display, even to somebody allowed to see it.
 *
 * Two layers on purpose. Permission decides whether a payload is returned at
 * all; this decides what is inside it. An engineer debugging a routing failure
 * needs the shape of the order — how many lines, which product, what the
 * dimensions were. They do not need the customer's name, address or email, and
 * the fact that they are trusted with the first does not make the second
 * appropriate on a screen in an office.
 *
 * The field names start from `IDENTITY_FIELD_WORDS` in the shared contracts —
 * the same list the canonical-knowledge guard uses — and then add to it.
 *
 * The shared list alone is NOT enough here, and the reason is worth stating: it
 * was written to keep canonical records anonymous, and a canonical record is
 * about a product or a price, so it never had cause to name a customer. It has
 * no entry for `customerName`, because nothing it guards would ever carry one.
 *
 * A console payload is different: it is order data, and order data is mostly
 * about a person. So the shared list is the floor rather than the whole, and it
 * is EXTENDED here rather than edited there — widening the canonical guard
 * would change what every engine is allowed to store, to fix a console problem.
 *
 * Matched as whole words. A redactor that blanks `ownership` because it
 * contains `owner` gets switched off, and a redactor that is off redacts
 * nothing.
 */
export function redactPayload(value: unknown, depth = 0): unknown {
  // A payload deep enough to hit this is a payload nobody is reading anyway,
  // and recursion without a floor is how a console hangs on a cyclic object.
  if (depth > 8) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isIdentityField(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactPayload(entry, depth + 1);
  }
  return out;
}

/**
 * What a console payload carries that a canonical record never would.
 *
 * Order data is mostly about a person, and the words it uses for that person
 * are not the words the ownership model needed.
 */
export const CONSOLE_SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "customer", "name", "firstname", "lastname", "surname", "recipient",
  "contact", "billing", "shipping", "card", "payment", "note", "notes",
  "message", "signature", "dob", "birthdate", "passport", "licence", "license",
]);

function isIdentityField(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.some((word) => IDENTITY_FIELD_WORDS.has(word))) return true;
  if (words.some((word) => CONSOLE_SENSITIVE_WORDS.has(word))) return true;
  // `customerName` splits into two words that are each sensitive on their own,
  // but `orderNumber` must survive. The joined form catches the compounds the
  // word list would otherwise miss without blanking every field ending in a
  // common noun.
  return CONSOLE_SENSITIVE_WORDS.has(words.join(""));
}

export interface PayloadInspection {
  readonly eventId: string;
  readonly payload: unknown;
  /** Field paths that were blanked, so the redaction is visible, not silent. */
  readonly redactedFields: readonly string[];
}

/**
 * Prepares a payload for a permitted, deliberate inspection.
 *
 * Lists what it removed. A redacted view that hides its own redactions leads an
 * engineer to conclude a field was missing from the event — and then to go
 * looking for a bug in the publisher that does not exist.
 */
export function inspectPayload(event: {
  eventId: string;
  payload: unknown;
}): PayloadInspection {
  const redactedFields: string[] = [];
  collectRedactions(event.payload, "", redactedFields);
  return {
    eventId: event.eventId,
    payload: redactPayload(event.payload),
    redactedFields,
  };
}

function collectRedactions(value: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRedactions(entry, `${path}[${index}]`, out, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (isIdentityField(key)) {
      out.push(next);
      continue;
    }
    collectRedactions(entry, next, out, depth + 1);
  }
}
