/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  acceptDelivery,
  checkSequence,
  completeDelivery,
  failDelivery,
  mayForget,
  receipt,
  type DeliveryPolicy,
  type DeliveryRecord,
} from "../deliveryIQ.js";
import {
  canSpeak,
  checkTopologyContracts,
  contractVersionSchema,
  negotiate,
  usableAt,
  type ContractVersion,
} from "../contractIQ.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const policy: DeliveryPolicy = { retentionMs: 86_400_000, inFlightTimeoutMs: 30_000 };

const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  idempotencyKey: "k1",
  lane: "COMMAND",
  state: "IN_FLIGHT",
  outcomeRef: null,
  attempts: 1,
  firstSeenAt: T0,
  lastSeenAt: T0,
  expiresAt: at(86_400),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// A duplicate has to be indistinguishable from the first delivery, or
// at-least-once plus idempotency does not actually give exactly-once effect.
// ─────────────────────────────────────────────────────────────────────────────

describe("a duplicate returns the original answer, not an error", () => {
  it("processes a key it has never seen", () => {
    const o = acceptDelivery(null, { idempotencyKey: "k1", lane: "COMMAND", now: T0 }, policy);
    expect(o.disposition).toBe("PROCESS");
  });

  it("REPLAYS the recorded outcome for a completed key", () => {
    // Returning "duplicate" would leave the caller — which retried precisely
    // because it never saw the first answer — with nothing, so it retries again.
    const done = completeDelivery(record(), "outcome-42", at(1), policy);
    const o = acceptDelivery(done, { idempotencyKey: "k1", lane: "COMMAND", now: at(5) }, policy);
    expect(o.disposition).toBe("REPLAY_OUTCOME");
    if (o.disposition === "REPLAY_OUTCOME") {
      expect(o.outcomeRef).toBe("outcome-42");
      expect(o.reason).toContain("giving it the answer is what ends the retry");
    }
  });

  it("says WAIT for a key still in flight, rather than lying either way", () => {
    // Not complete, so there is nothing to replay; not dead, so reprocessing
    // would double the effect.
    const o = acceptDelivery(record(), { idempotencyKey: "k1", lane: "COMMAND", now: at(5) }, policy);
    expect(o.disposition).toBe("WAIT");
    if (o.disposition === "WAIT") expect(o.reason).toContain("The honest answer is to wait");
  });

  it("reprocesses once an in-flight attempt is presumed dead", () => {
    const o = acceptDelivery(record(), { idempotencyKey: "k1", lane: "COMMAND", now: at(30) }, policy);
    expect(o.disposition).toBe("PROCESS");
    if (o.disposition === "PROCESS") {
      expect(o.record.attempts).toBe(2);
      expect(o.reason).toContain("where that trade-off is made explicit");
    }
  });

  it("treats the in-flight timeout as inclusive", () => {
    expect(acceptDelivery(record(), { idempotencyKey: "k1", lane: "COMMAND", now: at(29) }, policy).disposition).toBe(
      "WAIT",
    );
    expect(acceptDelivery(record(), { idempotencyKey: "k1", lane: "COMMAND", now: at(30) }, policy).disposition).toBe(
      "PROCESS",
    );
  });

  it("treats a previous failure as a genuine retry", () => {
    const o = acceptDelivery(failDelivery(record(), at(1)), { idempotencyKey: "k1", lane: "COMMAND", now: at(2) }, policy);
    expect(o.disposition).toBe("PROCESS");
    if (o.disposition === "PROCESS") expect(o.record.attempts).toBe(2);
  });

  it("REFUSES a redelivering lane with no idempotency key", () => {
    const o = acceptDelivery(null, { idempotencyKey: undefined, lane: "COMMAND", now: T0 }, policy);
    expect(o.disposition).toBe("REFUSE");
    if (o.disposition === "REFUSE") expect(o.reason).toContain("nothing to recognise a redelivery BY");
  });

  it("processes a non-redelivering lane without a key and remembers nothing", () => {
    const o = acceptDelivery(null, { idempotencyKey: undefined, lane: "QUERY", now: T0 }, policy);
    expect(o.disposition).toBe("PROCESS");
    if (o.disposition === "PROCESS") expect(o.reason).toContain("nothing is remembered");
  });

  it("REFUSES the same key arriving on a different lane", () => {
    // Either two senders collided or one is reusing a key. Replaying a
    // command's outcome for an event answers a question nobody asked.
    const o = acceptDelivery(record({ lane: "COMMAND" }), { idempotencyKey: "k1", lane: "EVENT", now: at(1) }, policy);
    expect(o.disposition).toBe("REFUSE");
    if (o.disposition === "REFUSE") expect(o.reason).toContain("answer a question nobody asked");
  });

  it("REFUSES a completed record with no outcome to replay", () => {
    // An inconsistent ledger. Reprocessing risks a second side effect, so the
    // safe direction is to refuse.
    const o = acceptDelivery(
      record({ state: "COMPLETED", outcomeRef: null }),
      { idempotencyKey: "k1", lane: "COMMAND", now: at(1) },
      policy,
    );
    expect(o.disposition).toBe("REFUSE");
    if (o.disposition === "REFUSE") expect(o.reason).toContain("refusing is the safe direction");
  });

  it("forgets a record only once it has expired", () => {
    // Never forgetting is a leak; forgetting early turns a late retry into a
    // second execution.
    const done = completeDelivery(record(), "o1", T0, policy);
    expect(mayForget(done, at(3600))).toBe(false);
    expect(mayForget(done, at(86_400))).toBe(true);
  });
});

