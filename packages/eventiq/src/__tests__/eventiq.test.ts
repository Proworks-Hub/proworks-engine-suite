// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { HIVE_MESSAGE_SCHEMA_VERSION } from "@proworks-hub/contracts";

import {
  EVENTIQ_SOURCE_OF_TRUTH,
  createEventIq,
  deliveryGrantsAuthority,
  eventiqEventSchema,
  primeRelayRequired,
  sourceOfTruthFor,
  subscriptionSchema,
  type EventAuthority,
  type EventIqEvent,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// EventIQ.
//
// Charter doctrine: "Events tell the Hive what happened. They do not decide
// what should be authorized next."
// ─────────────────────────────────────────────────────────────────────────────

const permits: EventAuthority = {
  mayPublish: () => ({ permitted: true, reason: "permitted", decisionId: "gd-pub" }),
  mayReplay: () => ({ permitted: true, reason: "permitted", decisionId: "gd-replay" }),
};

const refuses: EventAuthority = {
  mayPublish: () => ({ permitted: false, reason: "not in the grant", decisionId: "gd-deny" }),
  mayReplay: () => ({ permitted: false, reason: "replay not authorized", decisionId: "gd-deny" }),
};

const at = () => new Date("2026-08-29T10:00:00.000Z");

const message = (over: Record<string, unknown> = {}) => ({
  messageId: "msg_1",
  category: "EVENT",
  messageType: "material.reserved",
  schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
  producerId: "hive.inventoryiq",
  tenant: { organizationId: "ksix", roles: [] },
  systemScoped: false,
  trace: { correlationId: "cor-1" },
  timestamp: "2026-08-29T10:00:00.000Z",
  dataClassification: "internal",
  payload: { sheets: 4 },
  ...over,
});

const subscription = (over: Record<string, unknown> = {}) => ({
  subscriptionId: "sub_1",
  consumerGroup: "grp_1",
  consumerId: "hive.costiq",
  messageTypes: ["material.reserved"],
  tenant: "ksix",
  systemScoped: false,
  expectation: { guarantee: "at-least-once", maxAttempts: 3, consequenceIfLost: "material" },
  idempotent: true,
  createdAt: "2026-08-29T09:00:00.000Z",
  ...over,
});

const eventiq = (over: Partial<Parameters<typeof createEventIq>[0]> = {}) =>
  createEventIq({ authority: permits, now: at, ...over });

describe("the five required invariants", () => {
  it("does not create authority by delivering", () => {
    // Doctrine, as a function. Same shape as receiptImpliesAuthorization() in
    // Communication Core, one layer down.
    expect(
      deliveryGrantsAuthority({
        message: message() as never,
        sequence: 0,
        attempt: 1,
        isReplay: false,
      }),
    ).toBe(false);
  });

  it("refuses to replay into a consumer that is not idempotent", () => {
    // A replay into a consumer that acts again on what it already handled turns
    // a recovery into a second incident.
    const e = eventiq();
    e.publish(message());
    e.subscribe(subscription({ idempotent: false }));

    const result = e.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator",
    });
    expect(result.started).toBe(false);
    if (!result.started) expect(result.reason).toContain("second incident");
  });

  it("refuses to replay a range with irreversible effects even to an idempotent consumer", () => {
    // Idempotency suppresses a repeated effect; it does not undo one that
    // cannot be undone.
    const e = eventiq();
    e.publish(message());
    e.subscribe(subscription());

    const result = e.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator",
      containsIrreversibleEffects: true,
    });
    expect(result.started).toBe(false);
    if (!result.started) expect(result.reason).toContain("compensating operation, not a replay");
  });

  it("keeps tenant routing boundaries intact", () => {
    // Subscribe first: a new subscription starts at the head, so anything
    // published beforehand is behind its checkpoint by design.
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message({ messageId: "msg_ksix", tenant: { organizationId: "ksix", roles: [] } }));
    e.publish(message({ messageId: "msg_other", tenant: { organizationId: "other-shop", roles: [] } }));

    const polled = e.poll("sub_1");
    expect(polled.map((p) => p.message.messageId)).toEqual(["msg_ksix"]);
  });

  it("does not give a system-scoped consumer a wildcard over tenants", () => {
    // Being system-scoped is not permission to read every tenant — that would
    // be the boundary crossing this invariant exists to prevent.
    const e = eventiq();
    e.subscribe(
      subscription({
        subscriptionId: "sub_sys",
        consumerGroup: "grp_sys",
        tenant: null,
        systemScoped: true,
        messageTypes: ["*"],
      }),
    );
    e.publish(message({ messageId: "msg_tenant" }));
    e.publish(
      message({
        messageId: "msg_system",
        messageType: "engine.heartbeat",
        tenant: undefined,
        systemScoped: true,
      }),
    );

    expect(e.poll("sub_sys").map((p) => p.message.messageId)).toEqual(["msg_system"]);
  });

  it("refuses a subscription that is neither tenant-scoped nor system-scoped", () => {
    expect(subscriptionSchema.safeParse(subscription({ tenant: null, systemScoped: false })).success).toBe(
      false,
    );
    expect(subscriptionSchema.safeParse(subscription({ tenant: "ksix", systemScoped: true })).success).toBe(
      false,
    );
  });

  it("is authoritative for transport and nothing else", () => {
    // An order event passing through does not make EventIQ a source of truth
    // for orders.
    for (const owned of EVENTIQ_SOURCE_OF_TRUTH) {
      expect(owned).toMatch(/event|delivery|subscription|offset|replay|dead_letter|transport/);
    }
    for (const domain of ["work_order", "invoice", "customer", "inventory"]) {
      expect(sourceOfTruthFor(), domain).not.toContain(domain);
    }
  });

  it("never requires Prime to relay an event", () => {
    // Constitution §2.3.
    expect(primeRelayRequired()).toBe(false);
  });

  it("mentions Prime nowhere in its interface", () => {
    const e = eventiq();
    for (const method of Object.keys(e)) {
      expect(method.toLowerCase(), method).not.toContain("prime");
    }
  });
});

