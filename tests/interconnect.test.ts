// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  handoffEnvelopeSchema,
  instanceLinkSchema,
  linkGrantsDatabaseAccess,
  linkPermits,
  trustIsTransitive,
} from "@proworks-hub/contracts";
import {
  createInMemoryInterconnectStore,
  createInterconnectGateway,
  createRelationshipRegistry,
  gatewayMayOpenOthersMail,
  ledgerStoresPayloads,
  type EnvelopeVerifier,
} from "@proworks-hub/platform-runtime";
import { createEventIq, type EventAuthority } from "@proworks-hub/eventiq";

// ─────────────────────────────────────────────────────────────────────────────
// THE INTERCONNECT FABRIC — the door in the wall every earlier phase held shut.
//
// The ten acceptance tests the directive names:
//
//   1. KSix sends an authorized handoff to ProWorks and gets status back,
//      without either reading the other's database.
//   2. MakerOps→ProWorks does not permit MakerOps→KSix.
//   3. A forged sender signature is rejected.
//   4. An expired or revoked link is rejected immediately.
//   5. A duplicate idempotency key creates no duplicate downstream work.
//   6. The recipient can prove which prior stages were completed, and by whom.
//   7. A schema-incompatible recipient fails safely, with actionable metadata.
//   8. A sensitive transfer can carry stricter policy than a commercial one.
//   9. Cross-instance events preserve correlation and causation.
//  10. A collective outage does not silently widen permissions.
//
// THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, and several tests below
// exist only to pin it: signature before anything reads a field, destination
// before authorization, authorization before replay. Each of those orderings
// is the kind of thing a later refactor "simplifies".
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "hive.ksix";
const PROWORKS = "hive.proworks";
const MAKEROPS = "hive.makerops";
const NOW = () => new Date("2026-08-30T12:00:00.000Z");

const link = (over: Record<string, unknown> = {}) => ({
  linkId: "link.ksix.proworks",
  sourceInstanceId: KSIX,
  destinationInstanceId: PROWORKS,
  relationshipType: "manufacturing-supplier",
  allowedCapabilities: ["SEND_WORK", "RECEIVE_STATUS"],
  allowedContractTypes: ["manufacturing.package"],
  allowedPurposes: ["fulfil_customer_order"],
  maxSensitivity: "internal",
  trustTier: "attestation_accepted",
  createdBy: "user.steven",
  approvedBy: "gd.link.1",
  validFrom: "2026-01-01T00:00:00.000Z",
  status: "active",
  policyVersion: "p1",
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  envelopeId: "env.1",
  globalCorrelationId: "ORDER-123",
  sourceInstanceId: KSIX,
  destinationInstanceId: PROWORKS,
  sourceEngineId: "forgeiq",
  destinationCapability: "SEND_WORK",
  contractType: "manufacturing.package",
  contractVersion: "1.0.0",
  purpose: "fulfil_customer_order",
  createdAt: "2026-08-30T11:59:00.000Z",
  idempotencyKey: "order-123-handoff",
  priorStageAttestations: [
    {
      stage: "configuration",
      completedBy: KSIX,
      completedAt: "2026-08-30T11:50:00.000Z",
      resultDigest: "sha256:cfg",
      attestationRef: "sig:ksix:cfg",
    },
    {
      stage: "pricing",
      completedBy: KSIX,
      completedAt: "2026-08-30T11:55:00.000Z",
      resultDigest: "sha256:price",
      attestationRef: "sig:ksix:price",
    },
  ],
  payload: { sku: "FIREPIT-24", quantity: 1 },
  sensitivityClass: "internal",
  policyLabels: [],
  provenanceRefs: ["ledger:ksix:exec-9"],
  integrityHash: "sha256:body",
  senderSignature: "sig:ksix:env.1",
  acknowledgementRequired: true,
  ...over,
});

const goodVerifier: EnvelopeVerifier = {
  verifySignature: (e) =>
    e.senderSignature.startsWith(`sig:${e.sourceInstanceId.replace("hive.", "")}`)
      ? { valid: true, reason: "signed by the claimed source" }
      : { valid: false, reason: "signature does not match the claimed source" },
  verifyIntegrity: (e) =>
    e.integrityHash === "sha256:body"
      ? { valid: true, reason: "body matches" }
      : { valid: false, reason: "body does not match its hash" },
};

