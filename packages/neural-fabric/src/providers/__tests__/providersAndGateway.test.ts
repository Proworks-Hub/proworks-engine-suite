/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fabricEnvelopeSchema, type FabricEnvelope } from "../../domain/envelope.js";
import { mayCarry } from "../../ports/providers.js";
import { createSubjectBus, subjectFor } from "../subjectBusProvider.js";
import { createDurableLog, topicFor } from "../durableLogProvider.js";
import {
  egressCheck,
  grantsCompose,
  ingressCheck,
  interconnectGrantSchema,
  minimize,
  type GatewayConfig,
  type InterconnectGrant,
} from "../../interconnect/gateway.js";
import type { InstanceIdentityPort } from "../../ports/securityPorts.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const envelope = (over: Record<string, unknown> = {}): FabricEnvelope =>
  fabricEnvelopeSchema.parse({
    fabricMessageId: "sig-1",
    schemaId: "forgeiq.plan.requested",
    schemaVersion: "1",
    lane: "EVENT",
    source: { capability: "ordering", participantId: "worker-7" },
    destination: { capability: "manufacturing.plan" },
    instanceId: "ksix",
    tenantId: "acme",
    correlationId: "cor-1",
    causationId: null,
    idempotencyKey: "idem-1",
    provenance: {
      originComponent: "order-ingestion",
      originInstanceId: "ksix",
      principalKind: "ENGINE",
      transformations: ["normalised", "priced"],
    },
    classification: "INTERNAL",
    priority: "NORMAL",
    contentType: "application/json",
    isTest: true,
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────────
// Two providers with opposite semantics, one port. Neutrality demonstrated by
// moving real envelopes through both, not by the interface existing.
// ─────────────────────────────────────────────────────────────────────────────

describe("the subject bus: fast, subject-based, forgetful — and honest about it", () => {
  it("delivers to a current subscriber", async () => {
    const bus = createSubjectBus();
    const received: string[] = [];
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), (json) => void received.push(json));

    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).fabricMessageId).toBe("sig-1");
  });

  it("fans out to every subscriber on the subject", async () => {
    const bus = createSubjectBus();
    let a = 0;
    let b = 0;
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), () => void (a += 1));
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), () => void (b += 1));
    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("LOSES a message published with nobody listening — the declared semantic", async () => {
    const bus = createSubjectBus();
    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });
    const late: string[] = [];
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), (json) => void late.push(json));
    expect(late).toHaveLength(0);
    // Correct for AT_MOST_ONCE lanes; a data-loss bug on the lanes it refuses.
    expect(bus.capability.durable).toBe(false);
  });

  it("routes by the envelope's OWN destination, not a fixed subject", async () => {
    // A hardcoded subject would pass every single-destination test. Two
    // destinations, one send each, delivery must follow the envelope.
    const bus = createSubjectBus();
    const planReceived: string[] = [];
    const otherReceived: string[] = [];
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), (j) => void planReceived.push(j));
    bus.subscribe(subjectFor("EVENT", "something.else"), (j) => void otherReceived.push(j));

    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope({ destination: { capability: "something.else" } })) });
    expect(otherReceived).toHaveLength(1);
    expect(planReceived).toHaveLength(0);
  });

  it("does not deliver across subjects", async () => {
    const bus = createSubjectBus();
    const wrong: string[] = [];
    bus.subscribe(subjectFor("EVENT", "something.else"), (json) => void wrong.push(json));
    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });
    expect(wrong).toHaveLength(0);
  });

  it("refuses a lane it never offered, even if a binding check was bypassed", async () => {
    const bus = createSubjectBus();
    await expect(bus.send({ lane: "COMMAND", envelopeJson: JSON.stringify(envelope({ lane: "COMMAND", authorizationEvidenceRef: "dec-1" })) })).rejects.toThrow(
      /that it did not is the finding/,
    );
  });

  it("the binding check refuses to bind it to a durable lane", () => {
    const verdict = mayCarry(createSubjectBus().capability, "COMMAND");
    expect(verdict.permitted).toBe(false);
  });

  it("throws during an injected outage and recovers after", async () => {
    const bus = createSubjectBus();
    bus.injectOutage(true);
    await expect(bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) })).rejects.toThrow(/unavailable/);
    expect((await bus.probe()).healthy).toBe(false);
    bus.injectOutage(false);
    expect((await bus.probe()).healthy).toBe(true);
  });

  it("unsubscribing stops delivery, idempotently", async () => {
    const bus = createSubjectBus();
    const received: string[] = [];
    const sub = bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), (json) => void received.push(json));
    sub.close();
    sub.close();
    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });
    expect(received).toHaveLength(0);
  });
});

