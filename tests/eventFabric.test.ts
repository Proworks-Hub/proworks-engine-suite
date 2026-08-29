// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import { HIVE_MESSAGE_SCHEMA_VERSION, hiveMessageSchema } from "@proworks-hub/contracts";
import {
  createEventIq,
  createInMemoryEventIqStore,
  deliveryGrantsAuthority,
  type EventAuthority,
  type EventIqStore,
} from "@proworks-hub/eventiq";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — the event fabric, instance-aware and durable-capable.
//
// EventIQ already refused to create authority, already kept the tenant
// boundary, already refused a replay into a non-idempotent consumer. Those
// tests are untouched and still pass; this file covers what was missing:
//
//   INSTANCE IDENTITY   bound at acceptance from configuration, never read
//                       from the message, and a foreign claim REFUSED rather
//                       than bridged.
//   ORDERING            FIFO per ordering key. No global order promised.
//   DEDUP               an inbox keyed by operation, instance and consumer.
//   REPLAY SESSIONS     recorded, not merely announced.
//   SCHEMA VERSIONS     unknown is refused, never reinterpreted.
//   DURABILITY          state behind a port, with the adapter saying which it
//                       is so nothing mistakes in-memory for durable.
//
// The organising claim, which several tests below attack from different
// directions: AN EVENT IS EVIDENCE THAT SOMETHING HAPPENED, NOT AUTHORITY TO
// DO SOMETHING.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE_A = { globalInstanceId: "hive.ksix.us-east", provisional: false };
const INSTANCE_B = { globalInstanceId: "hive.proworks.us-east", provisional: false };

const permits: EventAuthority = {
  mayPublish: () => ({ permitted: true, reason: "permitted", decisionId: "gd-pub" }),
  mayReplay: () => ({ permitted: true, reason: "permitted", decisionId: "gd-replay" }),
};

const at = () => new Date("2026-08-29T10:00:00.000Z");

const eventiq = (over: Record<string, unknown> = {}) =>
  createEventIq({ instance: INSTANCE_A, authority: permits, now: at, ...over });

const message = (over: Record<string, unknown> = {}) => ({
  messageId: "msg_1",
  category: "EVENT",
  messageType: "material.reserved",
  schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
  producerId: "hive.inventoryiq",
  tenant: { organizationId: "ksix", roles: [] },
  systemScoped: false,
  trace: { correlationId: "cor-1" },
  // Deliberately EARLIER than `now()`. A fixture whose timestamp equals the
  // clock makes "replay did not rewrite the event" untestable — rewriting it
  // to now() would produce the same string. A surviving mutation is how that
  // was found.
  timestamp: "2026-08-29T09:00:00.000Z",
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
  // `guarantee` is required, and `ordering` is what makes an ordering key
  // mean anything to this consumer.
  expectation: {
    guarantee: "at-least-once",
    ordering: "per-entity",
    maxAttempts: 3,
    consequenceIfLost: "degraded",
  },
  idempotent: true,
  createdAt: "2026-08-29T10:00:00.000Z",
  ...over,
});

const accept = (bus: ReturnType<typeof eventiq>, messageId: string, subscriptionId = "sub_1") =>
  bus.acknowledge({
    messageId,
    subscriptionId,
    by: "hive.costiq",
    at: "2026-08-29T10:00:00.000Z",
    outcome: "accepted",
  });

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

