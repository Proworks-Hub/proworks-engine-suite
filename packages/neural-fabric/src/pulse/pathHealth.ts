/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/pulse/pathHealth.ts
 * Module:   neural-fabric / pulse
 * Purpose:  What is happening on the permitted paths, and which one to use now.
 */

import type { CandidatePath } from "../nexus/topologyGraph.js";

// ─────────────────────────────────────────────────────────────────────────────
// PULSE CHOOSES AMONG PERMITTED ROUTES. IT CANNOT INVENT ONE.
//
// §16 states it plainly: "Pulse cannot invent a forbidden route." This module
// enforces it structurally rather than by discipline — `selectPath` takes the
// candidate set as an argument and returns a member of it. There is no graph
// here, no adjacency, and no way to construct a path. The worst a bug in this
// file can do is pick a bad permitted route, which is a performance problem.
// It cannot become a permission problem.
//
// That constraint is why the signature looks redundant. It would be more
// convenient to hand Pulse the graph and let it find its own way. It would
// also mean that every future change to failover logic is a change that could
// widen reachability, reviewed by whoever was thinking about latency that day.
//
// A CIRCUIT BREAKER IS A PROMISE NOT TO KEEP ASKING
//
// The failure it prevents is not the original failure. It is the second-order
// one: a dependency slows down, callers retry, the retries add load, it slows
// further. The system spends its capacity discovering repeatedly that
// something is broken.
//
// Three states, and HALF_OPEN is the one that matters. Going straight from
// open to closed means the first burst of real traffic hits a service that may
// still be unwell. Half-open lets exactly one probe through and decides on
// that — which is why `probeInFlight` exists and why a second probe is
// refused while one is outstanding.
//
// AND FAILURE DETECTION IS DELIBERATELY NOT AGGRESSIVE
//
// §25: "avoid overly aggressive false-positive failure detection." A breaker
// that opens on one timeout will open constantly on a healthy system under
// normal jitter, and a breaker that opens constantly gets its thresholds
// raised until it never opens at all. The consecutive-failure requirement is
// what keeps it credible.
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitPolicy {
  /** Consecutive failures before opening. One is too few — see the header. */
  readonly failureThreshold: number;
  /** Consecutive successes in half-open before closing. */
  readonly successThreshold: number;
  /** How long to stay open before allowing a probe. */
  readonly openDurationMs: number;
}

export interface Circuit {
  readonly pathKey: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  /** When the circuit opened, so the probe window can be computed. */
  readonly openedAt: string | null;
  /** True while a half-open probe is outstanding. */
  readonly probeInFlight: boolean;
  readonly lastTransitionReason: string;
}

export function newCircuit(pathKey: string): Circuit {
  return {
    pathKey,
    state: "CLOSED",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    probeInFlight: false,
    lastTransitionReason: "Newly observed path. Assumed healthy until it fails.",
  };
}

/**
 * Whether a signal may be sent on this path right now.
 *
 * `now` is an argument, never a clock read. A breaker decision that cannot be
 * replayed cannot be explained after an incident, and "why was this rejected
 * at 14:32" is the question that gets asked.
 */
export function admits(
  circuit: Circuit,
  policy: CircuitPolicy,
  now: string,
): { readonly admitted: boolean; readonly asProbe: boolean; readonly reason: string } {
  if (circuit.state === "CLOSED") {
    return { admitted: true, asProbe: false, reason: "The circuit is closed; the path is being used normally." };
  }

  if (circuit.state === "HALF_OPEN") {
    if (circuit.probeInFlight) {
      return {
        admitted: false,
        asProbe: false,
        reason:
          "A probe is already outstanding on this path. Sending a second would test the recovering dependency with the burst the breaker exists to prevent.",
      };
    }
    return {
      admitted: true,
      asProbe: true,
      reason: "The circuit is half-open and no probe is outstanding. This signal is the probe.",
    };
  }

  const openedAt = circuit.openedAt === null ? 0 : Date.parse(circuit.openedAt);
  const at = Date.parse(now);
  const elapsed = Number.isFinite(openedAt) && Number.isFinite(at) ? at - openedAt : 0;

  if (elapsed >= policy.openDurationMs) {
    return {
      admitted: true,
      asProbe: true,
      reason: `The circuit has been open for ${elapsed}ms, past the ${policy.openDurationMs}ms window. This signal is the probe that decides whether it closes.`,
    };
  }

  return {
    admitted: false,
    asProbe: false,
    reason: `The circuit is open and has been for ${elapsed}ms of the ${policy.openDurationMs}ms window. Failing fast here is the point — retrying would add load to something already unwell.`,
  };
}

