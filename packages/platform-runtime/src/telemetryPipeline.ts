// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ReleaseChannel, TelemetryContext } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// From a stream of signals to something a person should read.
//
// Three separate jobs that are usually one tangle, kept apart because they fail
// differently:
//
//   CLASSIFY   is this normal for this engine, on this version, in this
//              instance class? Answered against a BASELINE, because "500ms" is
//              alarming for one engine and unremarkable for another.
//
//   DEDUPLICATE  the same condition seen a thousand times is one thing to tell
//              somebody about. A pipeline without this is one whose alerts get
//              muted, and a muted alert channel is worse than none — it looks
//              like coverage.
//
//   COMPARE    is the beta cohort worse than stable? With evidence and a
//              confidence, never a bare pass/fail.
//
// WHAT IT DOES NOT DO
//
// It does not contain, quarantine, revoke or block. SentinelIQ owns the
// defensive ladder and Governance authorizes its use; this produces the
// classification that a containment decision might READ. Observing something
// does not grant authority to act on it, and this file is the most tempting
// place in the system to forget that — it is where the alarming thing first
// becomes visible, and where acting on it would feel most obviously correct.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How significant an observation is.
 *
 * Four rungs, and the first is deliberately not "nothing". An observation that
 * did not rise to a warning is still a thing that was seen, and recording it as
 * such is what makes a baseline possible later.
 */
export type SignalClass = "observation" | "warning" | "incident" | "containment_candidate";

export interface Baseline {
  readonly engineId: string;
  readonly engineVersion: string;
  /** Expected value and the spread around it. */
  readonly metric: string;
  readonly mean: number;
  readonly stdDev: number;
  /**
   * How many samples the baseline is built from.
   *
   * Below `minimumSamples` nothing is classified above `observation`. A
   * baseline from six requests will call the seventh an incident, and the
   * first thing anyone learns from a noisy detector is to ignore it.
   */
  readonly samples: number;
}

export interface ClassificationPolicy {
  /** Sigmas above the mean before a warning. */
  readonly warnSigma?: number;
  /** Sigmas before an incident. */
  readonly incidentSigma?: number;
  /** Sigmas before this is worth a containment DECISION being made elsewhere. */
  readonly containmentSigma?: number;
  readonly minimumSamples?: number;
}

export interface Classification {
  readonly signalClass: SignalClass;
  readonly reason: string;
  /** How far from the baseline, in standard deviations. Null when unknowable. */
  readonly sigma: number | null;
}

/**
 * Classifies one observed value against a baseline.
 *
 * Returns `observation` when it cannot tell — never `warning`, and never
 * silence. Not-enough-data is a real state and the honest report of it is the
 * lowest rung, not the absence of a signal.
 */
export function classify(input: {
  baseline: Baseline;
  observed: number;
  policy?: ClassificationPolicy;
}): Classification {
  const p = input.policy ?? {};
  const minimumSamples = p.minimumSamples ?? 30;
  const warn = p.warnSigma ?? 2;
  const incident = p.incidentSigma ?? 3;
  const containment = p.containmentSigma ?? 5;

  if (input.baseline.samples < minimumSamples) {
    return {
      signalClass: "observation",
      reason:
        `The baseline for ${input.baseline.metric} rests on ${input.baseline.samples} samples against a ` +
        `minimum of ${minimumSamples}. Too little to call anything abnormal, and a detector that cries ` +
        "wolf early is one people learn to ignore.",
      sigma: null,
    };
  }

  if (input.baseline.stdDev <= 0) {
    // Zero variance is not certainty. It means every sample so far was
    // identical, which says more about the sample than about the metric.
    return {
      signalClass: "observation",
      reason: `The baseline for ${input.baseline.metric} has no variance, so distance from it is not meaningful.`,
      sigma: null,
    };
  }

  const sigma = (input.observed - input.baseline.mean) / input.baseline.stdDev;

  // Only ABOVE the mean. A latency far below baseline is not an incident, and
  // a two-sided test here would page somebody because the system got faster.
  if (sigma >= containment) {
    return {
      signalClass: "containment_candidate",
      reason: `${input.baseline.metric} is ${sigma.toFixed(1)}σ above baseline.`,
      sigma,
    };
  }
  if (sigma >= incident) {
    return { signalClass: "incident", reason: `${input.baseline.metric} is ${sigma.toFixed(1)}σ above baseline.`, sigma };
  }
  if (sigma >= warn) {
    return { signalClass: "warning", reason: `${input.baseline.metric} is ${sigma.toFixed(1)}σ above baseline.`, sigma };
  }
  return {
    signalClass: "observation",
    reason: `${input.baseline.metric} is within ${warn}σ of baseline.`,
    sigma,
  };
}