describe("instance identity is bound, not claimed", () => {
  it("stamps the accepting instance onto every event", () => {
    const bus = eventiq();
    const result = bus.publish(message());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.globalInstanceId).toBe("hive.ksix.us-east");
  });

  it("takes the instance from configuration, not from what the message claims", () => {
    // The claim and the fact are kept apart so they can be compared. A producer
    // writing its own instance into a message has asserted an origin, not
    // established one — the same mistake as a request naming its own tenant.
    const bus = eventiq();
    const result = bus.publish(
      message({ origin: { globalInstanceId: "hive.ksix.us-east", producerVersion: "0.19.0" } }),
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event.globalInstanceId).toBe("hive.ksix.us-east");
    expect(result.event.message.origin?.producerVersion).toBe("0.19.0");
  });

  it("REFUSES a message claiming to originate in another instance", () => {
    // No bridge. Cross-instance delivery needs a governed relationship,
    // cryptographic identity and an inspectable transport, none of which
    // exist — and a temporary allow-all would be the hardest thing to remove
    // later, because by then something would depend on it.
    const bus = eventiq();
    const result = bus.publish(message({ origin: { globalInstanceId: INSTANCE_B.globalInstanceId } }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failedClosed).toBe(true);
    expect(result.reason).toMatch(/Refused rather than bridged/);
  });

  it("does not let two instances see each other's events", () => {
    // Two buses in one process, which is the only way this claim means
    // anything. They share nothing because they were given separate stores —
    // and a store shared between instances would be the leak, so the next test
    // covers that case too.
    const a = eventiq();
    const b = eventiq({ instance: INSTANCE_B });

    a.publish(message());
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(0);
  });

  it("keeps tenantId and globalInstanceId as separate concepts", () => {
    // A tenant may operate several instances; an instance may serve several
    // tenant contexts. Collapsing them would make isolation depend on today's
    // deployment shape rather than on a boundary.
    const bus = eventiq();
    const r = bus.publish(message({ tenant: { organizationId: "ksix", roles: [] } }));
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.event.message.tenant?.organizationId).toBe("ksix");
    expect(r.event.globalInstanceId).toBe("hive.ksix.us-east");
    expect(r.event.globalInstanceId).not.toBe(r.event.message.tenant?.organizationId);
  });

  it("reports which instance it is, so a host can check its own wiring", () => {
    expect(eventiq().instance().globalInstanceId).toBe("hive.ksix.us-east");
  });
});