/** Records an outcome and returns the circuit's new state. Pure. */
export function recordOutcome(
  circuit: Circuit,
  policy: CircuitPolicy,
  outcome: "SUCCESS" | "FAILURE",
  now: string,
): Circuit {
  if (outcome === "FAILURE") {
    const failures = circuit.consecutiveFailures + 1;
    if (circuit.state === "HALF_OPEN") {
      // A failed probe reopens immediately and does NOT need the threshold
      // again. The breaker already had evidence; the probe was the test, and
      // it failed.
      return {
        ...circuit,
        state: "OPEN",
        consecutiveFailures: failures,
        consecutiveSuccesses: 0,
        openedAt: now,
        probeInFlight: false,
        lastTransitionReason: "The half-open probe failed. Reopened without waiting for the failure threshold again — the probe WAS the test.",
      };
    }
    if (failures >= policy.failureThreshold) {
      return {
        ...circuit,
        state: "OPEN",
        consecutiveFailures: failures,
        consecutiveSuccesses: 0,
        openedAt: now,
        probeInFlight: false,
        lastTransitionReason: `${failures} consecutive failures reached the threshold of ${policy.failureThreshold}. Opened to stop spending capacity rediscovering the same fault.`,
      };
    }
    return {
      ...circuit,
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      probeInFlight: false,
      lastTransitionReason: `Failure ${failures} of ${policy.failureThreshold}. Not yet enough to open — a breaker that trips on one timeout trips constantly and then gets disabled.`,
    };
  }

  const successes = circuit.consecutiveSuccesses + 1;
  if (circuit.state === "HALF_OPEN" || circuit.state === "OPEN") {
    if (successes >= policy.successThreshold) {
      return {
        ...circuit,
        state: "CLOSED",
        consecutiveFailures: 0,
        consecutiveSuccesses: successes,
        openedAt: null,
        probeInFlight: false,
        lastTransitionReason: `${successes} consecutive successes reached the threshold of ${policy.successThreshold}. Closed.`,
      };
    }
    return {
      ...circuit,
      state: "HALF_OPEN",
      consecutiveFailures: 0,
      consecutiveSuccesses: successes,
      probeInFlight: false,
      lastTransitionReason: `Probe ${successes} of ${policy.successThreshold} succeeded. Still half-open — one success is not recovery.`,
    };
  }

  return {
    ...circuit,
    consecutiveFailures: 0,
    consecutiveSuccesses: successes,
    probeInFlight: false,
    lastTransitionReason: "Success on a closed circuit.",
  };
}