// ── Deduplication ────────────────────────────────────────────────────────────

export interface AlertDecision {
  /** Whether a person should be told now. */
  readonly notify: boolean;
  /** How many occurrences this notification stands for, including this one. */
  readonly occurrences: number;
  readonly reason: string;
  readonly fingerprint: string;
}

export interface AlertDeduplicatorOptions {
  /** How long one fingerprint stays suppressed. */
  readonly windowMs?: number;
  readonly now?: () => Date;
  /**
   * Whether an escalation in class re-notifies inside the window.
   *
   * Defaults to true, and it is the setting that keeps deduplication from
   * becoming suppression: the same condition getting WORSE is new information,
   * and a window that swallowed it would hide the thing everyone actually
   * needed to know.
   */
  readonly notifyOnEscalation?: boolean;
  /** Where the windows live. Defaults to in-memory. */
  readonly store?: AlertStore;
}

/**
 * Where the suppression windows live.
 *
 * The one whose loss is least alarming and most annoying: a restart with an
 * empty deduplicator re-notifies everything currently firing, which is a
 * notification storm caused by the thing that exists to prevent notification
 * storms.
 */
export interface AlertStore {
  readonly durability: "in-memory" | "durable";
  get(fingerprint: string): { firstAt: number; count: number; highest: SignalClass } | null;
  set(fingerprint: string, value: { firstAt: number; count: number; highest: SignalClass }): void;
  all(): ReadonlyArray<readonly [string, { firstAt: number; count: number; highest: SignalClass }]>;
}

export function createInMemoryAlertStore(): AlertStore {
  const seen = new Map<string, { firstAt: number; count: number; highest: SignalClass }>();
  return {
    durability: "in-memory",
    get: (f) => seen.get(f) ?? null,
    set: (f, v) => {
      seen.set(f, v);
    },
    all: () => [...seen.entries()],
  };
}

export interface AlertDeduplicator {
  consider(input: {
    fingerprint: string;
    signalClass: SignalClass;
  }): AlertDecision;
  /** Occurrences suppressed since the last notification, per fingerprint. */
  pending(): Readonly<Record<string, number>>;

  /** Whether the suppression windows survive a restart. */
  durability(): "in-memory" | "durable";
}

const CLASS_RANK: Readonly<Record<SignalClass, number>> = Object.freeze({
  observation: 0,
  warning: 1,
  incident: 2,
  containment_candidate: 3,
});

/**
 * Turns repeated conditions into one notification with a count.
 *
 * The failure this prevents is not noise for its own sake. It is that a person
 * who receives four hundred identical pages mutes the channel, and a muted
 * channel looks exactly like a quiet one on the day something new happens.
 */
export function createAlertDeduplicator(
  options: AlertDeduplicatorOptions = {},
): AlertDeduplicator {
  const windowMs = options.windowMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());
  const escalate = options.notifyOnEscalation ?? true;

  const store = options.store ?? createInMemoryAlertStore();

  return {
    consider({ fingerprint, signalClass }) {
      const at = now().getTime();
      const prior = store.get(fingerprint);

      if (!prior || at - prior.firstAt > windowMs) {
        store.set(fingerprint, { firstAt: at, count: 1, highest: signalClass });
        return {
          notify: true,
          occurrences: 1,
          reason: prior ? "First occurrence in a new window." : "First occurrence.",
          fingerprint,
        };
      }

      const count = prior.count + 1;
      const worse = CLASS_RANK[signalClass] > CLASS_RANK[prior.highest];
      store.set(fingerprint, {
        firstAt: prior.firstAt,
        count: worse ? 0 : count,
        highest: worse ? signalClass : prior.highest,
      });

      if (worse && escalate) {
        // The count resets because this notification stands for the escalation,
        // not for the run of quieter occurrences that preceded it.
        return {
          notify: true,
          occurrences: count,
          reason: `Escalated from ${prior.highest} to ${signalClass}. The same condition getting worse is new information.`,
          fingerprint,
        };
      }

      return {
        notify: false,
        occurrences: count,
        reason: `Suppressed: ${count} occurrences of this condition inside the window.`,
        fingerprint,
      };
    },

    pending() {
      const out: Record<string, number> = {};
      for (const [key, value] of store.all()) if (value.count > 1) out[key] = value.count;
      return out;
    },

    durability: () => store.durability,
  };
}

