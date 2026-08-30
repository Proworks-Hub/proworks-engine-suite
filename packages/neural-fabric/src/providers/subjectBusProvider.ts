/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/providers/subjectBusProvider.ts
 * Module:   neural-fabric / providers
 * Purpose:  A NATS-shaped reference transport: fast, subject-based, forgetful.
 */

import type { Lane } from "../domain/lanes.js";
import type { ProviderCapability, TransportProviderPort } from "../ports/providers.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, STATED BEFORE WHAT IT DOES
//
// A reference adapter in the NATS family: subject-based addressing, immediate
// fan-out to current subscribers, and NO memory — a message published with
// nobody listening is gone, which is correct for the lanes this provider
// declares and would be a data-loss bug on the ones it refuses.
//
// It is in-process. No broker runs in this environment, and an adapter written
// against a broker that cannot be started here would ship untested — worse
// than an honest in-process reference whose semantics genuinely differ from
// the log provider next door. Provider NEUTRALITY is what these two prove:
// the same runtime, the same envelopes, two transports with opposite
// durability semantics, and nothing above the port can tell which is bound.
// Driving a real NATS deployment requires only reimplementing this file's
// interface against the client library; the kernel does not change.
//
// THE ADAPTER DECIDES NOTHING
//
// It carries bytes between a send and the matching subscribers. It does not
// parse the envelope beyond the lane it was handed, does not retry (DeliveryIQ
// owns redelivery), does not filter (Nexus and RoutingIQ already did), and
// does not persist (its capability says so, and the binding check refuses to
// bind it to a lane that needs memory).
// ─────────────────────────────────────────────────────────────────────────────

export interface SubjectSubscription {
  readonly subject: string;
  readonly deliver: (envelopeJson: string) => void;
  /** Unsubscribes. Idempotent. */
  readonly close: () => void;
}

export interface SubjectBus extends TransportProviderPort {
  /** Subscribes to a subject. `lane.capability` by convention. */
  subscribe(subject: string, deliver: (envelopeJson: string) => void): SubjectSubscription;
  /** Everything delivered so far, for tests. Not part of the port. */
  readonly deliveredCount: () => number;
  /** Simulates the transport going down. Sends throw until restored. */
  readonly injectOutage: (down: boolean) => void;
}

const CAPABILITY: ProviderCapability = {
  providerId: "subject-bus",
  family: "nats-like",
  // Ephemeral request/reply and pub/sub. Deliberately NOT the durable lanes:
  // this provider forgets, and binding it to COMMAND would lose accepted work
  // on every restart. The binding check enforces what this declaration states.
  lanesOffered: ["QUERY", "EVENT", "HEALTH"],
  durable: false,
  redelivers: false,
  orderingScopes: ["NONE", "PER_PAIR"],
  replayable: false,
  mutualTlsCapable: false,
};

/**
 * Creates the bus.
 *
 * Delivery is synchronous within `send`'s promise. That is a simplification a
 * broker does not share — and it is the CONSERVATIVE direction for tests,
 * because anything that works with synchronous delivery and idempotent
 * consumers also works delayed, while the reverse is not true.
 */
export function createSubjectBus(): SubjectBus {
  const subscribers = new Map<string, Set<(envelopeJson: string) => void>>();
  let delivered = 0;
  let down = false;

  return {
    capability: CAPABILITY,

    send: async ({ lane, envelopeJson }) => {
      if (down) {
        throw new Error("subject-bus: transport unavailable");
      }
      if (!CAPABILITY.lanesOffered.includes(lane)) {
        // Defence in depth behind the binding check. A provider that silently
        // carried a lane it never declared would make the capability table
        // decorative.
        throw new Error(`subject-bus: the ${lane} lane was never offered. The binding check should have refused this; that it did not is the finding.`);
      }
      const envelope = JSON.parse(envelopeJson) as { destination?: { capability?: string } };
      const subject = `${lane}.${envelope.destination?.capability ?? "unknown"}`;
      const set = subscribers.get(subject);
      if (!set || set.size === 0) {
        // Gone, and that is the declared semantic. AT_MOST_ONCE lanes accept
        // loss; the lanes that cannot are not offered.
        return;
      }
      for (const deliver of set) {
        deliver(envelopeJson);
        delivered += 1;
      }
    },

    probe: async () => (down ? { healthy: false, detail: "outage injected" } : { healthy: true, detail: `subject-bus: ${subscribers.size} subjects` }),

    subscribe: (subject, deliver) => {
      const set = subscribers.get(subject) ?? new Set();
      set.add(deliver);
      subscribers.set(subject, set);
      return {
        subject,
        deliver,
        close: () => void set.delete(deliver),
      };
    },

    deliveredCount: () => delivered,
    injectOutage: (state) => {
      down = state;
    },
  };
}

/** Subject for a lane+capability pair, so senders and subscribers agree. */
export function subjectFor(lane: Lane, capability: string): string {
  return `${lane}.${capability}`;
}
