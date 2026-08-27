// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { TraceContext } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Following one request through several engines.
//
// The correlation id added earlier answers "which work was this part of?".
// A span answers the next question: "and where did the time go?" — the one
// asked when a quote takes nine seconds and four engines were involved.
//
// Shaped to match OpenTelemetry without depending on it. A host already running
// OTel adapts this in a few lines; a host running nothing gets a working
// in-memory tracer and no new dependency. An engine that imported an OTel SDK
// would drag a whole telemetry stack along with it, and the purity guard would
// refuse it anyway.
// ─────────────────────────────────────────────────────────────────────────────

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;

  setAttribute(key: string, value: string | number | boolean): void;
  /** A point in time within the span — a retry taken, a cache miss. */
  addEvent(name: string, attributes?: SpanAttributes): void;
  setStatus(status: SpanStatus, message?: string): void;
  recordException(error: Error): void;
  end(): void;

  /** The context to pass across a boundary so the next hop joins this trace. */
  context(): TraceContext;
}

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: SpanAttributes;
  /** The span this one sits under. Absent starts a new trace. */
  parent?: TraceContext;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

/** Does nothing, and costs nothing. The default for an engine with no host tracer. */
export const NOOP_SPAN: Span = {
  spanId: "noop",
  traceId: "noop",
  name: "noop",
  kind: "internal",
  setAttribute: () => {},
  addEvent: () => {},
  setStatus: () => {},
  recordException: () => {},
  end: () => {},
  context: () => ({ correlationId: "noop" }),
};

export const NOOP_TRACER: Tracer = { startSpan: () => NOOP_SPAN };

/**
 * Runs work inside a span, ending it whether the work succeeds or throws.
 *
 * The manual version — start, end, remember the catch — reliably leaks spans on
 * the error path, which is the path you most want to see.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  work: (span: Span) => Promise<T> | T,
  options?: StartSpanOptions,
): Promise<T> {
  const span = tracer.startSpan(name, options);
  try {
    const result = await work(span);
    span.setStatus("ok");
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    span.recordException(error);
    span.setStatus("error", error.message);
    throw error;
  } finally {
    span.end();
  }
}

// ── Propagation ──────────────────────────────────────────────────────────────

/** The W3C header a trace travels in, so any compliant system can join it. */
export const TRACEPARENT_HEADER = "traceparent";

/**
 * Formats a trace context as a W3C `traceparent`.
 *
 * Returns undefined when there is no trace id — a malformed header is worse
 * than none, because a receiver will try to parse it and start a broken trace.
 */
export function toTraceparent(context: TraceContext): string | undefined {
  if (!context.traceId || !context.spanId) return undefined;
  return `00-${context.traceId}-${context.spanId}-01`;
}

/** Parses a `traceparent`, returning undefined for anything malformed. */
export function fromTraceparent(header: string, correlationId: string): TraceContext | undefined {
  const parts = header.trim().split("-");
  if (parts.length !== 4 || parts[0] !== "00") return undefined;
  const [, traceId, spanId] = parts;
  if (!traceId || !spanId || traceId.length !== 32 || spanId.length !== 16) return undefined;
  return { correlationId, traceId, spanId };
}

/**
 * The headers to send with an outbound call so the far side joins this trace.
 *
 * Carries the correlation id alongside the W3C header, because correlation
 * survives a hop that drops traceparent — and something surviving is better
 * than the whole thread breaking at one badly behaved proxy.
 */
export function propagationHeaders(context: TraceContext): Record<string, string> {
  const headers: Record<string, string> = { "x-correlation-id": context.correlationId };
  const traceparent = toTraceparent(context);
  if (traceparent) headers[TRACEPARENT_HEADER] = traceparent;
  if (context.causationId) headers["x-causation-id"] = context.causationId;
  return headers;
}