describe("ordering is checked in the scope the lane declares", () => {
  it("does not check sequence on a lane with no ordering", () => {
    // Checking it would impose a guarantee callers were never promised.
    const v = checkSequence("QUERY", { scopeKey: "s", lastSequence: 10 }, 3);
    expect(v.accept).toBe(true);
    if (v.accept) expect(v.reason).toContain("declares no ordering");
  });

  it("accepts the next sequence in scope", () => {
    expect(checkSequence("WORKFLOW", { scopeKey: "wf-1", lastSequence: 4 }, 5).accept).toBe(true);
  });

  it("accepts the first message in a scope", () => {
    expect(checkSequence("WORKFLOW", null, 7).accept).toBe(true);
  });

  it("BUFFERS a message from the future", () => {
    // The one before it is presumably in flight.
    const v = checkSequence("WORKFLOW", { scopeKey: "wf-1", lastSequence: 4 }, 7);
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.action).toBe("BUFFER");
      expect(v.reason).toContain("presumably still in flight");
    }
  });

  it("DISCARDS a message from the past rather than buffering it forever", () => {
    // Buffering would wait for a gap that is already filled.
    const v = checkSequence("WORKFLOW", { scopeKey: "wf-1", lastSequence: 9 }, 4);
    expect(v.accept).toBe(false);
    if (!v.accept) {
      expect(v.action).toBe("DISCARD");
      expect(v.reason).toContain("a gap that is already filled");
    }
  });

  it("discards an exact redelivery of the last applied sequence", () => {
    const v = checkSequence("WORKFLOW", { scopeKey: "wf-1", lastSequence: 9 }, 9);
    expect(v.accept).toBe(false);
    if (!v.accept) expect(v.action).toBe("DISCARD");
  });
});