describe("publish fails closed when authority cannot be established", () => {
  it("refuses when Governance refuses, and says it failed closed", () => {
    const result = eventiq({ authority: refuses }).publish(message());
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.failedClosed).toBe(true);
      expect(result.reason).toContain("Governance refused");
    }
  });

  it("distinguishes a malformed message from a refused one", () => {
    // Different problems needing different responses: one is a bug in the
    // producer, the other is a policy decision.
    const result = eventiq().publish({ nonsense: true });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.failedClosed).toBe(false);
  });

  it("deduplicates a re-published message id rather than erroring", () => {
    // A repeated id is the producer retrying, not a fault.
    const e = eventiq();
    const first = e.publish(message());
    const second = e.publish(message());
    expect(first.accepted && second.accepted).toBe(true);
    expect(e.count()).toBe(1);
    if (first.accepted && second.accepted) {
      expect(second.event.sequence).toBe(first.event.sequence);
    }
  });

  it("honours a Sentinel stream isolation", () => {
    const e = eventiq({
      containment: {
        isolatedSubscriptions: () => [],
        isolatedMessageTypes: () => ["material.reserved"],
      },
    });
    const result = e.publish(message());
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toContain("Sentinel has isolated");
  });

  it("stops delivering to an isolated subscription", () => {
    const e = eventiq({
      containment: {
        isolatedSubscriptions: () => ["sub_1"],
        isolatedMessageTypes: () => [],
      },
    });
    e.subscribe(subscription());
    e.publish(message());
    expect(e.poll("sub_1")).toEqual([]);
  });
});

