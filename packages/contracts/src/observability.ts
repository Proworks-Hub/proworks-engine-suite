// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { TenantContext } from "./tenancy.js";
import type { TraceContext } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Being able to answer "what happened?" six months later.
//
// Ports, not implementations, and for the usual reason: an engine that imports
// a logging library has taken a dependency on somebody else's opinion about
// transports, and can no longer be lifted out without it.
//
// Structured, not strings. `console.log("cost done " + id)` is unsearchable the
// moment there are two shops and a thousand quotes. A field can be filtered;
// a sentence cannot.
//
// The default for all of these is to do NOTHING. A host that wants telemetry
// binds something; a host that does not gets an engine that stays quiet, which
// is the right default for a library.
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The fields worth having on every line.
 *
 * Deliberately NOT free-form. The point of structure is that the same question
 * can be asked across engines, and that only works if they name things the same.
 */
export interface LogFields {
  /** Ties the line to the unit of work. The single most useful field here. */
  trace?: TraceContext;
  tenant?: TenantContext;
  /** Which engine, e.g. "costiq". */
  engine?: string;
  /** What it was doing, e.g. "calculate", "normalize-receipt". */
  operation?: string;
  durationMs?: number;
  status?: "success" | "failure";
  errorName?: string;
  /** Anything else. Kept separate so the fields above stay dependable. */
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  /**
   * Returns a logger that carries these fields on every line, so a correlation
   * id is attached once at the boundary rather than remembered at every call.
   */
  child(fields: LogFields): Logger;
}

/** Does nothing. The default, so an engine with no host telemetry stays quiet. */
export const NOOP_LOGGER: Logger = {
  log: () => {},
  child: () => NOOP_LOGGER,
};

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Labels are low-cardinality on purpose.
 *
 * A tenant id or a job id as a label creates one time series per value, which
 * is how a metrics backend falls over. Identity belongs in logs and traces;
 * metrics answer "how many" and "how slow", not "which one".
 */
export type MetricLabels = Record<string, string>;

export interface Metrics {
  /** Something happened: jobs enqueued, events published, retries taken. */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** A measurement: duration, queue depth at a point, payload size. */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** A current level: queue depth, active workers, open circuits. */
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

export const NOOP_METRICS: Metrics = {
  increment: () => {},
  observe: () => {},
  gauge: () => {},
};

/** The names worth standardising, so a dashboard works across engines. */
export const METRIC_NAMES = {
  eventPublished: "events.published",
  eventDelivered: "events.delivered",
  eventDeliveryFailed: "events.delivery_failed",
  eventDeadLettered: "events.dead_lettered",
  jobEnqueued: "jobs.enqueued",
  jobCompleted: "jobs.completed",
  jobFailed: "jobs.failed",
  jobDurationMs: "jobs.duration_ms",
  queueDepth: "jobs.queue_depth",
  workflowStarted: "workflows.started",
  workflowCompleted: "workflows.completed",
  workflowCompensated: "workflows.compensated",
  engineOperationMs: "engine.operation_ms",
} as const;

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Business actions worth a permanent record — separate from logs, which are
 * for debugging and get rotated away.
 *
 * "Who overrode this material cost, and what was it before?" is a question that
 * gets asked months later, usually when money is involved. A log that has aged
 * out cannot answer it.
 */
export interface AuditEntry {
  auditId: string;
  /** Who did it. `system` when nobody did. */
  actor: { userId?: string; service?: string };
  tenant: TenantContext;
  /** Past tense, like an event: `cost.overridden`, `quote.changed`. */
  action: string;
  entity: { type: string; id: string };
  /** Only for fields that actually changed, and never secrets. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  trace: TraceContext;
  occurredAt: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void> | void;
  query(filter: {
    tenant?: string;
    entityType?: string;
    entityId?: string;
    action?: string;
    limit?: number;
  }): Promise<AuditEntry[]> | AuditEntry[];
}

// ── Timing ───────────────────────────────────────────────────────────────────

/**
 * Times an operation and reports it once, as one structured line and one
 * observation, whether it succeeded or threw.
 *
 * Exists because the alternative — logging at the start, logging at the end,
 * remembering to log in the catch — is the version that goes wrong, and the
 * missing line is always the failure case.
 */
export async function timed<T>(
  work: () => Promise<T> | T,
  reporting: {
    logger?: Logger;
    metrics?: Metrics;
    engine: string;
    operation: string;
    fields?: LogFields;
    now?: () => number;
  },
): Promise<T> {
  const now = reporting.now ?? (() => Date.now());
  const started = now();
  const labels = { engine: reporting.engine, operation: reporting.operation };
  try {
    const result = await work();
    const durationMs = now() - started;
    reporting.logger?.log("info", `${reporting.engine}.${reporting.operation}`, {
      ...reporting.fields,
      engine: reporting.engine,
      operation: reporting.operation,
      durationMs,
      status: "success",
    });
    reporting.metrics?.observe(METRIC_NAMES.engineOperationMs, durationMs, labels);
    return result;
  } catch (cause) {
    const durationMs = now() - started;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    reporting.logger?.log("error", `${reporting.engine}.${reporting.operation}`, {
      ...reporting.fields,
      engine: reporting.engine,
      operation: reporting.operation,
      durationMs,
      status: "failure",
      errorName: error.name,
      message: error.message,
    });
    reporting.metrics?.observe(METRIC_NAMES.engineOperationMs, durationMs, {
      ...labels,
      status: "failure",
    });
    throw error;
  }
}