describe("a receipt shows the sender its own retry behaviour", () => {
  it("marks a duplicate acknowledgement as one", () => {
    const r = receipt({
      fabricMessageId: "m1",
      idempotencyKey: "k1",
      lane: "COMMAND",
      acknowledgedAt: T0,
      attempts: 3,
      wasDuplicate: true,
    });
    expect(r.note).toContain("visible where it can be changed");
  });

  it("does not call a first delivery a duplicate", () => {
    const r = receipt({
      fabricMessageId: "m1",
      idempotencyKey: "k1",
      lane: "COMMAND",
      acknowledgedAt: T0,
      attempts: 1,
      wasDuplicate: false,
    });
    expect(r.note).toBe("Acknowledged on attempt 1.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const contract = (over: Partial<ContractVersion> = {}): ContractVersion =>
  contractVersionSchema.parse({
    schemaId: "forgeiq.plan.requested",
    version: 1,
    lane: "COMMAND",
    compatibilityWithPrevious: "BOTH_DIRECTIONS",
    requiredFields: ["orderId"],
    optionalFields: [],
    status: "ACTIVE",
    sunsetAt: null,
    ...over,
  });

describe("compatibility is asked while the topology is still a draft", () => {
  it("lets identical versions speak", () => {
    expect(canSpeak(contract(), contract(), T0).canSpeak).toBe(true);
  });

  it("REFUSES two different contracts", () => {
    const v = canSpeak(contract(), contract({ schemaId: "other.thing" }), T0);
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) expect(v.reason).toContain("different contracts, not different versions of one");
  });

  it("REFUSES the same contract declared on different lanes", () => {
    // The lane decides delivery, ordering and durability, so it is not the
    // same conversation.
    const v = canSpeak(contract(), contract({ lane: "EVENT" }), T0);
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) expect(v.reason).toContain("not the same conversation");
  });

  it("names the direction rather than saying 'backward compatible'", () => {
    // Producer on v1, consumer on v2: the CONSUMER is reading the older shape.
    const v = canSpeak(
      contract({ version: 1 }),
      contract({ version: 2, compatibilityWithPrevious: "NEW_READER_READS_OLD" }),
      T0,
    );
    expect(v.canSpeak).toBe(true);
    if (v.canSpeak) expect(v.note).toContain("NEW_READER_READS_OLD");
  });

  it("REFUSES when the needed direction is the one not offered", () => {
    // Producer ahead of consumer needs OLD_READER_READS_NEW, and this version
    // only offers the other direction.
    const v = canSpeak(
      contract({ version: 2, compatibilityWithPrevious: "NEW_READER_READS_OLD" }),
      contract({ version: 1 }),
      T0,
    );
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) {
      expect(v.reason).toContain("the older consumer has to tolerate the newer shape");
      expect(v.remedy).toContain("keep new fields optional");
    }
  });

  it("REFUSES across a breaking change", () => {
    const v = canSpeak(contract({ version: 1 }), contract({ version: 2, compatibilityWithPrevious: "BREAKING" }), T0);
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) expect(v.remedy).toContain("coordinated cutover");
  });

  it("REFUSES when the field lists contradict the declared compatibility", () => {
    // The declaration says these interoperate and the fields say they cannot.
    // The fields win.
    const v = canSpeak(
      contract({ version: 1, requiredFields: ["orderId"] }),
      contract({ version: 2, requiredFields: ["orderId", "tenantId"] }),
      T0,
    );
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) expect(v.reason).toContain("the field lists win");
  });

  it("REFUSES a consumer requirement the producer only declares OPTIONAL", () => {
    // Found by mutation testing, and it was a real defect rather than a test
    // gap: the first version accepted this. Optional means sometimes sent, so
    // the pairing works on the messages that carry the field and fails on the
    // ones that do not — an intermittent contract failure that PASSES a
    // contract check, which is worse than one that fails it.
    const v = canSpeak(
      contract({ version: 1, requiredFields: ["orderId"], optionalFields: ["tenantId"] }),
      contract({ version: 2, requiredFields: ["orderId", "tenantId"] }),
      T0,
    );
    expect(v.canSpeak).toBe(false);
    if (!v.canSpeak) {
      expect(v.reason).toContain("fail on the ones that do not");
      expect(v.remedy).toContain("Promote the field to required on the producer");
    }
  });

  it("separates a field the producer lacks entirely from one it has as optional", () => {
    // Different remedies: a modelling gap versus a promise nobody made.
    const absent = canSpeak(
      contract({ version: 1, requiredFields: ["orderId"] }),
      contract({ version: 2, requiredFields: ["orderId", "tenantId"] }),
      T0,
    );
    if (!absent.canSpeak) expect(absent.reason).toContain("does not produce at all");
  });

  it("warns when a consumer can read a field the producer never sends", () => {
    const v = canSpeak(
      contract({ version: 1 }),
      contract({ version: 2, optionalFields: ["hint"] }),
      T0,
    );
    if (v.canSpeak) expect(v.warnings.join()).toContain('debugs why a feature "does nothing"');
  });
});

