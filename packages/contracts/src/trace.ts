// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Tying one piece of work together across engines.
//
// A single customer action already crosses three engines — ForgeIQ proposes a
// route, CostIQ prices it, Prime decides on it — and today nothing connects
// those three results to each other. When a quote comes out wrong, there is no
// thread to pull.
//
// This is added now rather than later for a blunt reason: these contracts are
// published. Threading a correlation id through them after hosts depend on them
// means a breaking version bump per engine. Optional today costs nothing;
// retrofitted tomorrow costs a coordinated release.
//
// The shape is deliberately OpenTelemetry-compatible without depending on it.
// A host already running OTel maps `traceId` straight across; a host running
// nothing still gets a correlation id it can grep for.
// ─────────────────────────────────────────────────────────────────────────────

export const traceContextSchema = z
  .object({
    /**
     * One unit of work, however many engines it touches. Every result and event
     * produced while serving one request shares this.
     */
    correlationId: z.string().min(1),
    /**
     * What directly caused this. Correlation says which workflow; causation
     * says which step — the difference between knowing a quote is wrong and
     * knowing that the cost call is what made it wrong.
     */
    causationId: z.string().min(1).optional(),
    /** W3C / OpenTelemetry trace id, when the host propagates one. */
    traceId: z.string().min(1).optional(),
    /** The span within that trace. */
    spanId: z.string().min(1).optional(),
  })
  .strict();
export type TraceContext = z.infer<typeof traceContextSchema>;

/**
 * Starts a new correlation. Called once, by whoever receives the original
 * request; everything downstream inherits it rather than minting its own.
 *
 * Uses `crypto.randomUUID` where available and falls back otherwise, so this
 * works in Node, in a browser, and in a test with neither. Feature-detected
 * rather than imported, because an engine that imports `node:crypto` stops
 * being portable — and the architecture guard now refuses that outright.
 */
export function newCorrelationId(prefix = "cor"): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") return `${prefix}_${g.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Derives the context for a step caused by a previous one.
 *
 * Keeps the correlation and trace, and sets causation to the step that led
 * here — so a chain reads forwards without anyone having to reconstruct it:
 *
 *   configuration accepted → plan generated → cost calculated → decision made
 */
export function causedBy(parent: TraceContext, causationId: string): TraceContext {
  return {
    correlationId: parent.correlationId,
    causationId,
    ...(parent.traceId ? { traceId: parent.traceId } : {}),
    ...(parent.spanId ? { spanId: parent.spanId } : {}),
  };
}

/**
 * A trace context for work with no upstream request — a scheduled sweep, a
 * backfill, a worker picking up its own queue.
 *
 * Named so these are obvious in a log. Untraceable background work is how
 * "where did this row come from?" becomes unanswerable.
 */
export function newBackgroundTrace(reason: string): TraceContext {
  return { correlationId: newCorrelationId(`bg-${reason}`) };
}