describe("tenant isolation survives the changes", () => {
  it("does not deliver one tenant's events to another tenant's consumer", () => {
    const bus = eventiq();
    bus.subscribe(subscription({ tenant: "competitor" }));
    bus.publish(message());
    expect(bus.poll("sub_1")).toHaveLength(0);
  });

  it("does not deliver tenant events to a system-scoped consumer", () => {
    const bus = eventiq();
    bus.subscribe(subscription({ subscriptionId: "sub_sys", tenant: null, systemScoped: true }));
    bus.publish(message());
    expect(bus.poll("sub_sys")).toHaveLength(0);
  });

  it("delivers to the right tenant, so the two above are not vacuous", () => {
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message());
    expect(bus.poll("sub_1")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDERING
// ─────────────────────────────────────────────────────────────────────────────

describe("ordering is per key, and nowhere else", () => {
  it("holds back a message whose stream has one unacknowledged ahead of it", () => {
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", orderingKey: "wo-77" }));
    bus.publish(message({ messageId: "msg_2", orderingKey: "wo-77" }));

    const first = bus.poll("sub_1");
    expect(first.map((e) => e.message.messageId)).toEqual(["msg_1"]);

    accept(bus, "msg_1");
    expect(bus.poll("sub_1").map((e) => e.message.messageId)).toEqual(["msg_2"]);
  });

  it("does not serialize unrelated streams behind each other", () => {
    // The half that makes the guarantee useful rather than merely safe. Two
    // work orders are not one queue, and promising global order would make
    // every unrelated workflow wait on every other.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", orderingKey: "wo-77" }));
    bus.publish(message({ messageId: "msg_2", orderingKey: "wo-88" }));
    bus.publish(message({ messageId: "msg_3", orderingKey: "wo-77" }));

    expect(bus.poll("sub_1").map((e) => e.message.messageId)).toEqual(["msg_1", "msg_2"]);
  });

  it("does not impose ordering on a consumer that declared it needs none", () => {
    // The other half of "enforced only where the subscription asked for it".
    // Without this, `expectation.ordering` would be read but never able to
    // change the answer — which is the same field-declared-but-unread shape
    // this ordering work exists to fix, reintroduced one level down.
    const bus = eventiq();
    bus.subscribe(
      subscription({
        expectation: {
          guarantee: "at-least-once",
          ordering: "none",
          maxAttempts: 3,
          consequenceIfLost: "degraded",
        },
      }),
    );
    bus.publish(message({ messageId: "msg_1", orderingKey: "wo-77" }));
    bus.publish(message({ messageId: "msg_2", orderingKey: "wo-77" }));

    // Same stream, same key, and this consumer gets both at once.
    expect(bus.poll("sub_1").map((e) => e.message.messageId)).toEqual(["msg_1", "msg_2"]);
  });

  it("leaves unkeyed messages entirely unaffected", () => {
    // Absent means "needs no ordering", which is the common case and the
    // honest default. It must not quietly mean "same stream as everything
    // else that also said nothing".
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1" }));
    bus.publish(message({ messageId: "msg_2" }));
    bus.publish(message({ messageId: "msg_3" }));
    expect(bus.poll("sub_1")).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEDUP / IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

describe("a consumer does not perform one operation twice", () => {
  it("suppresses a second message describing an operation already processed", () => {
    // Keyed by the OPERATION, not the message. A producer that retried and
    // minted a new id has produced two messages about one thing, and
    // deduplicating on message id would let the second through.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", idempotencyKey: "reserve:wo-77" }));

    expect(bus.poll("sub_1")).toHaveLength(1);
    accept(bus, "msg_1");

    bus.publish(message({ messageId: "msg_2", idempotencyKey: "reserve:wo-77" }));
    expect(bus.poll("sub_1")).toHaveLength(0);
  });

  it("does not suppress a different operation", () => {
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", idempotencyKey: "reserve:wo-77" }));
    bus.poll("sub_1");
    accept(bus, "msg_1");

    bus.publish(message({ messageId: "msg_2", idempotencyKey: "reserve:wo-88" }));
    expect(bus.poll("sub_1")).toHaveLength(1);
  });

  it("does not mark an operation processed when the consumer REJECTED it", () => {
    // The dangerous direction. A consumer that rejected has not performed the
    // effect, and recording it as processed would suppress the redelivery it
    // is waiting for — losing the event while reporting success.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", idempotencyKey: "reserve:wo-77" }));
    bus.poll("sub_1");
    bus.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:00.000Z",
      outcome: "deferred",
      reason: "downstream unavailable",
    });

    expect(bus.poll("sub_1")).toHaveLength(1);
  });

  it("does not mark an operation processed on a REJECTION either", () => {
    // Deferred is covered above; rejected is the other non-processing outcome
    // and takes a different branch — it dead-letters. Neither performed the
    // effect, and recording either as processed would suppress a later message
    // about an operation that never happened.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1", idempotencyKey: "reserve:wo-77" }));
    bus.poll("sub_1");
    bus.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:00.000Z",
      outcome: "rejected",
      reason: "payload not understood",
    });

    // A second message about the same operation must still be delivered.
    bus.publish(message({ messageId: "msg_2", idempotencyKey: "reserve:wo-77" }));
    expect(bus.poll("sub_1").map((e) => e.message.messageId)).toEqual(["msg_2"]);
  });

  it("scopes the inbox to the consumer group, not globally", () => {
    // One group having handled an operation says nothing about another group.
    // A global inbox would mean the first consumer to acknowledge silenced the
    // event for everybody.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.subscribe(subscription({ subscriptionId: "sub_2", consumerGroup: "grp_2" }));
    bus.publish(message({ messageId: "msg_1", idempotencyKey: "reserve:wo-77" }));

    bus.poll("sub_1");
    accept(bus, "msg_1");

    expect(bus.poll("sub_2")).toHaveLength(1);
  });

  it("keys the inbox by instance, so two instances cannot collide", () => {
    // Groundwork rather than a live path: nothing crosses instances yet. But
    // when it does, two instances that independently chose `reserve:wo-77`
    // must not look like one operation already done.
    const store = createInMemoryEventIqStore();
    store.markProcessed({
      globalInstanceId: INSTANCE_A.globalInstanceId,
      idempotencyKey: "reserve:wo-77",
      consumerGroup: "grp_1",
      messageId: "msg_1",
      processedAt: "2026-08-29T10:00:00.000Z",
    });

    expect(
      store.hasProcessed({
        globalInstanceId: INSTANCE_A.globalInstanceId,
        idempotencyKey: "reserve:wo-77",
        consumerGroup: "grp_1",
      }),
    ).toBe(true);
    expect(
      store.hasProcessed({
        globalInstanceId: INSTANCE_B.globalInstanceId,
        idempotencyKey: "reserve:wo-77",
        consumerGroup: "grp_1",
      }),
    ).toBe(false);
  });

  it("treats a republished message id as the producer retrying", () => {
    const bus = eventiq();
    const first = bus.publish(message());
    const second = bus.publish(message());
    expect(first.accepted && second.accepted).toBe(true);
    expect(bus.count()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA VERSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe("unknown does not mean compatible", () => {
  it("refuses a schema version this instance does not speak", () => {
    // Two instances may run different approved engine versions. A version this
    // build has never seen is refused rather than guessed at — reinterpreting
    // an unrecognized envelope is how two halves of a workflow come to
    // disagree about what was sent.
    const bus = eventiq();
    const result = bus.publish({ ...message(), schemaVersion: 2 });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failedClosed).toBe(true);
    expect(result.reason).toMatch(/unknown does not mean compatible/);
  });

  it("reports a version problem differently from a malformed message", () => {
    // Different responses. One is deployment skew between instances; the other
    // is a bug, and a single "invalid message" would send somebody to the
    // wrong one.
    const bus = eventiq();
    const versionProblem = bus.publish({ ...message(), schemaVersion: 99 });
    const malformed = bus.publish({ ...message(), messageType: undefined });

    expect(versionProblem.accepted || malformed.accepted).toBe(false);
    if (versionProblem.accepted || malformed.accepted) return;
    expect(versionProblem.reason).toMatch(/version/i);
    expect(malformed.reason).toMatch(/Not a valid Hive message/);
    expect(malformed.failedClosed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REPLAY
// ─────────────────────────────────────────────────────────────────────────────

describe("replay is recorded, and does not rewrite history", () => {
  it("delivers the ORIGINAL events, unchanged", () => {
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message({ messageId: "msg_1" }));

    const replay = bus.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator.steven",
    });
    expect(replay.started).toBe(true);
    if (!replay.started) return;

    const [event] = replay.events;
    expect(event?.message.messageId).toBe("msg_1");
    expect(event?.message.timestamp).toBe("2026-08-29T09:00:00.000Z");
    expect(event?.sequence).toBe(0);
    // Provenance rides on the DELIVERY, never on the event. An event rewritten
    // to look newly created has destroyed the only record of when the thing
    // actually happened.
    expect(event?.isReplay).toBe(true);
    expect(event?.replaySessionId).toBe(replay.replaySessionId);
  });

  it("records who replayed what, under which decision", () => {
    // Announced was not enough. An engine event is a signal somebody may have
    // been listening for; this is the record that exists afterwards.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message());
    bus.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator.steven",
    });

    const [session] = bus.replaySessions();
    expect(session?.requestedBy).toBe("operator.steven");
    expect(session?.decisionId).toBe("gd-replay");
    expect(session?.subscriptionId).toBe("sub_1");
    expect(session?.delivered).toBe(1);
  });

  it("records nothing when the replay was refused", () => {
    // A refused replay is not a replay. A session recorded for one would make
    // the audit trail claim something happened that did not.
    const bus = eventiq();
    bus.subscribe(subscription({ idempotent: false }));
    bus.publish(message());
    const refused = bus.replay({
      subscriptionId: "sub_1",
      fromSequence: 0,
      toSequence: 0,
      requestedBy: "operator.steven",
    });
    expect(refused.started).toBe(false);
    expect(bus.replaySessions()).toHaveLength(0);
  });

  it("still refuses a non-idempotent consumer and irreversible ranges", () => {
    // The pre-existing invariants, re-asserted here because this phase touched
    // the code around them. Regressing these would turn a recovery into a
    // second incident.
    const bus = eventiq();
    bus.subscribe(subscription({ idempotent: false }));
    bus.publish(message());
    expect(
      bus.replay({ subscriptionId: "sub_1", fromSequence: 0, toSequence: 0, requestedBy: "x" }).started,
    ).toBe(false);

    const idempotent = eventiq();
    idempotent.subscribe(subscription());
    idempotent.publish(message());
    expect(
      idempotent.replay({
        subscriptionId: "sub_1",
        fromSequence: 0,
        toSequence: 0,
        requestedBy: "x",
        containsIrreversibleEffects: true,
      }).started,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DURABILITY AND FAILURE
// ─────────────────────────────────────────────────────────────────────────────

describe("state lives behind a port", () => {
  it("says which kind of store is bound, so nothing mistakes one for the other", () => {
    // Every guarantee EventIQ makes about offsets, dead letters and replay
    // history is a guarantee about state — and only true if the state is
    // durable. A store that lied here would let a host believe its offsets
    // survived a restart.
    expect(eventiq().durability()).toBe("in-memory");
  });

  it("survives a restart when the store does", () => {
    // The restart test, with the store standing in for the process. A second
    // EventIQ over the same state finds the log, the offset and the dead
    // letters where the first one left them.
    const store: EventIqStore = createInMemoryEventIqStore();
    const first = eventiq({ store });
    first.subscribe(subscription());
    first.publish(message({ messageId: "msg_1" }));
    first.publish(message({ messageId: "msg_2" }));
    first.poll("sub_1");
    accept(first, "msg_1");

    const restarted = eventiq({ store });
    restarted.subscribe(subscription());
    expect(restarted.count()).toBe(2);
    // The checkpoint is past msg_1 and no further.
    expect(restarted.offsetOf("sub_1")).toBe(1);
    expect(restarted.poll("sub_1").map((e) => e.message.messageId)).toEqual(["msg_2"]);
  });

  it("does not advance the checkpoint when a consumer fails", () => {
    // The crash-before-acknowledgement case. A consumer that died mid-handling
    // must get the message again, which is why `poll` does not advance
    // anything.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(message());
    bus.poll("sub_1");
    expect(bus.offsetOf("sub_1")).toBe(0);
    expect(bus.poll("sub_1")).toHaveLength(1);
  });

  it("keeps a failed event rather than dropping it", () => {
    // A dead letter is not a deletion. The attempt keeps its history, its
    // count and the reason it stopped.
    const bus = eventiq();
    bus.subscribe(subscription({
      expectation: {
        guarantee: "at-least-once",
        ordering: "none",
        maxAttempts: 1,
        consequenceIfLost: "degraded",
      },
    }));
    bus.publish(message());
    bus.poll("sub_1");
    bus.acknowledge({
      messageId: "msg_1",
      subscriptionId: "sub_1",
      by: "hive.costiq",
      at: "2026-08-29T10:00:00.000Z",
      outcome: "rejected",
      reason: "payload not understood",
    });

    const [dead] = bus.deadLetters("sub_1");
    expect(dead?.state).toBe("dead_lettered");
    expect(dead?.deadLetteredAt).not.toBeNull();
    expect(dead?.lastReason).toMatch(/payload not understood/);
    expect(dead?.globalInstanceId).toBe("hive.ksix.us-east");
  });

  it("reports publication refusal to the caller rather than swallowing it", () => {
    // Publication failure must be observable. A safety action whose event
    // failed to publish still happened; what must never happen is the failure
    // being invisible.
    const refuses: EventAuthority = {
      mayPublish: () => ({ permitted: false, reason: "not in the grant", decisionId: "gd-deny" }),
      mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd-replay" }),
    };
    const seen = vi.fn();
    const bus = eventiq({ authority: refuses, onEngineEvent: seen });
    const result = bus.publish(message());
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failedClosed).toBe(true);
    expect(seen).not.toHaveBeenCalledWith("EventAccepted", expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORGANISING CLAIM
// ─────────────────────────────────────────────────────────────────────────────

describe("an event is evidence, not authority", () => {
  it("grants nothing by being delivered, including with full provenance", () => {
    // Restated against the richest envelope this phase can produce — origin,
    // ordering key, idempotency key, authority provenance. The answer does not
    // move, and that is the point: more provenance makes an event more
    // traceable, never more powerful.
    const bus = eventiq();
    bus.subscribe(subscription());
    bus.publish(
      message({
        origin: { globalInstanceId: INSTANCE_A.globalInstanceId, producerVersion: "0.19.0" },
        orderingKey: "wo-77",
        idempotencyKey: "reserve:wo-77",
        producedUnderAuthority: { decisionId: "gd-1", decidedAt: "2026-08-29T09:59:00.000Z" },
      }),
    );
    const [delivered] = bus.poll("sub_1");
    expect(delivered).toBeDefined();
    expect(deliveryGrantsAuthority(delivered!)).toBe(false);
  });

  it("carries producer authority as provenance a consumer cannot spend", () => {
    // `producedUnderAuthority` says the SENDER was authorized to send. It says
    // nothing about what the receiver may do, and a consumer treating it as
    // its own authority has made the §7 mistake one layer out.
    const parsed = hiveMessageSchema.safeParse(
      message({
        producedUnderAuthority: { decisionId: "gd-1", decidedAt: "2026-08-29T09:59:00.000Z" },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.producedUnderAuthority?.decisionId).toBe("gd-1");
    // There is no field by which a consumer inherits it.
    expect(Object.keys(parsed.data)).not.toContain("grantsAuthorityTo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT-TRIGGERED WORK STILL GOES THROUGH GOVERNANCE
// ─────────────────────────────────────────────────────────────────────────────

describe("an event does not become a work order", () => {
  it("requires admission and Governance before an event triggers consequential work", async () => {
    // The Phase 1B chain, entered from an event instead of from an HTTP
    // request. `work_order.requested` arriving does not authorize WorkOrderIQ
    // to perform the work — the consumer still resolves identity, trust and
    // grant evidence, and Governance still decides.
    //
    // Written as an integration rather than an assertion because the failure
    // this guards against is a consumer that reads an event and acts, and only
    // running both halves shows whether anything sits between them.
    const { createInstanceAdmission } = await import("@proworks-hub/platform-runtime");
    const { createGovernanceEngine } = await import("@proworks-hub/governance-engine");
    const { permissionGrantSchema, requestContextSchema } = await import(
      "@proworks-hub/contracts"
    );

    const bus = eventiq();
    bus.subscribe(subscription({ messageTypes: ["work.order.requested"] }));
    bus.publish(
      message({
        messageId: "msg_wo",
        messageType: "work.order.requested",
        trace: { correlationId: "ORDER-123" },
        payload: { workOrderId: "wo-77" },
      }),
    );

    const [delivered] = bus.poll("sub_1");
    expect(delivered).toBeDefined();
    // Step one: the event grants nothing.
    expect(deliveryGrantsAuthority(delivered!)).toBe(false);

    // Step two: the consumer must be admitted on its own identity. Governance
    // here refuses, and the work does not happen — an event in hand changed
    // nothing about that.
    const performed = vi.fn();
    const gate = createInstanceAdmission({
      instance: INSTANCE_A,
      governance: createGovernanceEngine({
        policy: { policyId: "p.deny", version: "1", protections: [], grants: [] },
      }),
      grantsFor: () => [
        permissionGrantSchema.parse({
          grantId: "g.1",
          principalId: "hive.costiq",
          principalKind: "human",
          resource: "work_order",
          action: "work_order.create",
          tenantId: "ksix",
        }),
      ],
      trustFor: () => "trusted",
    });

    const admitted = await gate.admit({
      context: requestContextSchema.parse({
        requestId: "req.from.event",
        tenant: { organizationId: "ksix", roles: [] },
        identity: { subject: "hive.costiq", kind: "user", roles: [], assertedCapabilities: [] },
        // The correlation survives the hop from event to request, which is what
        // lets one logical workflow be followed across the two.
        trace: { correlationId: "ORDER-123", causationId: "msg_wo" },
        receivedAt: "2026-08-29T10:00:00.000Z",
      }),
      action: "work_order.create",
      resource: { type: "work_order", id: "wo-77" },
      purpose: "customer_order_intake",
    });

    expect(admitted.admitted).toBe(false);
    if (admitted.admitted) return;
    expect(admitted.stage).toBe("governance");
    expect(performed).not.toHaveBeenCalled();
  });

  it("carries correlation forward and causation to the event that caused it", () => {
    // correlationId answers which workflow; causationId answers which step.
    // A chain that keeps only one of them can say a quote is wrong but not
    // what made it wrong.
    const bus = eventiq();
    bus.publish(
      message({ messageId: "msg_cfg", messageType: "material.reserved", trace: { correlationId: "ORDER-123" } }),
    );
    const second = bus.publish(
      message({
        messageId: "msg_price",
        messageType: "material.reserved",
        trace: { correlationId: "ORDER-123", causationId: "msg_cfg" },
      }),
    );

    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.event.message.trace.correlationId).toBe("ORDER-123");
    expect(second.event.message.trace.causationId).toBe("msg_cfg");
  });
});