function gateway(over: Record<string, unknown> = {}) {
  const relationships = createRelationshipRegistry();
  relationships.grant(link());
  return {
    relationships,
    gate: createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: (type, version) =>
        version.startsWith("1.")
          ? { valid: true, reason: "supported" }
          : {
              valid: false,
              reason: `This instance speaks ${type} 1.x and received ${version}. Send 1.x or ask for an upgrade.`,
            },
      now: NOW,
      ...over,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE HAPPY PATH
// ─────────────────────────────────────────────────────────────────────────────

describe("one instance hands work to another without either reading the other", () => {
  it("accepts an authorized handoff", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.duplicate).toBe(false);
    expect(result.envelope.globalCorrelationId).toBe("ORDER-123");
  });

  it("carries no way to reach the other instance's stores", () => {
    // Structural. A link names capabilities, contracts and purposes; none of
    // them is a table, a queue, an index or a cache, so there is no shape here
    // that could express "read their store".
    const parsed = instanceLinkSchema.parse(link());
    const asText = JSON.stringify(parsed);
    for (const forbidden of ["database", "query", "table", "connectionString", "dsn"]) {
      expect(asText).not.toContain(forbidden);
    }
    expect(linkGrantsDatabaseAccess()).toBe(false);
  });

  it("keeps the ledger to metadata", () => {
    // A ledger holding payloads would be the global raw-payload store the
    // architecture exists to avoid, arrived at through the audit trail.
    const { gate } = gateway();
    gate.accept(envelope({ payload: { secretCustomerName: "Acme Industrial" } }));
    const [entry] = gate.ledger();
    expect(JSON.stringify(entry)).not.toContain("Acme Industrial");
    expect(entry?.contractType).toBe("manufacturing.package");
    expect(ledgerStoresPayloads()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NO TRANSITIVE TRUST
// ─────────────────────────────────────────────────────────────────────────────

describe("trust does not travel through a third party", () => {
  it("does not let MakerOps reach KSix by way of ProWorks", () => {
    // The exact case the directive names. Two links into ProWorks create no
    // link between their sources.
    const relationships = createRelationshipRegistry();
    relationships.grant(link());
    relationships.grant(
      link({ linkId: "link.makerops.proworks", sourceInstanceId: MAKEROPS }),
    );

    expect(relationships.linkFor(MAKEROPS, PROWORKS)).not.toBeNull();
    expect(relationships.linkFor(KSIX, PROWORKS)).not.toBeNull();
    expect(relationships.linkFor(MAKEROPS, KSIX)).toBeNull();
    expect(trustIsTransitive()).toBe(false);
  });

  it("refuses the handoff that chain would have allowed", () => {
    const relationships = createRelationshipRegistry();
    relationships.grant(link());
    relationships.grant(link({ linkId: "link.mo.pw", sourceInstanceId: MAKEROPS }));

    const gate = createInterconnectGateway({
      instanceId: KSIX,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: true, reason: "ok" }),
      now: NOW,
    });

    const result = gate.accept(
      envelope({
        sourceInstanceId: MAKEROPS,
        destinationInstanceId: KSIX,
        senderSignature: "sig:makerops:env.1",
      }),
    );
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("authorization");
    expect(result.reason).toMatch(/an absent relationship is not a weak permission/);
  });

  it("refuses to apply a link belonging to a different source", () => {
    // `linkPermits` is exported and pure, so it is tested on its own terms.
    // Inside the gateway these two checks are shadowed — the link is looked up
    // BY direction, so a returned link always matches — and a mutation proved
    // it. They are the guard for every other caller, and for the day the
    // lookup changes.
    const verdict = linkPermits({
      link: instanceLinkSchema.parse(link({ sourceInstanceId: MAKEROPS })),
      envelope: handoffEnvelopeSchema.parse(envelope()),
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/This link is from/);
  });

  it("refuses to apply a link pointing at a different destination", () => {
    const verdict = linkPermits({
      link: instanceLinkSchema.parse(link({ destinationInstanceId: MAKEROPS })),
      envelope: handoffEnvelopeSchema.parse(envelope()),
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/A grant to one destination is not a grant to another/);
  });

  it("permits the matching link, so those two are not vacuous", () => {
    expect(
      linkPermits({
        link: instanceLinkSchema.parse(link()),
        envelope: handoffEnvelopeSchema.parse(envelope()),
        now: "2026-08-30T12:00:00.000Z",
      }).permitted,
    ).toBe(true);
  });

  it("refuses a link from an instance to itself", () => {
    expect(
      instanceLinkSchema.safeParse(link({ destinationInstanceId: KSIX })).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. IDENTITY, EXPIRY, REVOCATION
// ─────────────────────────────────────────────────────────────────────────────

describe("a forged or stale sender gets nothing", () => {
  it("rejects a forged signature", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ senderSignature: "sig:someone-else:env.1" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("signature");
  });

  it("checks the signature BEFORE reading any other field", () => {
    // The ordering that matters most. An envelope with a forged signature AND
    // an unauthorized source must fail on the signature — if it failed on
    // authorization, the gateway would have branched on unverified input.
    const { gate } = gateway();
    const result = gate.accept(
      envelope({ sourceInstanceId: MAKEROPS, senderSignature: "sig:forged:x" }),
    );
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("signature");
  });

  it("rejects a tampered body under a valid signature", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ integrityHash: "sha256:tampered" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("integrity");
    expect(result.reason).toMatch(/somebody else's signature being reused/);
  });

  it("rejects a revoked link immediately", () => {
    const { gate, relationships } = gateway();
    expect(gate.accept(envelope()).accepted).toBe(true);

    relationships.revoke("link.ksix.proworks", "partner contract ended", "user.steven");
    const after = gate.accept(envelope({ envelopeId: "env.2", idempotencyKey: "k2" }));
    expect(after.accepted).toBe(false);
    if (after.accepted) return;
    expect(after.stage).toBe("authorization");
    expect(after.reason).toMatch(/partner contract ended/);
  });

  it("rejects an expired link", () => {
    const relationships = createRelationshipRegistry();
    relationships.grant(link({ expiresAt: "2026-08-01T00:00:00.000Z" }));
    const gate = createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: true, reason: "ok" }),
      now: NOW,
    });
    const result = gate.accept(envelope());
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toMatch(/expired at/);
  });

  it("rejects a link that has not started yet", () => {
    const relationships = createRelationshipRegistry();
    relationships.grant(link({ validFrom: "2027-01-01T00:00:00.000Z" }));
    const gate = createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: true, reason: "ok" }),
      now: NOW,
    });
    expect(gate.accept(envelope()).accepted).toBe(false);
  });

  it("rejects a handoff that expired in flight", () => {
    // Separate from link expiry: the LINK may be valid while this particular
    // baton has gone stale. A handoff with an expiry nobody enforced is an
    // instruction that can be replayed a month later.
    const { gate } = gateway();
    const result = gate.accept(
      envelope({ expiresAt: "2026-08-30T11:00:00.000Z", idempotencyKey: "kx" }),
    );
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("freshness");
  });

  it("accepts one that has not expired, so the check is not vacuous", () => {
    const { gate } = gateway();
    expect(
      gate.accept(envelope({ expiresAt: "2026-08-30T23:00:00.000Z", idempotencyKey: "ky" })).accepted,
    ).toBe(true);
  });

  it("keeps a revoked link's record so past transfers stay explicable", () => {
    const { relationships } = gateway();
    relationships.revoke("link.ksix.proworks", "ended", "user.steven");
    expect(relationships.all()).toHaveLength(1);
    expect(relationships.linkFor(KSIX, PROWORKS)?.status).toBe("revoked");
  });

  it("refuses a second active link for one direction", () => {
    // "What may they send" must have one answer. Widening is an amendment to
    // the link, not a second link beside it.
    const relationships = createRelationshipRegistry();
    expect(relationships.grant(link()).granted).toBe(true);
    const second = relationships.grant(link({ linkId: "link.sneaky", allowedCapabilities: ["SEND_ARTIFACT"] }));
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.reason).toMatch(/a question with two answers/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DESTINATION
// ─────────────────────────────────────────────────────────────────────────────

describe("a gateway does not open somebody else's mail", () => {
  it("refuses a handoff addressed elsewhere", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ destinationInstanceId: MAKEROPS }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("destination");
    expect(gatewayMayOpenOthersMail()).toBe(false);
  });

  it("takes its own identity from configuration, not the envelope", () => {
    // A gateway that read its identity from the message would agree with
    // whatever it was told it was.
    const { gate } = gateway();
    expect(gate.accept(envelope({ destinationInstanceId: "hive.anything" })).accepted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

describe("a retried handoff does not become two pieces of work", () => {
  it("accepts the duplicate and flags it", () => {
    // Accepted rather than refused: a duplicate is the sender retrying after a
    // lost acknowledgement, and refusing it would turn that into a stuck
    // workflow. The flag is what stops the work happening twice.
    const { gate } = gateway();
    const first = gate.accept(envelope());
    const second = gate.accept(envelope({ envelopeId: "env.1b" }));

    expect(first.accepted && !first.duplicate).toBe(true);
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.duplicate).toBe(true);
    expect(second.reason).toMatch(/creates no further downstream work/);
  });

  it("scopes idempotency by source, so two instances cannot collide", () => {
    const relationships = createRelationshipRegistry();
    relationships.grant(link());
    relationships.grant(link({ linkId: "link.mo.pw", sourceInstanceId: MAKEROPS }));
    const gate = createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: true, reason: "ok" }),
      now: NOW,
    });

    const fromKsix = gate.accept(envelope());
    const fromMakerOps = gate.accept(
      envelope({ sourceInstanceId: MAKEROPS, senderSignature: "sig:makerops:env.1" }),
    );
    expect(fromKsix.accepted && !fromKsix.duplicate).toBe(true);
    expect(fromMakerOps.accepted && !fromMakerOps.duplicate).toBe(true);
  });

  it("does not let an unauthorized sender probe which keys were seen", () => {
    // Replay is checked AFTER authorization on purpose. A stranger replaying a
    // known key must get the same answer as a stranger sending a fresh one,
    // or the refusal becomes an oracle.
    const { gate } = gateway();
    gate.accept(envelope());

    const relationships = createRelationshipRegistry();
    const stranger = createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: true, reason: "ok" }),
      now: NOW,
    });
    const known = stranger.accept(envelope());
    const fresh = stranger.accept(envelope({ idempotencyKey: "never-seen" }));
    expect(known.accepted).toBe(false);
    expect(fresh.accepted).toBe(false);
    if (known.accepted || fresh.accepted) return;
    expect(known.stage).toBe(fresh.stage);
    expect(known.reason).toBe(fresh.reason);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PRIOR STAGES
// ─────────────────────────────────────────────────────────────────────────────

describe("the recipient can prove what was already done", () => {
  it("carries who completed each stage and a digest of the result", () => {
    // The point of the handoff: continue from a checkpoint rather than redo
    // the work. What it must not become is skipping work on somebody's say-so,
    // which is why the attestation names an attester and a digest.
    const { gate } = gateway();
    const result = gate.accept(envelope());
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const stages = result.envelope.priorStageAttestations;
    expect(stages.map((s) => s.stage)).toEqual(["configuration", "pricing"]);
    expect(stages[0]?.completedBy).toBe(KSIX);
    expect(stages[0]?.resultDigest).toBe("sha256:cfg");
    expect(stages[0]?.attestationRef).toBeTruthy();
  });

  it("carries a digest rather than the work itself", () => {
    const parsed = handoffEnvelopeSchema.parse(envelope());
    expect(Object.keys(parsed.priorStageAttestations[0]!)).not.toContain("result");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. COMPATIBILITY AND SENSITIVITY
// ─────────────────────────────────────────────────────────────────────────────

describe("failing safely says something useful", () => {
  it("refuses an unreadable contract version with actionable metadata", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ contractVersion: "9.0.0", idempotencyKey: "k9" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("compatibility");
    expect(result.reason).toMatch(/speaks manufacturing.package 1.x and received 9.0.0/);
  });

  it("checks compatibility last, so a stranger learns nothing from it", () => {
    const relationships = createRelationshipRegistry();
    const gate = createInterconnectGateway({
      instanceId: PROWORKS,
      relationships,
      verifier: goodVerifier,
      supports: () => ({ valid: false, reason: "we speak 1.x" }),
      now: NOW,
    });
    const result = gate.accept(envelope({ contractVersion: "9.0.0" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.stage).toBe("authorization");
  });

  it("lets a sensitive transfer carry a stricter policy than a commercial one", () => {
    // A link is approved for a sensitivity, not merely for a partner.
    const commercial = instanceLinkSchema.parse(link());
    const verdict = linkPermits({
      link: commercial,
      envelope: handoffEnvelopeSchema.parse(
        envelope({
          sensitivityClass: "restricted",
          payload: undefined,
          payloadRef: {
            locator: "vault://imaging/study-1",
            contentType: "application/dicom",
            integrityHash: "sha256:study",
            expiresAt: "2026-08-30T13:00:00.000Z",
          },
        }),
      ),
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/approved for a sensitivity, not merely for a partner/);
  });

  it("requires protected content to travel by reference", () => {
    // An inline protected payload has left its organization and cannot be
    // unsent.
    expect(
      handoffEnvelopeSchema.safeParse(envelope({ sensitivityClass: "restricted" })).success,
    ).toBe(false);
  });

  it("refuses a purpose the link was not approved for", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ purpose: "train_a_model", idempotencyKey: "kp" }));
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toMatch(/Access for one purpose does not authorize another/);
  });

  it("refuses a capability the link does not carry", () => {
    const { gate } = gateway();
    const result = gate.accept(
      envelope({ destinationCapability: "REQUEST_RESULT", idempotencyKey: "kc" }),
    );
    expect(result.accepted).toBe(false);
  });

  it("refuses a contract type the link does not carry", () => {
    const { gate } = gateway();
    expect(
      gate.accept(envelope({ contractType: "finance.ledger", idempotencyKey: "kt" })).accepted,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 & 10. CORRELATION, AND THE WALL EVENTIQ STILL HOLDS
// ─────────────────────────────────────────────────────────────────────────────

describe("one workflow stays followable across the crossing", () => {
  it("preserves correlation and causation", () => {
    const { gate } = gateway();
    const result = gate.accept(envelope({ causationId: "msg_ksix_priced" }));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.envelope.globalCorrelationId).toBe("ORDER-123");
    expect(result.envelope.causationId).toBe("msg_ksix_priced");
    expect(gate.ledger()[0]?.globalCorrelationId).toBe("ORDER-123");
  });

  it("records every decision, refused as well as accepted", () => {
    const onDecision = vi.fn();
    const { gate } = gateway({ onDecision });
    gate.accept(envelope());
    gate.accept(envelope({ senderSignature: "sig:forged:x", idempotencyKey: "kf" }));
    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(gate.ledger().map((e) => e.outcome)).toEqual(["accepted", "refused"]);
  });
});

describe("EventIQ's wall gained a door and did not come down", () => {
  const permits: EventAuthority = {
    mayPublish: () => ({ permitted: true, reason: "ok", decisionId: "gd" }),
    mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd" }),
  };
  const foreign = () => ({
    messageId: "msg_from_ksix",
    category: "EVENT" as const,
    messageType: "work.order.completed",
    schemaVersion: 1,
    producerId: "hive.ksix",
    tenant: { organizationId: "ksix", roles: [] },
    systemScoped: false,
    trace: { correlationId: "ORDER-123" },
    timestamp: "2026-08-30T11:00:00.000Z",
    dataClassification: "internal" as const,
    origin: { globalInstanceId: KSIX },
    payload: {},
  });

  it("still refuses a foreign origin when no gateway is bound", () => {
    // The default, unchanged. An instance that has not deliberately opened a
    // relationship gets the refusal for free.
    const bus = createEventIq({
      instance: { globalInstanceId: PROWORKS, provisional: false },
      authority: permits,
      now: NOW,
    });
    const result = bus.publish(foreign());
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toMatch(/No Interconnect gateway is bound/);
    expect(result.failedClosed).toBe(true);
  });

  it("still refuses when the Interconnect says no", () => {
    const bus = createEventIq({
      instance: { globalInstanceId: PROWORKS, provisional: false },
      authority: permits,
      admitForeignOrigin: () => ({ admitted: false, reason: "link revoked" }),
      now: NOW,
    });
    const result = bus.publish(foreign());
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toMatch(/link revoked/);
  });

  it("admits it when an authorized relationship says so", () => {
    // The door, open — and only because something with authority opened it.
    const bus = createEventIq({
      instance: { globalInstanceId: PROWORKS, provisional: false },
      authority: permits,
      admitForeignOrigin: (input) =>
        input.claimedInstanceId === KSIX
          ? { admitted: true, reason: "link.ksix.proworks" }
          : { admitted: false, reason: "no link" },
      now: NOW,
    });
    expect(bus.publish(foreign()).accepted).toBe(true);
  });

  it("does not widen the door to every foreign instance", () => {
    const bus = createEventIq({
      instance: { globalInstanceId: PROWORKS, provisional: false },
      authority: permits,
      admitForeignOrigin: (input) =>
        input.claimedInstanceId === KSIX
          ? { admitted: true, reason: "ok" }
          : { admitted: false, reason: "no link from that instance" },
      now: NOW,
    });
    const fromElsewhere = { ...foreign(), origin: { globalInstanceId: MAKEROPS } };
    expect(bus.publish(fromElsewhere).accepted).toBe(false);
  });

  it("leaves same-instance messages entirely untouched", () => {
    // The common path must not pay for the border. A message with no foreign
    // origin never reaches the admission port at all.
    const admit = vi.fn(() => ({ admitted: false, reason: "should not be asked" }));
    const bus = createEventIq({
      instance: { globalInstanceId: PROWORKS, provisional: false },
      authority: permits,
      admitForeignOrigin: admit,
      now: NOW,
    });
    const local = { ...foreign(), origin: { globalInstanceId: PROWORKS }, producerId: "hive.proworks" };
    expect(bus.publish(local).accepted).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
});

describe("a restart does not undo a decision somebody made", () => {
  it("does not bring a revoked link back", () => {
    // Restarting must not be the way to restore a relationship somebody ended.
    // Caught by the durability guard from an earlier phase, on this module.
    const store = createInMemoryInterconnectStore();
    const before = createRelationshipRegistry(store);
    before.grant(link());
    before.revoke("link.ksix.proworks", "partner contract ended", "user.steven");

    const after = createRelationshipRegistry(store);
    expect(after.linkFor(KSIX, PROWORKS)?.status).toBe("revoked");
  });

  it("does not forget which idempotency keys it has seen", () => {
    // A partner's retry after an outage must not create a second piece of
    // downstream work — the failure would happen at exactly the moment retries
    // are most likely.
    const store = createInMemoryInterconnectStore();
    const relationships = createRelationshipRegistry(store);
    relationships.grant(link());

    const build = () =>
      createInterconnectGateway({
        instanceId: PROWORKS,
        relationships,
        verifier: goodVerifier,
        supports: () => ({ valid: true, reason: "ok" }),
        store,
        now: NOW,
      });

    const first = build().accept(envelope());
    expect(first.accepted && !first.duplicate).toBe(true);

    const afterRestart = build().accept(envelope({ envelopeId: "env.retry" }));
    expect(afterRestart.accepted).toBe(true);
    if (!afterRestart.accepted) return;
    expect(afterRestart.duplicate).toBe(true);
  });

  it("keeps the chain of custody across the restart", () => {
    const store = createInMemoryInterconnectStore();
    const relationships = createRelationshipRegistry(store);
    relationships.grant(link());
    const build = () =>
      createInterconnectGateway({
        instanceId: PROWORKS,
        relationships,
        verifier: goodVerifier,
        supports: () => ({ valid: true, reason: "ok" }),
        store,
        now: NOW,
      });

    build().accept(envelope());
    expect(build().ledger()).toHaveLength(1);
  });

  it("says which kind of store is bound", () => {
    const { gate, relationships } = gateway();
    expect(gate.durability()).toBe("in-memory");
    expect(relationships.durability()).toBe("in-memory");
  });
});