describe("the durable log: partitioned, ordered, remembers — the opposite provider", () => {
  it("appends and reads back from a partition", async () => {
    const log = createDurableLog(4);
    await log.send({ lane: "COMMAND", envelopeJson: JSON.stringify(envelope({ lane: "COMMAND", authorizationEvidenceRef: "dec-1" })) });

    const heads = log.headOffsets(topicFor("COMMAND", "manufacturing.plan"));
    const partition = [...heads.entries()].find(([, head]) => head > 0)![0];
    const entries = log.read(topicFor("COMMAND", "manufacturing.plan"), partition, 0, 10);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.envelopeJson).fabricMessageId).toBe("sig-1");
  });

  it("a late consumer reads what the bus would have lost", async () => {
    // The whole difference between the two providers, in one test.
    const log = createDurableLog(4);
    await log.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) });
    // Nobody was 'listening' — and it does not matter.
    const heads = log.headOffsets(topicFor("EVENT", "manufacturing.plan"));
    const partition = [...heads.entries()].find(([, head]) => head > 0)![0];
    expect(log.read(topicFor("EVENT", "manufacturing.plan"), partition, 0, 10)).toHaveLength(1);
  });

  it("keys with the same idempotencyKey land in the same partition, in order", async () => {
    const log = createDurableLog(8);
    for (let i = 0; i < 5; i += 1) {
      await log.send({
        lane: "COMMAND",
        envelopeJson: JSON.stringify(
          envelope({ lane: "COMMAND", authorizationEvidenceRef: "dec-1", fabricMessageId: `m-${i}`, idempotencyKey: "same-key" }),
        ),
      });
    }
    const topic = topicFor("COMMAND", "manufacturing.plan");
    const heads = log.headOffsets(topic);
    const populated = [...heads.entries()].filter(([, head]) => head > 0);
    // One partition took all five, in send order — per-key ordering.
    expect(populated).toHaveLength(1);
    const entries = log.read(topic, populated[0]![0], 0, 10);
    expect(entries.map((e) => JSON.parse(e.envelopeJson).fabricMessageId)).toEqual(["m-0", "m-1", "m-2", "m-3", "m-4"]);
  });

  it("different keys spread across partitions", async () => {
    const log = createDurableLog(8);
    for (let i = 0; i < 40; i += 1) {
      await log.send({
        lane: "EVENT",
        envelopeJson: JSON.stringify(envelope({ fabricMessageId: `m-${i}`, idempotencyKey: `key-${i}` })),
      });
    }
    const heads = log.headOffsets(topicFor("EVENT", "manufacturing.plan"));
    expect([...heads.values()].filter((h) => h > 0).length).toBeGreaterThan(2);
  });

  it("offsets survive compaction — an empty partition still knows its head", async () => {
    // Otherwise offsets restart at zero and every committed consumer position
    // silently points at the wrong entries.
    const log = createDurableLog(1);
    for (let i = 0; i < 3; i += 1) {
      await log.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope({ fabricMessageId: `m-${i}`, idempotencyKey: "k" })) });
    }
    const topic = topicFor("EVENT", "manufacturing.plan");
    log.compactBefore(topic, 3);
    expect(log.read(topic, 0, 0, 10)).toHaveLength(0);
    expect(log.headOffsets(topic).get(0)).toBe(3);

    await log.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope({ fabricMessageId: "m-3", idempotencyKey: "k" })) });
    expect(log.read(topic, 0, 3, 10)[0]!.offset).toBe(3);
  });

  it("reads FROM an offset, not from the beginning", async () => {
    const log = createDurableLog(1);
    for (let i = 0; i < 3; i += 1) {
      await log.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope({ fabricMessageId: `m-${i}`, idempotencyKey: "k" })) });
    }
    const entries = log.read(topicFor("EVENT", "manufacturing.plan"), 0, 1, 10);
    expect(entries.map((e) => e.offset)).toEqual([1, 2]);
    expect(entries.map((e) => JSON.parse(e.envelopeJson).fabricMessageId)).toEqual(["m-1", "m-2"]);
  });

  it("refuses the ephemeral lanes it never offered", async () => {
    const log = createDurableLog();
    await expect(
      log.send({ lane: "HEALTH", envelopeJson: JSON.stringify(envelope({ lane: "HEALTH", idempotencyKey: undefined })) }),
    ).rejects.toThrow(/never offered/);
    expect(mayCarry(log.capability, "HEALTH").permitted).toBe(false);
  });

  it("throws during an injected outage", async () => {
    const log = createDurableLog();
    log.injectOutage(true);
    await expect(log.send({ lane: "EVENT", envelopeJson: JSON.stringify(envelope()) })).rejects.toThrow(/unavailable/);
  });

  it("the two providers disagree on every interesting semantic", () => {
    const bus = createSubjectBus().capability;
    const log = createDurableLog().capability;
    expect(bus.durable).not.toBe(log.durable);
    expect(bus.redelivers).not.toBe(log.redelivers);
    expect(bus.replayable).not.toBe(log.replayable);
    // The durable lanes never appear on the forgetful provider — EVENT is
    // legitimately on both, since a lane may have multiple candidate providers.
    for (const lane of ["COMMAND", "WORKFLOW", "EVIDENCE"] as const) {
      expect(bus.lanesOffered).not.toContain(lane);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const grant = (over: Partial<InterconnectGrant> = {}): InterconnectGrant =>
  interconnectGrantSchema.parse({
    grantId: "grant-1",
    fromInstanceId: "ksix",
    toInstanceId: "proworks",
    capabilities: ["manufacturing.plan"],
    lanes: ["EVENT", "COMMAND"],
    authorizingDecisionRef: "dec-interconnect-1",
    notAfter: at(3600),
    revoked: false,
    ...over,
  });

const instanceIdentity = (records: Record<string, string> = { "id-ksix": "ksix" }): InstanceIdentityPort => ({
  verify: async ({ presentedIdentityRef, now }) => {
    const instanceId = records[presentedIdentityRef];
    if (!instanceId) return { outcome: "REFUSED", reason: `No instance identity issued under "${presentedIdentityRef}".` };
    void now;
    return { outcome: "VERIFIED", validUntil: at(3600), detail: { instanceId, trustDomain: "hive" } };
  },
});

const gatewayConfig = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  localInstanceId: "proworks",
  grants: [grant()],
  instanceIdentity: instanceIdentity(),
  seenMessageIds: new Set(),
  knownTenants: new Set(["acme"]),
  ...over,
});

describe("egress: whether a signal may leave, checked before any transport", () => {
  const egressConfig = (over: Partial<GatewayConfig> = {}) =>
    gatewayConfig({ localInstanceId: "ksix", ...over });

  it("permits an exportable signal under a live grant, minimized", () => {
    const v = egressCheck(envelope(), egressConfig(), "proworks", T0);
    expect(v.passed).toBe(true);
    if (v.passed) {
      expect(v.grantId).toBe("grant-1");
      expect(v.minimized.source.participantId).toBeUndefined();
      expect(v.minimized.provenance.transformations).toEqual([]);
    }
  });

  it("REFUSES tenant-private data whatever the grant says", () => {
    const v = egressCheck(envelope({ classification: "TENANT_PRIVATE" }), egressConfig(), "proworks", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("CLASSIFICATION");
      expect(v.reason).toContain("a property of the data");
    }
  });

  it("REFUSES with no grant for the target", () => {
    const v = egressCheck(envelope(), egressConfig({ grants: [] }), "proworks", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.stage).toBe("GRANT");
  });

  it("a grant in the OTHER direction creates nothing in this one", () => {
    const reverse = grant({ fromInstanceId: "proworks", toInstanceId: "ksix" });
    const v = egressCheck(envelope(), egressConfig({ grants: [reverse] }), "proworks", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.reason).toContain("a grant existing in the OTHER direction creates nothing");
  });

  it("REFUSES a lane the grant does not cover", () => {
    const v = egressCheck(
      envelope({ lane: "WORKFLOW", authorizationEvidenceRef: "dec-1" }),
      egressConfig(),
      "proworks",
      T0,
    );
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("LANE");
      expect(v.reason).toContain("A grant for events is not a grant for commands");
    }
  });

  it("REFUSES a capability outside the grant's closed list", () => {
    const v = egressCheck(envelope({ destination: { capability: "payroll.run" } }), egressConfig(), "proworks", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.stage).toBe("CAPABILITY");
  });
});

