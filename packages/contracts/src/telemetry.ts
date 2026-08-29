// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { dataClassificationSchema, type DataClassification } from "./hiveMessage.js";
import { identifierSchema } from "./identifiers.js";
import { trustStateSchema } from "./principal.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT TELEMETRY MAY SAY, AND WHERE IT MAY GO.
//
// Observability is the one subsystem whose job is to copy information out of
// everywhere else, which makes it the most likely thing in the Hive to become
// an accidental data-sharing pipeline. Every other boundary can be crossed by
// somebody deciding to cross it; this one gets crossed by somebody adding a
// label to a metric.
//
// So the interesting content of this file is not the context shape. It is the
// two rules underneath it:
//
//   RAW TENANT CONTENT NEVER LEAVES THE INSTANCE AS TELEMETRY. Not redacted on
//   the way out — refused. A pipeline that sanitizes is one that had the data
//   in its buffers, its logs and its retries.
//
//   LABELS ARE BOUNDED. Unbounded cardinality is not merely a cost problem: a
//   label whose values are customer names is a customer list, and it arrives
//   in the metrics store looking like operations data.
//
// AND ONE THAT IS EASIER TO FORGET
//
// Telemetry failing must not stop the shop. An observability pipeline that can
// halt production has made watching more important than working, and the first
// outage proves it in the worst way.
// ─────────────────────────────────────────────────────────────────────────────