// ── Release cohorts ──────────────────────────────────────────────────────────

export interface CohortSample {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly requests: number;
  readonly failures: number;
  readonly p95LatencyMs: number;
}

export interface CohortComparison {
  readonly verdict: "better" | "comparable" | "worse" | "inconclusive";
  /** What the verdict rests on, in words. Never a bare pass/fail. */
  readonly evidence: readonly string[];
  /** How much to believe it. Absent sample size is what makes this necessary. */
  readonly confidence: "low" | "moderate" | "high";
}

/**
 * Compares a candidate cohort against a baseline one.
 *
 * Returns evidence and a confidence rather than a binary, because a promotion
 * decision made from a bare pass/fail is one nobody can argue with — and the
 * cases that matter are the ones somebody should have argued with.
 *
 * `inconclusive` is a first-class answer. A candidate with forty requests has
 * not demonstrated anything, and calling that "comparable" would let a release
 * through on the strength of nobody having used it yet.
 */
export function compareCohorts(input: {
  baseline: CohortSample;
  candidate: CohortSample;
  minimumRequests?: number;
}): CohortComparison {
  const minimum = input.minimumRequests ?? 100;
  const { baseline, candidate } = input;
  const evidence: string[] = [];

  if (candidate.requests < minimum) {
    return {
      verdict: "inconclusive",
      evidence: [
        `The candidate has ${candidate.requests} requests against a minimum of ${minimum}. ` +
          "Too few to demonstrate anything, and 'comparable' here would let a release through on the " +
          "strength of nobody having used it yet.",
      ],
      confidence: "low",
    };
  }

  const baseFailure = baseline.requests > 0 ? baseline.failures / baseline.requests : 0;
  const candFailure = candidate.failures / candidate.requests;
  evidence.push(
    `Failure rate ${(candFailure * 100).toFixed(2)}% against a baseline of ${(baseFailure * 100).toFixed(2)}%.`,
  );
  evidence.push(
    `p95 latency ${candidate.p95LatencyMs}ms against a baseline of ${baseline.p95LatencyMs}ms.`,
  );

  const failureWorse = candFailure > baseFailure * 1.5 && candFailure - baseFailure > 0.01;
  const latencyWorse = candidate.p95LatencyMs > baseline.p95LatencyMs * 1.25;
  const failureBetter = candFailure < baseFailure * 0.5;
  const latencyBetter = candidate.p95LatencyMs < baseline.p95LatencyMs * 0.8;

  const confidence =
    candidate.requests >= minimum * 10
      ? "high"
      : candidate.requests >= minimum * 3
        ? "moderate"
        : "low";

  if (failureWorse || latencyWorse) {
    evidence.push(
      failureWorse ? "Failures are materially higher." : "Latency is materially higher.",
    );
    return { verdict: "worse", evidence, confidence };
  }
  if (failureBetter || latencyBetter) {
    return { verdict: "better", evidence, confidence };
  }
  return { verdict: "comparable", evidence, confidence };
}

/**
 * Whether this pipeline may contain, quarantine or block anything.
 *
 * Always false. It classifies; SentinelIQ owns the defensive ladder and
 * Governance authorizes its use. This is the most tempting place in the system
 * to forget that, because it is where the alarming thing first becomes visible
 * and where acting on it would feel most obviously correct.
 */
export function pipelineMayContain(): false {
  return false;
}

/** Builds a stable fingerprint for deduplication from a context and a condition. */
export function fingerprintOf(context: TelemetryContext, condition: string): string {
  // Tenant is deliberately part of it: the same condition in two tenants is two
  // problems, and merging them would let one shop's incident hide another's.
  return [
    context.globalInstanceId,
    context.tenantId ?? "-",
    context.engineId,
    context.engineVersion,
    condition,
  ].join("|");
}