describe("ingress: everything re-checked, trusting nothing about the far side", () => {
  it("admits a valid signal from a verified peer instance", async () => {
    const v = await ingressCheck(envelope(), gatewayConfig(), "id-ksix", T0);
    expect(v.passed).toBe(true);
    if (v.passed) expect(v.note).toContain("least careful peer");
  });

  it("REFUSES a forged instance identity", async () => {
    const v = await ingressCheck(envelope(), gatewayConfig(), "id-forged", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.stage).toBe("IDENTITY");
  });

  it("FAILS CLOSED when the instance verifier is unreachable", async () => {
    const down: InstanceIdentityPort = {
      verify: async () => ({ outcome: "UNAVAILABLE", reason: "verifier down" }),
    };
    const v = await ingressCheck(envelope(), gatewayConfig({ instanceIdentity: down }), "id-ksix", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.reason).toContain("not a slightly-trusted peer");
  });

  it("REFUSES a TRANSITIVE relay: B presenting A's traffic", async () => {
    // The envelope says it originated at ksix; the presenter verifies as
    // brighton. Trust is non-transitive, and this is the mechanical proof.
    const config = gatewayConfig({
      instanceIdentity: instanceIdentity({ "id-brighton": "brighton" }),
      grants: [grant({ fromInstanceId: "brighton" })],
    });
    const v = await ingressCheck(envelope(), config, "id-brighton", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("TRANSIT");
      expect(v.reason).toContain("trust is non-transitive");
    }
  });

  it("REFUSES a stale grant", async () => {
    const v = await ingressCheck(
      envelope(),
      gatewayConfig({ grants: [grant({ notAfter: at(10) })] }),
      "id-ksix",
      at(11),
    );
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("GRANT_EXPIRED");
      expect(v.reason).toContain("somebody still remembered why");
    }
  });

  it("treats the grant expiry as inclusive — expired AT the instant", async () => {
    const v = await ingressCheck(
      envelope(),
      gatewayConfig({ grants: [grant({ notAfter: at(10) })] }),
      "id-ksix",
      at(10),
    );
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.stage).toBe("GRANT_EXPIRED");
  });

  it("REFUSES an instance identity whose VERIFICATION has expired", async () => {
    // The verifier said yes, some time ago. A cached yes outlives its truth.
    const staleVerifier: InstanceIdentityPort = {
      verify: async () => ({ outcome: "VERIFIED", validUntil: at(5), detail: { instanceId: "ksix", trustDomain: "hive" } }),
    };
    const v = await ingressCheck(envelope(), gatewayConfig({ instanceIdentity: staleVerifier }), "id-ksix", at(6));
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("IDENTITY");
      expect(v.reason).toContain("expired at");
    }
  });

  it("treats a THROWING instance verifier as unavailable, which is refusal", async () => {
    // Distinct from a port that RETURNS unavailable: a thrown error must land
    // in the same fail-closed branch, not fall through to anything permissive.
    const throwing: InstanceIdentityPort = {
      verify: async () => {
        throw new Error("connection reset");
      },
    };
    const v = await ingressCheck(envelope(), gatewayConfig({ instanceIdentity: throwing }), "id-ksix", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("IDENTITY");
      expect(v.reason).toContain("not a slightly-trusted peer");
    }
  });

  it("REFUSES a revoked grant and calls the inconvenience the point", async () => {
    const v = await ingressCheck(envelope(), gatewayConfig({ grants: [grant({ revoked: true })] }), "id-ksix", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.reason).toContain("the inconvenience is the point");
  });

  it("REFUSES a tenant this instance does not know", async () => {
    const v = await ingressCheck(envelope({ tenantId: "stranger-corp" }), gatewayConfig(), "id-ksix", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("TENANT");
      expect(v.reason).toContain("probing which tenants do");
    }
  });

  it("REFUSES a replayed gateway message at the door", async () => {
    const v = await ingressCheck(
      envelope(),
      gatewayConfig({ seenMessageIds: new Set(["sig-1"]) }),
      "id-ksix",
      T0,
    );
    expect(v.passed).toBe(false);
    if (!v.passed) {
      expect(v.stage).toBe("REPLAY");
      expect(v.reason).toContain("idempotency is the last defence, not the first");
    }
  });

  it("REFUSES a malformed envelope without guessing", async () => {
    const v = await ingressCheck({ garbage: true }, gatewayConfig(), "id-ksix", T0);
    expect(v.passed).toBe(false);
    if (!v.passed) expect(v.stage).toBe("ENVELOPE");
  });
});

