/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/ports/costPorts.ts
 * Module:   cost-iq-engine / ports
 * Purpose:  Everything CostIQ needs from the outside, and nothing it does itself.
 */

import { z } from "zod";

import type { Decimal } from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// PORTS, NOT IMPORTS
//
// CostIQ computes. It does not open a database, publish to a broker, read a
// clock, generate an id, or hash anything. Every one of those is a port a host
// binds, for reasons that are practical rather than doctrinal:
//
//   - A pure kernel can be tested exhaustively without infrastructure, which
//     is why the arithmetic has the coverage it has.
//   - The same kernel runs in the Hub, in KSix, in a worker and in a browser,
//     because none of them has to provide the same infrastructure.
//   - `node:*` in this package would end the second of those immediately, and
//     the portability guard fails the build if it appears.
//
// TIME IS A PORT BECAUSE TIME IS AN INPUT
//
// A cost that depends on `Date.now()` cannot be replayed, and a cost nobody can
// replay cannot be used to show that a decision was reasonable when it was
// made. Every function in the kernel that needs the time takes it as an
// argument; this port is how a host supplies it once at the edge.
// ─────────────────────────────────────────────────────────────────────────────

/** The clock. Supplied, never read. */
export interface ClockPort {
  now(): Date;
}

/** Identifier generation. Hosts own the format; CostIQ only needs uniqueness. */
export interface IdPort {
  newId(prefix: string): string;
}

// Digesting is a port too, but it already lives in core/costGraph.ts, where
// canonicalisation and hashing are defined together. Re-declaring it here would
// give the suite two HashPort types that drift apart, so this file re-exports
// the one that exists rather than adding a second.
export type { HashPort } from "../core/costGraph.js";

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reading and writing cost records.
 *
 * Deliberately narrow. There is no `query(sql)`, no `find(criteria)` and no
 * escape hatch: a port that could express arbitrary queries would let host
 * code push logic into the persistence layer, and the kernel would stop being
 * the only place cost decisions are made.
 *
 * Every write is idempotent on the record's own identity. A retry after a
 * timeout must not create a second version of an estimate — the failure mode
 * where an estimate exists twice with different numbers is worse than the
 * failure it was retrying past.
 */
export interface CostRepositoryPort<TRecord extends { readonly id: string; readonly version: number }> {
  load(id: string): Promise<TRecord | null>;
  loadMany(ids: readonly string[]): Promise<readonly TRecord[]>;

  /**
   * Writes, refusing if the stored version is not the one that was read.
   *
   * Optimistic concurrency rather than a lock. Two people editing the same
   * estimate is normal; one of them silently overwriting the other is not, and
   * a lost update in a cost model is invisible until somebody quotes from it.
   */
  save(record: TRecord, expectedVersion: number | null): Promise<SaveOutcome>;
}

