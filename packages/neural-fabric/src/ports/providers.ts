/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/ports/providers.ts
 * Module:   neural-fabric / ports
 * Purpose:  Transports are replaceable, and the Fabric proves it rather than saying it.
 */

import { z } from "zod";

import { LANE_SEMANTICS, laneSchema, type Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// NO PROVIDER IS CONSTITUTIONALLY REQUIRED
//
// §33.6 makes it a hard gate: "No single transport provider is
// constitutionally required; provider failure must have a defined degraded
// behaviour." §30 explains why the alternative is tempting — combining NATS,
// Kafka, RabbitMQ and Temporal into one executable sounds thorough and
// produces something fragile that requires all four to be healthy at once.
//
// So a provider DECLARES which lanes it can carry and which semantics it can
// honour, and the Fabric checks the declaration against what the lane
// requires. A provider that cannot persist may not carry COMMAND, whatever its
// documentation says about durability.
//
// THE DEGRADED BEHAVIOUR IS DECLARED IN ADVANCE
//
// Not discovered. Every lane has a stated answer to "what happens when the
// provider carrying this fails", written while somebody is thinking clearly
// rather than during the outage. For most lanes the answer is to fail over;
// for HEALTH it is to drop, which is fine; for COMMAND it is to refuse new
// work and keep what was accepted, which is the only honest option when
// nothing can be persisted.
//
// A CAPABILITY CLAIM IS CHECKED, NOT TRUSTED
//
// A provider adapter says what it can do. If the Fabric believed it, then
// binding a fast in-memory transport to the workflow lane would silently make
// long-running work non-durable, and the discovery would be a restart during
// which every workflow vanished.
// ─────────────────────────────────────────────────────────────────────────────

export const providerCapabilitySchema = z
  .object({
    providerId: z.string().min(1),
    /** What the adapter is built on. Documentation, not a decision. */
    family: z.string().min(1),
    /** Lanes this provider offers to carry. Checked against what they need. */
    lanesOffered: z.array(laneSchema).min(1),
    /** Whether it can persist a message across a process restart. */
    durable: z.boolean(),
    /** Whether it can redeliver until acknowledged. */
    redelivers: z.boolean(),
    /** Whether it can preserve order, and in what scope. */
    orderingScopes: z.array(z.enum(["NONE", "PER_KEY", "PER_PAIR", "PER_PARTITION", "STRICT_SEQUENCE"])),
    /** Whether it can replay history to a new consumer. */
    replayable: z.boolean(),
    /** Whether it supports mutually authenticated encrypted channels (§33.3). */
    mutualTlsCapable: z.boolean(),
  })
  .strict();
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export interface BindingProblem {
  readonly lane: Lane;
  readonly requirement: string;
  readonly consequence: string;
}

export type BindingVerdict =
  | { readonly permitted: true; readonly note: string }
  | { readonly permitted: false; readonly problems: readonly BindingProblem[]; readonly note: string };

/**
 * Whether a provider may carry a lane.
 *
 * Checks the declared capability against what the lane's semantics require.
 * Every mismatch is returned, because an adapter being wired up should learn
 * all of its gaps at once rather than one deploy at a time.
 */
export function mayCarry(provider: ProviderCapability, lane: Lane): BindingVerdict {
  const semantics = LANE_SEMANTICS[lane];
  const problems: BindingProblem[] = [];

  if (!provider.lanesOffered.includes(lane)) {
    return {
      permitted: false,
      problems: [
        {
          lane,
          requirement: `"${provider.providerId}" does not offer the ${lane} lane.`,
          consequence: "Binding it anyway would route traffic through an adapter that never claimed it could carry it.",
        },
      ],
      note: `"${provider.providerId}" does not offer ${lane}.`,
    };
  }

  if (semantics.durable && !provider.durable) {
    problems.push({
      lane,
      requirement: `The ${lane} lane is durable and "${provider.providerId}" cannot persist across a restart.`,
      consequence:
        lane === "WORKFLOW"
          ? "Long-running work would vanish on a restart, and the discovery would be a restart during which every workflow disappeared."
          : "Accepted work would be lost on a restart with no record of which messages were in flight.",
    });
  }

  if (semantics.delivery === "AT_LEAST_ONCE" && !provider.redelivers) {
    problems.push({
      lane,
      requirement: `The ${lane} lane redelivers until acknowledged and "${provider.providerId}" delivers once.`,
      consequence:
        "A message lost in transit would never arrive again, and nothing would report it — the sender saw a successful send and the receiver saw nothing.",
    });
  }

  if (!provider.orderingScopes.includes(semantics.ordering)) {
    problems.push({
      lane,
      requirement: `The ${lane} lane needs ${semantics.ordering} ordering and "${provider.providerId}" offers ${provider.orderingScopes.join(", ") || "none"}.`,
      consequence:
        semantics.ordering === "STRICT_SEQUENCE"
          ? "Workflow steps would run out of order, which looks like a logic bug in whatever engine owns the workflow."
          : "Consumers would see updates to one entity out of sequence and would apply the older one last.",
    });
  }

  if (semantics.replayable && !provider.replayable) {
    problems.push({
      lane,
      requirement: `The ${lane} lane is replayable and "${provider.providerId}" cannot replay.`,
      consequence: "A new consumer could not read history, and a recovery that depended on replay would fail at the moment it was needed.",
    });
  }

  if (semantics.requiresAuthorizationEvidence && !provider.mutualTlsCapable) {
    problems.push({
      lane,
      requirement: `The ${lane} lane carries consequential signals and "${provider.providerId}" cannot establish a mutually authenticated channel.`,
      consequence:
        "The transport could not confirm who it is talking to, so authorization evidence would travel over a channel that cannot vouch for either end.",
    });
  }

  if (problems.length > 0) {
    return {
      permitted: false,
      problems,
      note: `"${provider.providerId}" cannot carry the ${lane} lane: ${problems.length} requirement${problems.length === 1 ? " is" : "s are"} unmet. A capability claim is checked rather than trusted.`,
    };
  }

  return {
    permitted: true,
    note: `"${provider.providerId}" satisfies every requirement of the ${lane} lane.`,
  };
}

/** What happens to a lane when the provider carrying it fails. */
export type DegradedBehaviour =
  /** Move to another bound provider that can carry the lane. */
  | "FAIL_OVER"
  /** Refuse new work and keep what was already accepted. */
  | "REFUSE_NEW_ACCEPT_INFLIGHT"
  /** Drop it. Only ever correct for expendable traffic. */
  | "DROP"
  /** Stop entirely. Only when continuing would be unsafe. */
  | "HALT";

export interface LaneDegradation {
  readonly lane: Lane;
  readonly behaviour: DegradedBehaviour;
  readonly rationale: string;
}

/**
 * The declared answer to "what happens when this lane's provider fails".
 *
 * Written in advance rather than decided during the outage. §33.6 requires a
 * defined degraded behaviour, and "defined" means somebody chose it while
 * thinking clearly.
 */
export const LANE_DEGRADATION: Readonly<Record<Lane, LaneDegradation>> = Object.freeze({
  QUERY: {
    lane: "QUERY",
    behaviour: "FAIL_OVER",
    rationale:
      "A query has a caller waiting. Failing over is worth trying, and failing fast afterwards is better than a long timeout — the caller can decide what to do with an error and cannot decide anything while blocked.",
  },
  COMMAND: {
    lane: "COMMAND",
    behaviour: "REFUSE_NEW_ACCEPT_INFLIGHT",
    rationale:
      "Accepting a command means promising it will happen. With no durable provider that promise cannot be kept, so new ones are refused — and the ones already accepted are honoured, because breaking an existing promise is worse than declining a new one.",
  },
  EVENT: {
    lane: "EVENT",
    behaviour: "FAIL_OVER",
    rationale: "Events are replayable, so a failover that loses position is recoverable.",
  },
  STREAM: {
    lane: "STREAM",
    behaviour: "REFUSE_NEW_ACCEPT_INFLIGHT",
    rationale:
      "A stream's value is its ordered history. Failing over to a provider with no history would produce a stream that starts mid-sentence, and consumers would treat the gap as an absence of events rather than as missing data.",
  },
  WORKFLOW: {
    lane: "WORKFLOW",
    behaviour: "HALT",
    rationale:
      "A workflow that continues without durable history repeats side effects it already performed. Halting is expensive and recoverable; continuing is cheap and produces duplicate real-world actions.",
  },
  EVIDENCE: {
    lane: "EVIDENCE",
    behaviour: "REFUSE_NEW_ACCEPT_INFLIGHT",
    rationale:
      "Evidence is never dropped. If it cannot be recorded, the operation that would have produced it is refused — an action taken with no record of it is worse than an action not taken.",
  },
  HEALTH: {
    lane: "HEALTH",
    behaviour: "DROP",
    rationale:
      "A superseded heartbeat has no value. Dropping is correct here and only here, and the absence of heartbeats is itself the signal that something is wrong.",
  },
  ARTIFACT: {
    lane: "ARTIFACT",
    behaviour: "FAIL_OVER",
    rationale: "The lane carries a reference; the artifact itself lives in FileIQ and is unaffected by a transport failure.",
  },
});

export interface CoverageGap {
  readonly lane: Lane;
  readonly note: string;
}

/**
 * Whether the bound providers leave any lane with a single point of failure.
 *
 * The hard gate, asked of a real set of adapters. A lane carried by exactly
 * one provider is not a violation — it is a fact, and one worth stating before
 * the provider fails rather than during.
 */
export function assessCoverage(
  providers: readonly ProviderCapability[],
): {
  readonly uncovered: readonly CoverageGap[];
  readonly singleProvider: readonly CoverageGap[];
  readonly note: string;
} {
  const uncovered: CoverageGap[] = [];
  const single: CoverageGap[] = [];

  for (const lane of Object.keys(LANE_SEMANTICS) as Lane[]) {
    const able = providers.filter((p) => mayCarry(p, lane).permitted);

    if (able.length === 0) {
      uncovered.push({
        lane,
        note: `No bound provider can carry the ${lane} lane. Traffic on it has nowhere to go, and the degraded behaviour (${LANE_DEGRADATION[lane].behaviour}) is in force permanently rather than during an incident.`,
      });
      continue;
    }
    if (able.length === 1) {
      single.push({
        lane,
        note: `Only "${able[0]!.providerId}" can carry the ${lane} lane. Its failure means ${LANE_DEGRADATION[lane].behaviour} with no alternative — ${LANE_DEGRADATION[lane].rationale}`,
      });
    }
  }

  return {
    uncovered,
    singleProvider: single,
    note:
      uncovered.length > 0
        ? `${uncovered.length} lane${uncovered.length === 1 ? " has" : "s have"} no capable provider at all.`
        : single.length > 0
          ? `Every lane is covered, and ${single.length} depend${single.length === 1 ? "s" : ""} on a single provider. That is a fact rather than a fault, and it is better known now than during the failure.`
          : `Every lane has at least two capable providers. No single transport failure removes a lane, which is what §33.6 asks for.`,
  };
}

/**
 * Whether any provider is constitutionally required.
 *
 * Always false. §33.6's hard gate, as a function CI can assert — the pressure
 * to depend on one provider's distinctive feature arrives as an optimisation
 * and is only visible as a dependency afterwards.
 */
export function providerIsRequired(): false {
  return false;
}

/** The port a host binds an actual transport behind. */
export interface TransportProviderPort {
  readonly capability: ProviderCapability;
  /** Sends. Returns nothing useful — delivery is DeliveryIQ's question. */
  send(input: { readonly lane: Lane; readonly envelopeJson: string }): Promise<void>;
  /** Whether the provider believes it is healthy. Advisory; Pulse decides. */
  probe(): Promise<{ readonly healthy: boolean; readonly detail: string }>;
}