describe("the full A→gateway→B path, over a real provider", () => {
  it("moves a minimized envelope from instance A's fabric to instance B's", async () => {
    // Egress at A, transport in the middle, ingress at B — with B's gateway
    // re-verifying A's instance identity and re-checking the grant.
    const egress = egressCheck(envelope(), gatewayConfig({ localInstanceId: "ksix" }), "proworks", T0);
    expect(egress.passed).toBe(true);
    if (!egress.passed) throw new Error("egress must pass");

    const bus = createSubjectBus();
    const arrivedAtB: string[] = [];
    bus.subscribe(subjectFor("EVENT", "manufacturing.plan"), (json) => void arrivedAtB.push(json));
    await bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(egress.minimized) });
    expect(arrivedAtB).toHaveLength(1);

    const ingress = await ingressCheck(JSON.parse(arrivedAtB[0]!), gatewayConfig(), "id-ksix", at(1));
    expect(ingress.passed).toBe(true);
    if (ingress.passed) {
      // What crossed carries no participant ids and no internal history.
      expect(ingress.minimized.source.participantId).toBeUndefined();
      expect(ingress.minimized.provenance.transformations).toEqual([]);
      // And the origin instance survived minimization — B knows WHO, not HOW.
      expect(ingress.minimized.provenance.originInstanceId).toBe("ksix");
    }
  });

  it("a gateway outage stops cross-instance work without touching the checks", async () => {
    const bus = createSubjectBus();
    bus.injectOutage(true);
    const egress = egressCheck(envelope(), gatewayConfig({ localInstanceId: "ksix" }), "proworks", T0);
    expect(egress.passed).toBe(true);
    if (egress.passed) {
      await expect(bus.send({ lane: "EVENT", envelopeJson: JSON.stringify(egress.minimized) })).rejects.toThrow();
    }
  });

  it("grants never compose", () => {
    expect(grantsCompose()).toBe(false);
  });

  it("minimize is idempotent — a twice-minimized envelope is the same envelope", () => {
    const once = minimize(envelope());
    expect(minimize(once)).toEqual(once);
  });
});