/** Marks a probe as outstanding, so a second one is refused until it resolves. */
export function markProbeInFlight(circuit: Circuit): Circuit {
  return { ...circuit, probeInFlight: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH HEALTH
// ─────────────────────────────────────────────────────────────────────────────

export interface PathObservation {
  readonly pathKey: string;
  /** Round-trip or delivery latency, in milliseconds. */
  readonly latencyMsP95: number;
  /** Messages waiting, as a fraction of the bounded queue's capacity. */
  readonly queueSaturation: number;
  /** Retries as a fraction of sends. */
  readonly retryRate: number;
  /** Deliveries that arrived more than once, as a fraction. */
  readonly duplicateRate: number;
  /** Messages that reached the dead-letter destination. */
  readonly deadLettered: number;
  /** When the last heartbeat was seen. Null means never. */
  readonly lastHeartbeatAt: string | null;
}

export interface HealthPolicy {
  readonly latencyMsP95Budget: number;
  /** Above this saturation the path is degraded, below it is fine. */
  readonly saturationDegraded: number;
  readonly retryRateDegraded: number;
  /** No heartbeat for this long and the path is considered unreachable. */
  readonly heartbeatTimeoutMs: number;
}

export type PathHealth = "HEALTHY" | "DEGRADED" | "UNREACHABLE" | "UNKNOWN";

export interface HealthAssessment {
  readonly pathKey: string;
  readonly health: PathHealth;
  /** Every reason, so an operator sees all of them rather than the first. */
  readonly reasons: readonly string[];
  /** True when the assessment rests on no observation at all. */
  readonly assessedOnNoEvidence: boolean;
}

/**
 * How healthy a path is.
 *
 * UNKNOWN is a distinct answer from HEALTHY, and keeping them apart is the
 * whole reason this returns four states rather than a boolean. A path nobody
 * has heard from is not a working path — and the failure mode where silence
 * reads as health is how a dead consumer keeps receiving traffic.
 */
export function assessPath(
  observation: PathObservation | null,
  policy: HealthPolicy,
  now: string,
): HealthAssessment {
  if (observation === null) {
    return {
      pathKey: "(unobserved)",
      health: "UNKNOWN",
      reasons: [
        "There is no observation for this path. That is not the same as healthy — nobody has heard from it, and treating silence as health is how a dead consumer keeps receiving traffic.",
      ],
      assessedOnNoEvidence: true,
    };
  }

  const reasons: string[] = [];

  if (observation.lastHeartbeatAt === null) {
    return {
      pathKey: observation.pathKey,
      health: "UNKNOWN",
      reasons: ["No heartbeat has ever been seen on this path. It may be healthy and it has not said so."],
      assessedOnNoEvidence: true,
    };
  }

  const since = Date.parse(now) - Date.parse(observation.lastHeartbeatAt);
  if (Number.isFinite(since) && since >= policy.heartbeatTimeoutMs) {
    return {
      pathKey: observation.pathKey,
      health: "UNREACHABLE",
      reasons: [
        `The last heartbeat was ${since}ms ago, past the ${policy.heartbeatTimeoutMs}ms timeout. The path is treated as unreachable rather than slow.`,
      ],
      assessedOnNoEvidence: false,
    };
  }

  if (observation.latencyMsP95 > policy.latencyMsP95Budget) {
    reasons.push(
      `p95 latency is ${observation.latencyMsP95}ms against a ${policy.latencyMsP95Budget}ms budget.`,
    );
  }
  if (observation.queueSaturation > policy.saturationDegraded) {
    reasons.push(
      `The queue is ${Math.round(observation.queueSaturation * 100)}% full, past the ${Math.round(policy.saturationDegraded * 100)}% degraded mark. A bounded queue filling is the warning before shedding starts.`,
    );
  }
  if (observation.retryRate > policy.retryRateDegraded) {
    reasons.push(
      `${Math.round(observation.retryRate * 100)}% of sends are being retried. Retries are load, and a retry rate this high is a system doing work twice.`,
    );
  }
  if (observation.deadLettered > 0) {
    reasons.push(
      `${observation.deadLettered} message${observation.deadLettered === 1 ? "" : "s"} reached the dead-letter destination. Those are not lost, and they are not delivered either — somebody has to look.`,
    );
  }
  if (observation.duplicateRate > 0) {
    reasons.push(
      `${Math.round(observation.duplicateRate * 100)}% of deliveries arrived more than once. Expected on an at-least-once lane, and only safe because the consumer is idempotent.`,
    );
  }

  return {
    pathKey: observation.pathKey,
    health: reasons.length === 0 ? "HEALTHY" : "DEGRADED",
    reasons: reasons.length === 0 ? ["Within every budget."] : reasons,
    assessedOnNoEvidence: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION AMONG PERMITTED PATHS
// ─────────────────────────────────────────────────────────────────────────────

export interface PathScore {
  readonly path: CandidatePath;
  readonly health: PathHealth;
  readonly circuitState: CircuitState;
  /** Higher is better. Ordering only — the number means nothing on its own. */
  readonly score: number;
  readonly explanation: string;
}

export interface SelectionResult {
  readonly chosen: CandidatePath | null;
  readonly considered: readonly PathScore[];
  readonly note: string;
}

/**
 * Picks one of the paths Nexus already permitted.
 *
 * Preference order, from §12: locality first, then health, then hop count. It
 * never reads the graph, so the returned path is necessarily one that was
 * handed in — a bug here can pick a slow route and cannot pick a forbidden one.
 *
 * Ties break on the path's own identity so two identical questions get the
 * same answer, which is what makes a routing decision explainable a week later.
 */
export function selectPath(
  candidates: readonly CandidatePath[],
  health: ReadonlyMap<string, PathHealth>,
  circuits: ReadonlyMap<string, CircuitState>,
  pathKey: (path: CandidatePath) => string,
): SelectionResult {
  if (candidates.length === 0) {
    return {
      chosen: null,
      considered: [],
      note: "There were no permitted paths to choose from. That is a topology answer, not a health one — Pulse cannot create a route that Nexus did not permit.",
    };
  }

  const scored: PathScore[] = candidates.map((path) => {
    const key = pathKey(path);
    const pathHealth = health.get(key) ?? "UNKNOWN";
    const circuit = circuits.get(key) ?? "CLOSED";

    let score = 0;
    const parts: string[] = [];

    if (circuit === "OPEN") {
      score -= 1000;
      parts.push("its circuit is open");
    } else if (circuit === "HALF_OPEN") {
      score -= 100;
      parts.push("its circuit is half-open and still proving itself");
    }

    switch (pathHealth) {
      case "HEALTHY":
        score += 100;
        parts.push("it is healthy");
        break;
      case "DEGRADED":
        score += 20;
        parts.push("it is degraded but usable");
        break;
      case "UNREACHABLE":
        score -= 500;
        parts.push("it is unreachable");
        break;
      case "UNKNOWN":
        // Deliberately below DEGRADED. A path that has never reported is a
        // worse bet than one that has reported problems, because the second at
        // least proves something is listening.
        score += 10;
        parts.push("nothing has been heard from it");
        break;
    }

    if (path.staysLocal) {
      score += 50;
      parts.push("it stays inside the local zone");
    }
    if (path.crossesInstance) {
      score -= 30;
      parts.push("it crosses an instance boundary");
    }
    score -= path.hops.length * 5;
    parts.push(`${path.hops.length} hop${path.hops.length === 1 ? "" : "s"}`);

    return {
      path,
      health: pathHealth,
      circuitState: circuit,
      score,
      explanation: `${key}: ${parts.join(", ")}.`,
    };
  });

  const ranked = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return pathKey(a.path).localeCompare(pathKey(b.path));
  });

  const best = ranked[0]!;

  // A path whose circuit is open is not chosen just because it is the only
  // one. Failing fast is the entire point of having opened it, and returning
  // it here would make the breaker decorative.
  if (best.circuitState === "OPEN") {
    return {
      chosen: null,
      considered: ranked,
      note: `Every permitted path has an open circuit. Nothing is chosen — failing fast is why the breakers opened, and using one anyway would make them decorative. ${ranked.length} path${ranked.length === 1 ? " was" : "s were"} considered.`,
    };
  }

  return {
    chosen: best.path,
    considered: ranked,
    note: `Chose ${pathKey(best.path)} from ${ranked.length} permitted path${ranked.length === 1 ? "" : "s"}, because ${best.explanation}`,
  };
}

/** A stable key for a path, so health and circuits can be indexed by it. */
export function defaultPathKey(path: CandidatePath): string {
  return `${path.fromNodeId}->${path.hops.map((h) => h.adjacencyId).join(">")}->${path.toNodeId}:${path.lane}`;
}