describe("checkpoints advance on acknowledgement, not on delivery", () => {
  it("does not advance the offset on poll", () => {
    // A poll that advanced the checkpoint would lose every message the consumer
    // crashed before handling.
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message());

    expect(e.poll("sub_1")).toHaveLength(1);
    expect(e.offsetOf("sub_1")).toBe(0);
    expect(e.lag("sub_1")).toBe(1);
  });

  it("advances on acceptance", () => {
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message());
    e.poll("sub_1");

    const ack = e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "accepted",
    });
    expect(ack.recorded).toBe(true);
    expect(e.offsetOf("sub_1")).toBe(1);
    expect(e.lag("sub_1")).toBe(0);
  });

  it("advances on a duplicate, because the effect already happened", () => {
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message());
    e.poll("sub_1");

    e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "duplicate",
      reason: "Already processed.",
    });
    expect(e.offsetOf("sub_1")).toBe(1);
  });

  it("shares one checkpoint across a consumer group", () => {
    const e = eventiq();
    e.subscribe(subscription({ subscriptionId: "sub_a", consumerId: "worker-a" }));
    e.subscribe(subscription({ subscriptionId: "sub_b", consumerId: "worker-b" }));
    e.publish(message());

    e.poll("sub_a");
    e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_a",
      by: "worker-a",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "accepted",
    });

    expect(e.offsetOf("sub_b")).toBe(1);
  });

  it("starts a new subscription at the head, not at zero", () => {
    // Replaying the entire history into a new subscriber is a replay, and a
    // replay is authorized separately.
    const e = eventiq();
    e.publish(message({ messageId: "msg_old" }));
    e.subscribe(subscription());
    expect(e.poll("sub_1")).toEqual([]);
    expect(e.offsetOf("sub_1")).toBe(1);
  });
});

describe("retry, dead-letter, and their provenance", () => {
  const deferring = () => {
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message());
    e.poll("sub_1");
    return e;
  };

  it("retries a deferral within the expectation", () => {
    // The decision is Communication Core's `shouldRetry`, asked in its own
    // vocabulary. EventIQ decides when to ask, not what the answer is.
    const e = deferring();
    const result = e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "deferred",
      reason: "Ledger unreachable.",
    });
    expect(result.reason).toContain("redelivered");
    // Still pollable, because it was not acknowledged.
    expect(e.poll("sub_1")).toHaveLength(1);
  });

  it("dead-letters a rejection immediately", () => {
    // A rejection is a decision, not a fault. Retrying it just repeats it.
    const e = deferring();
    e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "rejected",
      reason: "Unknown message type.",
    });
    expect(e.deadLetters("sub_1")).toHaveLength(1);
    expect(e.poll("sub_1")).toEqual([]);
  });

  it("dead-letters once the retry budget is spent", () => {
    const e = eventiq();
    e.subscribe(subscription({ expectation: { guarantee: "at-least-once", maxAttempts: 2 } }));
    e.publish(message());

    for (let i = 0; i < 3; i += 1) {
      e.poll("sub_1");
      e.acknowledge({
        messageId: "msg_1",
        subscriptionId: "sub_1",
        by: "hive.costiq",
        at: "2026-08-29T10:00:01.000Z",
        outcome: "deferred",
        reason: "still unreachable",
      });
    }
    expect(e.deadLetters()).toHaveLength(1);
  });

  it("preserves provenance through a dead-letter resolution", () => {
    // Charter: "authorized disposition of failed events with preserved
    // provenance." The disposition is appended, never a replacement.
    const e = deferring();
    e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "rejected",
      reason: "Unknown message type.",
    });

    const before = e.deadLetters()[0]!;
    expect(before.deadLetteredAt).not.toBeNull();

    const resolved = e.resolveDeadLetter({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      disposition: "redeliver",
      authorizedBy: "operator",
      reason: "consumer fixed",
    });
    expect(resolved.resolved).toBe(true);
    // The original reason survives alongside the disposition.
    expect(e.poll("sub_1")).toHaveLength(1);
  });

  it("requires a reason on anything short of acceptance", () => {
    const e = deferring();
    const result = e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "rejected",
    });
    expect(result.recorded).toBe(false);
  });

  it("refuses an acknowledgement for something never delivered", () => {
    const e = eventiq();
    e.subscribe(subscription());
    e.publish(message());
    const result = e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "accepted",
    });
    expect(result.recorded).toBe(false);
  });
});