/** The release channel a signal came from. Cohort comparison needs this. */
export const releaseChannelSchema = z.enum(["local", "sandbox", "beta", "stable", "lts"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

/**
 * The context every signal carries.
 *
 * `tenantId` is optional and `principalId` is a REFERENCE. A telemetry record
 * that carried a principal object would carry its roles, its trust score and
 * its tenant — a copy of the identity plane inside the metrics store.
 */
export const telemetryContextSchema = z
  .object({
    timestamp: z.string().min(1),
    /** Which instance produced it. Bound by the runtime, never self-declared. */
    globalInstanceId: identifierSchema,
    /** Whose work. Absent for genuinely instance-wide signals. */
    tenantId: z.string().min(1).optional(),
    engineId: identifierSchema,
    engineVersion: z.string().min(1),
    /** Who was acting. An id only. */
    principalId: identifierSchema.optional(),
    trace: traceContextSchema,
    releaseChannel: releaseChannelSchema,
    /**
     * The producer's trust posture at the time.
     *
     * Reusing the identity plane's vocabulary rather than inventing a parallel
     * one. Two trust ladders would eventually disagree, and the one in the
     * metrics store would be the one nobody checked.
     */
    trustState: trustStateSchema,
    /**
     * How sensitive the SUBJECT of this signal is.
     *
     * Reusing `dataClassification` for the same reason. It drives the export
     * rule below rather than describing it.
     */
    sensitivity: dataClassificationSchema,
  })
  .strict();
export type TelemetryContext = z.infer<typeof telemetryContextSchema>;

/** Classifications that may never be exported to the collective as telemetry. */
const NEVER_COLLECTIVE: ReadonlySet<DataClassification> = new Set([
  "tenant-confidential",
  "restricted",
  "secret",
]);

/**
 * Label values that are almost always somebody's data.
 *
 * A denylist is the wrong shape for a security boundary and this is not one —
 * it is a guardrail against the specific mistake that keeps happening, which
 * is a well-meaning label like `customer` or `email` added to a counter. The
 * real boundary is the cardinality bound and the classification check below;
 * this catches the ones that would pass both.
 */
const FORBIDDEN_LABEL_KEYS: readonly string[] = Object.freeze([
  "customer",
  "customername",
  "customerid",
  "email",
  "phone",
  "address",
  "name",
  "user",
  "username",
  "userid",
  "token",
  "secret",
  "password",
  "apikey",
  "payload",
  "body",
  "content",
]);

export type ExportVerdict =
  | { readonly exportable: true; readonly labels: Readonly<Record<string, string>> }
  | { readonly exportable: false; readonly reason: string };

export interface CollectiveExportPolicy {
  /**
   * The most distinct values one label may carry.
   *
   * A bound rather than a warning. Unbounded cardinality is how a metrics
   * store quietly becomes a customer list.
   */
  readonly maxLabelValues?: number;
  /** Labels this signal is permitted to carry at all. Anything else is dropped. */
  readonly allowedLabels: readonly string[];
}

/**
 * Whether a signal may go to the collective, and with which labels.
 *
 * Refuses rather than redacts. Sanitizing on the way out means the pipeline
 * held the raw values — in its buffers, its retry queue and very likely its own
 * debug logs — which is the leak happening slightly later and less visibly.
 *
 * An ALLOWLIST for labels, not a denylist. A denylist admits every label
 * somebody adds after it was written, and the whole failure mode here is
 * somebody adding a label.
 */
export function exportToCollective(input: {
  context: TelemetryContext;
  labels: Readonly<Record<string, string>>;
  policy: CollectiveExportPolicy;
  /** Distinct values seen per label so far, for the cardinality bound. */
  observedCardinality?: Readonly<Record<string, number>>;
}): ExportVerdict {
  const { context, labels, policy } = input;

  if (NEVER_COLLECTIVE.has(context.sensitivity)) {
    return {
      exportable: false,
      reason:
        `A signal classified "${context.sensitivity}" is not collective telemetry. Raw customer and ` +
        "business content stays in the instance that produced it; the collective gets aggregates.",
    };
  }

  const out: Record<string, string> = {};
  const max = policy.maxLabelValues ?? 100;

  for (const [key, value] of Object.entries(labels)) {
    const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
    if (FORBIDDEN_LABEL_KEYS.includes(normalised)) {
      return {
        exportable: false,
        reason: `Label "${key}" names something that is somebody's data. A metric labelled by customer is a customer list.`,
      };
    }
    if (!policy.allowedLabels.includes(key)) continue;

    const seen = input.observedCardinality?.[key];
    if (seen !== undefined && seen > max) {
      return {
        exportable: false,
        reason:
          `Label "${key}" has ${seen} distinct values against a bound of ${max}. Unbounded cardinality ` +
          "is not only a cost problem — it is how a metrics store becomes a record of individuals.",
      };
    }
    out[key] = value;
  }

  return { exportable: true, labels: Object.freeze(out) };
}

/**
 * The health an engine exposes, beyond the counters it already reports.
 *
 * READINESS AND LIVENESS ARE SEPARATE and that is the point of the pair: a
 * process can be alive and unable to accept work — draining, waiting on a
 * migration, out of connections — and a single "healthy" boolean forces those
 * two into one answer. The wrong one gets picked under load, when it matters.
 */
export const engineReadinessSchema = z
  .object({
    /** Whether the process is functioning at all. */
    live: z.boolean(),
    /** Whether it can accept NEW work. */
    ready: z.boolean(),
    /** Why not, when not. Required on a negative — an unexplained "not ready" is unactionable. */
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => (r.live && r.ready) || Boolean(r.reason), {
    message:
      "An engine that is not live or not ready must say why. Half the value of splitting readiness from liveness is losing the ambiguity, and an unexplained negative puts it straight back.",
    path: ["reason"],
  });
export type EngineReadiness = z.infer<typeof engineReadinessSchema>;

export const dependencyHealthSchema = z
  .object({
    dependencyId: identifierSchema,
    /** `unknown` is a real answer and is never a synonym for reachable. */
    state: z.enum(["reachable", "degraded", "unreachable", "unknown"]),
    latencyMs: z.number().nonnegative().optional(),
    checkedAt: z.string().min(1),
  })
  .strict();
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

/**
 * A rolling allowance for failure.
 *
 * Expressed as consumed-out-of-budget rather than as a pass/fail, because the
 * useful operational question is not "are we failing" but "how much of this
 * period's allowance is gone" — which is the number that tells somebody
 * whether to ship on Friday.
 */
export const errorBudgetSchema = z
  .object({
    windowSeconds: z.number().int().positive(),
    /** 0..1. The share of the budget already spent. */
    consumed: z.number().min(0).max(1),
    target: z.number().min(0).max(1),
  })
  .strict();
export type ErrorBudget = z.infer<typeof errorBudgetSchema>;

/**
 * Whether a telemetry failure may stop business execution.
 *
 * Always false. An observability pipeline that can halt production has made
 * watching more important than working, and it proves it during the first
 * outage — when the thing that breaks is the thing that was supposed to tell
 * you what broke.
 *
 * A safety policy may separately require a halt. That is a policy decision
 * made by Governance, not a consequence of a metrics endpoint timing out, and
 * routing it through this function would blur exactly that difference.
 */
export function telemetryFailureStopsWork(): false {
  return false;
}

/**
 * Whether observing something grants authority to act on it.
 *
 * Always false. The nineteenth. Sentinel sees more of the Hive than anything
 * else, and the argument for letting it act on what it sees is always
 * reasonable in the moment — which is why the answer is written down here
 * rather than decided during an incident.
 */
export function observationGrantsAuthority(): false {
  return false;
}