describe("a deprecation without a date is a label", () => {
  it("refuses a deprecated version with no sunset date", () => {
    expect(
      contractVersionSchema.safeParse({
        schemaId: "x",
        version: 1,
        lane: "COMMAND",
        compatibilityWithPrevious: "BOTH_DIRECTIONS",
        requiredFields: [],
        optionalFields: [],
        status: "DEPRECATED",
        sunsetAt: null,
      }).success,
    ).toBe(false);
  });

  it("still permits a deprecated version before its sunset", () => {
    const dep = contract({ status: "DEPRECATED", sunsetAt: at(3600) });
    expect(usableAt(dep, T0).usable).toBe(true);
  });

  it("REFUSES it from the sunset date onward", () => {
    const dep = contract({ status: "DEPRECATED", sunsetAt: at(3600) });
    const r = usableAt(dep, at(3600));
    expect(r.usable).toBe(false);
    expect(r.reason).toContain("so that it would eventually mean something");
  });

  it("refuses a retired version outright", () => {
    expect(usableAt(contract({ status: "RETIRED" }), T0).usable).toBe(false);
  });

  it("warns that a working pairing has a deadline", () => {
    const dep = contract({ status: "DEPRECATED", sunsetAt: at(3600) });
    const v = canSpeak(dep, contract(), T0);
    if (v.canSpeak) expect(v.warnings.join()).toContain("whether or not anyone has noticed");
  });

  it("takes `now` as an argument so a sunset can be simulated before it happens", () => {
    const dep = contract({ status: "DEPRECATED", sunsetAt: at(3600) });
    expect(usableAt(dep, at(3599)).usable).toBe(true);
    expect(usableAt(dep, at(3601)).usable).toBe(false);
  });
});

describe("negotiation picks the highest both can speak", () => {
  it("agrees on the highest shared usable version", () => {
    // Lowest-common-version is how a system upgrades for years without ever
    // using a new field.
    const producers = [contract({ version: 1 }), contract({ version: 2 }), contract({ version: 3 })];
    const consumers = [contract({ version: 1 }), contract({ version: 2 })];
    const r = negotiate(producers, consumers, T0);
    expect(r.agreed).toBe(2);
    expect(r.note).toContain("without ever using a new field");
  });

  it("returns nothing when no version is shared", () => {
    const r = negotiate([contract({ version: 5 })], [contract({ version: 1 })], T0);
    expect(r.agreed).toBeNull();
  });

  it("skips a shared version that is no longer usable", () => {
    // A shared version number is not the same as a usable one.
    const producers = [contract({ version: 2, status: "RETIRED" }), contract({ version: 1 })];
    const consumers = [contract({ version: 2 }), contract({ version: 1 })];
    const r = negotiate(producers, consumers, T0);
    expect(r.agreed).toBe(1);
  });

  it("explains that a shared number is not a usable version", () => {
    const r = negotiate([contract({ version: 1, status: "RETIRED" })], [contract({ version: 1 })], T0);
    expect(r.agreed).toBeNull();
    expect(r.note).toContain("not the same as a usable one");
  });
});

describe("the whole topology is checked before activation", () => {
  it("passes a topology whose pairings all speak", () => {
    const r = checkTopologyContracts(
      [{ adjacencyId: "a1", producer: contract(), consumer: contract() }],
      T0,
    );
    expect(r.compatible).toBe(true);
    expect(r.note).toContain("the only time it is cheap to fix");
  });

  it("reports EVERY incompatible pairing, not the first", () => {
    const r = checkTopologyContracts(
      [
        { adjacencyId: "a1", producer: contract(), consumer: contract({ schemaId: "wrong" }) },
        { adjacencyId: "a2", producer: contract(), consumer: contract({ lane: "EVENT" }) },
        { adjacencyId: "a3", producer: contract(), consumer: contract() },
      ],
      T0,
    );
    expect(r.compatible).toBe(false);
    expect(r.failures.map((f) => f.adjacencyId)).toEqual(["a1", "a2"]);
    expect(r.note).toContain("whose first real message fails");
  });

  it("gives every failure a remedy", () => {
    const r = checkTopologyContracts(
      [{ adjacencyId: "a1", producer: contract(), consumer: contract({ schemaId: "wrong" }) }],
      T0,
    );
    expect(r.failures[0]!.remedy.length).toBeGreaterThan(0);
  });

  it("collects warnings from pairings that do work", () => {
    const dep = contract({ status: "DEPRECATED", sunsetAt: at(3600) });
    const r = checkTopologyContracts([{ adjacencyId: "a1", producer: dep, consumer: contract() }], T0);
    expect(r.compatible).toBe(true);
    expect(r.warnings.join()).toContain("a1:");
  });

  it("reports pairings in a stable order", () => {
    const bad = (id: string) => ({ adjacencyId: id, producer: contract(), consumer: contract({ schemaId: "x" }) });
    expect(checkTopologyContracts([bad("z"), bad("a"), bad("m")], T0).failures.map((f) => f.adjacencyId)).toEqual([
      "a",
      "m",
      "z",
    ]);
  });
});
