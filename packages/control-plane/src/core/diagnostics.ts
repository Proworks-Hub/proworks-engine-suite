// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Alert } from "./alerts.js";
import type { EngineHealth } from "./health.js";
import type { ObservedHeartbeat } from "./heartbeat.js";
import type { EngineManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Explaining a failure to somebody who has to fix it at 2am.
//
// DELIBERATELY DETERMINISTIC. Every explanation here comes from a rule with
// stated evidence, not from a model. An incident is the single worst place for
// a confident-sounding guess: the reader is tired, under pressure, and will act
// on the first plausible thing they are told. A wrong explanation does not just
// fail to help — it sends somebody to restart the wrong service while the real
// fault continues.
//
// AI can layer on top of this later. It cannot replace it, because the value is
// in the causes being traceable to a specific observation.
//
// Three rules the shape enforces:
//
//   CONFIDENCE IS REPORTED, NOT IMPLIED. A cause with one weak signal says so.
//   EVERY CAUSE CITES ITS EVIDENCE. "Probably the database" with nothing behind
//   it is a rumour.
//   THE RAW DETAIL IS NEVER HIDDEN. This explains the diagnostics; it does not
//   replace them, and an engineer who wants the underlying numbers gets them.
// ─────────────────────────────────────────────────────────────────────────────

export type Confidence = "likely" | "possible" | "speculative";

export interface LikelyCause {
  readonly summary: string;
  readonly confidence: Confidence;
  /** The specific observations behind this. Never empty. */
  readonly evidence: readonly string[];
  /** Non-destructive things to check, in the order worth checking them. */
  readonly checks: readonly string[];
}

export interface Explanation {
  readonly engineId: string;
  /** What happened, in a sentence, without jargon. */
  readonly whatHappened: string;
  /** What it means for the product, honestly scoped. */
  readonly impact: string;
  readonly causes: readonly LikelyCause[];
  /** What happens if nobody does anything. */
  readonly ifIgnored: string;
  /** The unprocessed detail, always available. */
  readonly rawDetail: string;
  /**
   * True when the console genuinely cannot tell what is wrong.
   *
   * Surfaced rather than padded with speculation. "I do not know" is more
   * useful than three invented causes, because it tells the reader to go and
   * look rather than to start eliminating a list somebody made up.
   */
  readonly inconclusive: boolean;
}

export interface ExplainInput {
  manifest: EngineManifest;
  health: EngineHealth;
  heartbeat?: ObservedHeartbeat;
  alerts?: readonly Alert[];
  /** Whether a release went out recently, and which. */
  recentDeployment?: { version: string; atMsAgo: number };
  /** Engines this one depends on, with their current state. */
  dependencies?: readonly { engineId: string; state: EngineHealth["state"] }[];
}

/**
 * Turns a health state into something a person can act on.
 *
 * The ordering matters: a dependency that is down explains an engine's failure
 * better than anything about the engine itself, and putting it first stops
 * somebody debugging the symptom.
 */
export function explainFailure(input: ExplainInput): Explanation {
  const { manifest, health, heartbeat } = input;
  const causes: LikelyCause[] = [];

  const brokenDependencies = (input.dependencies ?? []).filter(
    (dependency) => dependency.state === "failed" || dependency.state === "degraded",
  );

  // First, because it is both the commonest cause and the one that most often
  // gets missed while somebody restarts the wrong engine.
  if (brokenDependencies.length > 0) {
    causes.push({
      summary: `Something ${manifest.name} depends on is unhealthy: ${brokenDependencies.map((d) => d.engineId).join(", ")}.`,
      confidence: "likely",
      evidence: brokenDependencies.map((d) => `${d.engineId} is ${d.state}`),
      checks: [
        `Open ${brokenDependencies[0]!.engineId} and read its own diagnosis first.`,
        `If that engine recovers, re-check ${manifest.name} before changing anything here.`,
      ],
    });
  }

  if (input.recentDeployment && input.recentDeployment.atMsAgo < 60 * 60_000) {
    const minutes = Math.round(input.recentDeployment.atMsAgo / 60_000);
    causes.push({
      summary: `Version ${input.recentDeployment.version} was deployed ${minutes} minute${minutes === 1 ? "" : "s"} ago.`,
      // Correlation, and labelled as correlation. A deployment shortly before a
      // fault is a strong hint and not a diagnosis, and calling it "likely"
      // would push somebody to roll back a release that is not the cause.
      confidence: brokenDependencies.length > 0 ? "possible" : "likely",
      evidence: [`deployed ${minutes}m before the fault was observed`],
      checks: [
        "Compare the error against the release notes for what changed.",
        "Check whether the previous version is a safe rollback target before considering one.",
      ],
    });
  }

  if (heartbeat && heartbeat.openCircuits.length > 0) {
    causes.push({
      summary: `A circuit breaker is open: ${heartbeat.openCircuits.join(", ")}. ${manifest.name} has stopped calling something that was failing.`,
      confidence: "likely",
      evidence: heartbeat.openCircuits.map((circuit) => `circuit "${circuit}" is open`),
      checks: [
        "Check whether the thing behind that circuit is reachable.",
        "A circuit reopens on its own once calls succeed; forcing it does not fix the cause.",
      ],
    });
  }

  if (health.state === "unknown") {
    const derived = heartbeat?.source === "derived";
    causes.push({
      summary: derived
        ? `${manifest.name} has published nothing recently. It may be idle rather than broken — telemetry here is inferred from events, so silence is ambiguous.`
        : `Nothing is reporting ${manifest.name}'s health.`,
      confidence: derived ? "possible" : "likely",
      evidence: [health.reason],
      checks: [
        "Check whether any host application is reporting telemetry at all.",
        `Confirm whether ${manifest.name} is actually being called — an engine nobody invokes reports nothing.`,
      ],
    });
  }

  if (heartbeat && heartbeat.jobsProcessed > 0 && heartbeat.jobsFailed > 0) {
    const rate = heartbeat.jobsFailed / heartbeat.jobsProcessed;
    if (rate > 0.05) {
      causes.push({
        summary: `${manifest.name} is failing ${(rate * 100).toFixed(1)}% of the work it is given.`,
        // A rate over a small sample is not a rate. Saying so stops somebody
        // treating three failures as an outage.
        confidence: heartbeat.jobsProcessed >= 50 ? "likely" : "speculative",
        evidence: [`${heartbeat.jobsFailed} of ${heartbeat.jobsProcessed} failed`],
        checks: [
          "Open a failing trace and read where in the chain it stopped.",
          "Check whether the failures share an input shape, a tenant, or a time window.",
        ],
      });
    }
  }

  const impact =
    health.state === "failed"
      ? `Work routed to ${manifest.name} is not completing.`
      : health.state === "degraded"
        ? `${manifest.name} is completing some work and failing the rest.`
        : health.state === "unknown"
          ? `Unknown. The console cannot see ${manifest.name}, which is not the same as ${manifest.name} being down.`
          : `${manifest.name} appears to be working.`;

  return {
    engineId: manifest.id,
    whatHappened: `${manifest.name} is ${health.descriptor.label.toLowerCase()}. ${health.reason}`,
    impact,
    causes,
    ifIgnored:
      health.state === "failed"
        ? "Work will continue to fail until something changes. This does not recover on its own."
        : health.state === "degraded"
          ? "Some work will keep failing. It may recover if the underlying cause is transient."
          : health.state === "unknown"
            ? "The console will stay blind to this engine. That is a monitoring problem, which may or may not also be an engine problem."
            : "Nothing.",
    // Always present, never summarised away. An engineer who wants the numbers
    // should not have to leave this screen to get them.
    rawDetail: JSON.stringify(
      { state: health.state, reason: health.reason, heartbeat: heartbeat ?? null, alerts: input.alerts ?? [] },
      null,
      2,
    ),
    // No causes means no rule matched. Saying "I do not know" beats inventing
    // three plausible ones for somebody to eliminate at 2am.
    inconclusive: causes.length === 0,
  };
}

// ── Blast radius ─────────────────────────────────────────────────────────────

export interface BlastRadius {
  readonly engineId: string;
  /** Engines that consume what this one publishes. */
  readonly directConsumers: readonly string[];
  /** Reached through another engine. */
  readonly indirectConsumers: readonly string[];
  /** The event types that carry the effect. */
  readonly via: readonly string[];
}

/**
 * What else is affected if this engine changes or breaks.
 *
 * Derived from the manifests' event mappings, so it describes the system that
 * exists rather than an architecture diagram somebody drew once. Follows the
 * graph transitively, because the second hop is the one people forget — and it
 * is usually where the customer-visible damage happens.
 */
export function blastRadius(
  engineId: string,
  manifests: readonly EngineManifest[],
): BlastRadius {
  const edges = new Map<string, { to: string; eventType: string }[]>();
  for (const manifest of manifests) {
    const out = manifest.eventMappings
      .filter((mapping) => mapping.to && mapping.to !== manifest.id)
      .map((mapping) => ({ to: mapping.to!, eventType: mapping.eventType }));
    edges.set(manifest.id, out);
  }

  const direct = new Set<string>();
  const via = new Set<string>();
  for (const edge of edges.get(engineId) ?? []) {
    direct.add(edge.to);
    via.add(edge.eventType);
  }

  const indirect = new Set<string>();
  const seen = new Set<string>([engineId, ...direct]);
  let frontier = [...direct];

  // Bounded by the node count, so a cycle in the mappings cannot loop forever.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of edges.get(node) ?? []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        indirect.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  return {
    engineId,
    directConsumers: [...direct].sort(),
    indirectConsumers: [...indirect].sort(),
    via: [...via].sort(),
  };
}
