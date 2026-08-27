// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { LogFields, LogLevel, Logger, MetricLabels, Metrics } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Bindings for the observability ports.
//
// One that writes structured lines through a sink a host supplies, and one that
// collects metrics in memory so a test can assert on them.
//
// Neither reaches for `console` or a clock directly — both are injected. That
// is not ceremony: a logger that calls `console.log` is untestable, and one
// that calls `Date.now()` produces output that changes every run.
// ─────────────────────────────────────────────────────────────────────────────

export interface StructuredLogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  fields: LogFields;
}

export interface StructuredLoggerOptions {
  /** Where lines go. A host passes console.log, a file, or a shipper. */
  sink: (record: StructuredLogRecord) => void;
  /** Lines below this are dropped without being formatted. */
  minLevel?: LogLevel;
  now?: () => Date;
  /** Fields on every line from this logger. */
  base?: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * A logger that emits structured records.
 *
 * `child()` is the point of it: a correlation id gets attached once at the
 * boundary and rides every line beneath, instead of being remembered at each
 * call site — which is exactly where it gets forgotten.
 */
export function createStructuredLogger(options: StructuredLoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const minLevel = options.minLevel ?? "info";
  const base = options.base ?? {};

  const logger: Logger = {
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
      options.sink({
        level,
        message,
        timestamp: now().toISOString(),
        fields: { ...base, ...fields },
      });
    },
    child(fields) {
      return createStructuredLogger({ ...options, base: { ...base, ...fields } });
    },
  };
  return logger;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface MetricSample {
  name: string;
  value: number;
  labels: MetricLabels;
}

export interface InMemoryMetrics extends Metrics {
  counters(): MetricSample[];
  observations(): MetricSample[];
  gauges(): MetricSample[];
  /** Total of one counter, optionally narrowed by labels. */
  counterTotal(name: string, labels?: MetricLabels): number;
  /** Percentile of an observation series — the number that says "how slow". */
  percentile(name: string, p: number, labels?: MetricLabels): number | null;
  reset(): void;
}

const labelKey = (labels: MetricLabels = {}): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");

const matches = (sample: MetricSample, name: string, labels?: MetricLabels): boolean =>
  sample.name === name &&
  (!labels || Object.entries(labels).every(([k, v]) => sample.labels[k] === v));

/**
 * Metrics collected in memory.
 *
 * Percentiles rather than averages, because an average latency hides the
 * request that took nine seconds — and that request is the one somebody is
 * complaining about.
 */
export function createInMemoryMetrics(): InMemoryMetrics {
  const counterValues = new Map<string, MetricSample>();
  const observationValues: MetricSample[] = [];
  const gaugeValues = new Map<string, MetricSample>();

  return {
    increment(name, labels = {}, by = 1) {
      const key = `${name}|${labelKey(labels)}`;
      const existing = counterValues.get(key);
      counterValues.set(key, { name, labels, value: (existing?.value ?? 0) + by });
    },
    observe(name, value, labels = {}) {
      observationValues.push({ name, value, labels });
    },
    gauge(name, value, labels = {}) {
      gaugeValues.set(`${name}|${labelKey(labels)}`, { name, labels, value });
    },

    counters: () => [...counterValues.values()],
    observations: () => [...observationValues],
    gauges: () => [...gaugeValues.values()],

    counterTotal(name, labels) {
      return [...counterValues.values()]
        .filter((s) => matches(s, name, labels))
        .reduce((sum, s) => sum + s.value, 0);
    },

    percentile(name, p, labels) {
      const values = observationValues
        .filter((s) => matches(s, name, labels))
        .map((s) => s.value)
        .sort((a, b) => a - b);
      if (values.length === 0) return null;
      const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
      return values[index]!;
    },

    reset() {
      counterValues.clear();
      observationValues.length = 0;
      gaugeValues.clear();
    },
  };
}