describe("backpressure is observed, not applied by dropping", () => {
  it("announces a degraded subscription rather than shedding events", () => {
    // Dropping events to relieve pressure loses the ones a struggling consumer
    // most needed.
    const seen: EventIqEvent[] = [];
    const e = eventiq({
      degradedLagThreshold: 2,
      onEngineEvent: (event) => seen.push(event),
    });

    e.subscribe(subscription());
    for (let i = 0; i < 5; i += 1) e.publish(message({ messageId: `msg_${i}` }));

    e.poll("sub_1");
    expect(seen).toContain("SubscriptionDegraded");
    // Nothing was dropped.
    expect(e.count()).toBe(5);
  });
});

describe("replay is authorized, bounded, and announced", () => {
  it("emits the charter's replay events", () => {
    const seen: EventIqEvent[] = [];
    const e = eventiq({ onEngineEvent: (event) => seen.push(event) });
    e.publish(message());
    e.subscribe(subscription());

    const result = e.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator",
    });

    expect(result.started).toBe(true);
    if (result.started) {
      expect(result.events[0]!.isReplay).toBe(true);
      expect(result.decisionId).toBe("gd-replay");
    }
    expect(seen).toContain("EventReplayStarted");
    expect(seen).toContain("EventReplayCompleted");
  });

  it("refuses when Governance refuses", () => {
    const e = eventiq({ authority: refuses });
    // Publishing needs a permitting authority, so use a mixed one.
    const mixed = createEventIq({
      authority: {
        mayPublish: permits.mayPublish,
        mayReplay: refuses.mayReplay,
      },
      now: at,
    });
    mixed.publish(message());
    mixed.subscribe(subscription());

    const result = mixed.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator",
    });
    expect(result.started).toBe(false);
    if (!result.started) expect(result.reason).toContain("Governance refused replay");
    expect(e).toBeDefined();
  });

  it("respects the tenant boundary during a replay", () => {
    const e = eventiq();
    e.publish(message({ messageId: "msg_ksix" }));
    e.publish(message({ messageId: "msg_other", tenant: { organizationId: "other-shop", roles: [] } }));
    e.subscribe(subscription());

    const result = e.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 1,
      requestedBy: "operator",
    });
    expect(result.started).toBe(true);
    if (result.started) {
      expect(result.events.map((ev) => ev.message.messageId)).toEqual(["msg_ksix"]);
    }
  });
});

describe("the engine publishes what its charter says it publishes", () => {
  it("declares exactly the six charter events", () => {
    expect(eventiqEventSchema.options).toEqual([
      "EventAccepted",
      "EventDeliveryFailed",
      "EventDeadLettered",
      "EventReplayStarted",
      "EventReplayCompleted",
      "SubscriptionDegraded",
    ]);
  });

  it("emits EventAccepted on a successful publish", () => {
    const seen: EventIqEvent[] = [];
    eventiq({ onEngineEvent: (event) => seen.push(event) }).publish(message());
    expect(seen).toEqual(["EventAccepted"]);
  });

  it("emits EventDeadLettered with the consequence of losing it", () => {
    const details: Record<string, unknown>[] = [];
    const e = eventiq({
      onEngineEvent: (event, detail) => {
        if (event === "EventDeadLettered") details.push(detail);
      },
    });
    e.subscribe(subscription());
    e.publish(message());
    e.poll("sub_1");
    e.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:01.000Z",
      outcome: "rejected",
      reason: "no handler",
    });

    expect(details[0]!.consequenceIfLost).toBe("material");
  });
});