export type SaveOutcome =
  | { readonly saved: true; readonly version: number }
  | {
      readonly saved: false;
      readonly reason: "VERSION_CONFLICT";
      readonly storedVersion: number;
      readonly message: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS — AND WHAT OTHER ENGINES MAY DO ABOUT THEM
//
// This is where CostIQ's boundary is most likely to be crossed by accident.
// An event is an announcement, not an instruction. "The standard cost changed"
// is a fact about a cost model; whether that means a revaluation is posted is
// Finance IQ's decision, and whether it means a quote is withdrawn is a
// commercial one.
//
// So every event type carries its CONSEQUENCE CONTRACT as data: what the event
// asserts, what a consumer is entitled to conclude, and — the part that gets
// forgotten — what it must NOT conclude. Written down because the wrong
// inference is silent. Nothing fails when a downstream engine treats "cost
// changed" as "reprice everything"; it just quietly starts making pricing
// decisions that nobody authorised it to make.
// ─────────────────────────────────────────────────────────────────────────────

export const COST_EVENT_TYPES = [
  "costiq.estimate.computed",
  "costiq.estimate.approved",
  "costiq.estimate.superseded",
  "costiq.basis.recorded",
  "costiq.basis.went_stale",
  "costiq.standard_cost.changed",
  "costiq.variance.detected",
  "costiq.model_health.degraded",
] as const;
export type CostEventType = (typeof COST_EVENT_TYPES)[number];

export interface ConsequenceContract {
  /** What the event states as a fact. */
  readonly asserts: string;
  /** What a consumer may legitimately conclude or do. */
  readonly entitles: readonly string[];
  /** What a consumer must NOT conclude. The part that gets forgotten. */
  readonly doesNotEntitle: readonly string[];
  /** Who, if anyone, is expected to act. Empty when the answer is "nobody automatically". */
  readonly expectedActors: readonly string[];
}

/**
 * The consequence contract for every event CostIQ emits.
 *
 * Exported as data so a consumer can assert against it in its own tests, and
 * so a reviewer can read the whole boundary in one place rather than inferring
 * it from handlers scattered across five repositories.
 */
export const CONSEQUENCE_CONTRACTS: Readonly<Record<CostEventType, ConsequenceContract>> = Object.freeze({
  "costiq.estimate.computed": {
    asserts: "A cost estimate was computed from the inputs available at that moment.",
    entitles: [
      "Displaying the figure alongside its evidence grade.",
      "Using it as an input to a quote that a person reviews.",
    ],
    doesNotEntitle: [
      "Treating it as a price. A cost is a floor and a reference, never a decision about what to charge.",
      "Treating it as approved. Computation is not approval, and the estimate's own status says which it is.",
      "Assuming it is still true later. Freshness is a separate question with its own signal.",
    ],
    expectedActors: [],
  },
  "costiq.estimate.approved": {
    asserts: "A person with authority approved this estimate, and it is now immutable.",
    entitles: [
      "Quoting from it.",
      "Recording it as the cost baseline a job is measured against.",
    ],
    doesNotEntitle: [
      "Editing it. Approved estimates have no path back to draft; a correction is a new version, which keeps the history rather than rewriting it.",
      "Assuming the approver checked the arithmetic. They approved a decision; the arithmetic is the engine's responsibility.",
    ],
    expectedActors: ["Finance IQ (baseline)", "Quoting"],
  },
  "costiq.estimate.superseded": {
    asserts: "A newer version of this estimate exists.",
    entitles: ["Pointing readers at the newer version.", "Marking downstream quotes for review."],
    doesNotEntitle: [
      "Deleting or hiding the superseded version. It is what a past decision was made on, and it stays readable.",
      "Automatically re-quoting. Whether a live quote is revised is a commercial decision.",
    ],
    expectedActors: [],
  },
  "costiq.basis.recorded": {
    asserts: "A new cost basis was recorded, with the provenance attached to it.",
    entitles: ["Recomputing estimates that depend on it.", "Showing the new evidence."],
    doesNotEntitle: [
      "Recomputing frozen estimates. A frozen estimate is frozen on purpose.",
      "Concluding the new basis is better than the old one. It is newer; strength and coverage are separate.",
    ],
    expectedActors: ["CostIQ (recalculation)"],
  },
  "costiq.basis.went_stale": {
    asserts: "A cost basis passed the freshness window its policy defines.",
    entitles: ["Flagging estimates that depend on it.", "Prompting somebody to re-verify."],
    doesNotEntitle: [
      "Discarding the rate. A stale rate is the best evidence available until a better one exists, and replacing it with nothing is worse.",
      "Blocking estimates. Staleness is reported, not enforced — the decision to proceed on old evidence belongs to a person.",
    ],
    expectedActors: [],
  },
  "costiq.standard_cost.changed": {
    asserts: "A standard cost was changed, with the old and new values and the reason.",
    entitles: ["Reporting the change.", "Recomputing variances against the new standard from its effective date."],
    doesNotEntitle: [
      "Posting a revaluation. Whether inventory is revalued, and how, is Finance IQ's to decide and post — CostIQ states the change and stops.",
      "Restating past variances. They were computed against the standard in force at the time, which is what makes them meaningful.",
    ],
    expectedActors: ["Finance IQ"],
  },
  "costiq.variance.detected": {
    asserts: "Actual cost differed from estimated cost by more than the policy's threshold.",
    entitles: ["Investigating.", "Showing the rate/quantity split, which says where to look."],
    doesNotEntitle: [
      "Concluding somebody is at fault. A variance is an arithmetic difference; the cause is found by looking, not by inferring.",
      "Adjusting the standard to make the variance disappear. That destroys the signal and is a governed change with its own path.",
    ],
    expectedActors: [],
  },
  "costiq.model_health.degraded": {
    asserts: "A cost model's inputs no longer meet the health policy.",
    entitles: ["Warning readers of estimates built from it.", "Prioritising which rates to refresh."],
    doesNotEntitle: [
      "Blocking use of the model. The engine reports; whether to proceed is a person's judgement about their own risk.",
      "Treating the score as the finding. The score is a summary; the findings say what to fix.",
    ],
    expectedActors: [],
  },
});

export const costEventSchema = z
  .object({
    eventId: z.string().min(1),
    type: z.enum(COST_EVENT_TYPES),
    /** When the fact became true, not when the record was written. */
    occurredAt: z.string().min(1),
    /** Which tenant. Required — an event without one cannot be routed safely. */
    tenantId: z.string().min(1),
    /** What the event is about. */
    subjectId: z.string().min(1),
    /** The request or event that caused this one, for tracing a chain back. */
    causationId: z.string().min(1).nullable(),
    correlationId: z.string().min(1),
    /**
     * Whether this came from a test run.
     *
     * Required with no default, the same rule the interconnect envelope uses.
     * An event that forgets to say is an event that lands in production data.
     */
    isTest: z.boolean(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CostEvent = z.infer<typeof costEventSchema>;

/**
 * Publishing events.
 *
 * `publish` must be idempotent on `eventId`: at-least-once delivery is the
 * only kind anyone actually builds, so a duplicate has to be harmless. A
 * consumer that acts twice on one variance investigates twice, which is
 * wasteful; a consumer that acts twice on a standard-cost change posts two
 * revaluations, which is a real problem.
 */
export interface CostEventPublisherPort {
  publish(event: CostEvent): Promise<void>;
  publishAll(events: readonly CostEvent[]): Promise<void>;
}

/** Looks up what a consumer is and is not entitled to conclude from an event. */
export function consequenceContractFor(type: CostEventType): ConsequenceContract {
  return CONSEQUENCE_CONTRACTS[type];
}

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY
//
// A port rather than a logger, because a cost engine that logged would be a
// cost engine that decided what a host's logs look like, and because the
// interesting signals here are not log lines. What matters is how often an
// estimate is computed from stale evidence, how long a rollup takes as a graph
// grows, and how often a recalculation is skipped as redundant — all of which
// are counters and durations, not text.
//
// NOTHING SENSITIVE PASSES THROUGH HERE
//
// Metric labels are a low-attention surface: they end up in dashboards, third
// party services and screenshots. So labels are constrained to a small set of
// known keys, and cost VALUES are never labels — a metric labelled with a
// customer's unit cost publishes that cost to everyone who can see the
// dashboard.
// ─────────────────────────────────────────────────────────────────────────────

export const METRIC_LABEL_KEYS = [
  "tenantId",
  "methodId",
  "methodVersion",
  "estimateStatus",
  "evidenceGrade",
  "outcome",
  "isTest",
] as const;
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];

export type MetricLabels = Partial<Record<MetricLabelKey, string>>;

export interface ObservabilityPort {
  count(metric: string, labels: MetricLabels, by?: number): void;
  /** Milliseconds. Measured by the host, since the kernel has no clock. */
  observeDuration(metric: string, milliseconds: number, labels: MetricLabels): void;
  /** A named event worth recording, with no free-text payload. */
  note(metric: string, labels: MetricLabels): void;
}

/**
 * Strips anything that is not a known label key.
 *
 * Called by adapters on the way out, so a caller that adds a label in good
 * faith cannot leak a value into a dashboard. Returns what it dropped, so the
 * omission is visible rather than silent.
 */
export function sanitizeLabels(labels: Record<string, unknown>): {
  readonly labels: MetricLabels;
  readonly dropped: readonly string[];
} {
  const clean: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if ((METRIC_LABEL_KEYS as readonly string[]).includes(key) && (typeof value === "string" || typeof value === "boolean" || typeof value === "number")) {
      clean[key] = String(value);
    } else {
      dropped.push(key);
    }
  }
  return { labels: clean as MetricLabels, dropped };
}

/**
 * Whether a value may be used as a metric label.
 *
 * A function rather than a comment so a test can assert it. Cost figures never
 * may: a dashboard is a publication surface, and a unit cost on one is a unit
 * cost published to everybody who can see it.
 */
export function decimalMayBeALabel(_value: Decimal): false {
  return false;
}

/** An observability port that does nothing, for hosts that bind none. */
export const NULL_OBSERVABILITY: ObservabilityPort = Object.freeze({
  count: () => {},
  observeDuration: () => {},
  note: () => {},
});
