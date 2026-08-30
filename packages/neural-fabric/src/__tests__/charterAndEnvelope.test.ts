/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  HARD_GATES,
  NEURAL_FABRIC_CLASSIFICATION,
  NEURAL_FABRIC_DOES_NOT_OWN,
  NEURAL_FABRIC_OWNS,
  RATIFIED_CLASSIFICATIONS,
  UNRESOLVED_CONSTITUTIONAL_QUESTIONS,
  classificationLeakedIntoRegistry,
  isRatifiedClassification,
} from "../charter.js";
import {
  LANES,
  LANE_SEMANTICS,
  checkConsumerFit,
  exactlyOnceDeliveryOffered,
  exactlyOnceEffectAchievable,
  mayBeShed,
  semanticsFor,
} from "../domain/lanes.js";
import {
  acceptEnvelope,
  carriesAuthorizationReference,
  classificationPermitsExport,
  fabricEnvelopeSchema,
  isExpired,
  isTelemetrySafeField,
  referenceGrantsAuthority,
  routePossessionGrantsPermission,
  telemetryView,
} from "../domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// The constitutional claims first, because they are the ones a working system
// is most likely to quietly settle by existing.
// ─────────────────────────────────────────────────────────────────────────────

describe("this is not a ratified Core, and the code says so", () => {
  it("holds no ratified classification", () => {
    expect(isRatifiedClassification()).toBe(false);
  });

  it("uses a classification that is NOT in the ratified vocabulary", () => {
    // Adding it there would be the ratification the plan declines to perform.
    expect(RATIFIED_CLASSIFICATIONS).not.toContain(NEURAL_FABRIC_CLASSIFICATION);
  });

  it("detects the classification leaking into the ratified registry", () => {
    // The failure this guards: somebody adds PROPOSED_COORDINATION_PLANE to
    // HiveClassification to make a type error go away, and a constitutional
    // decision gets made by a compiler.
    expect(classificationLeakedIntoRegistry(RATIFIED_CLASSIFICATIONS)).toBe(false);
    expect(classificationLeakedIntoRegistry([...RATIFIED_CLASSIFICATIONS, NEURAL_FABRIC_CLASSIFICATION])).toBe(
      true,
    );
  });

  it("records the questions engineering deliberately did not answer", () => {
    expect(UNRESOLVED_CONSTITUTIONAL_QUESTIONS.length).toBeGreaterThanOrEqual(3);
    for (const q of UNRESOLVED_CONSTITUTIONAL_QUESTIONS) {
      expect(q.whyEngineeringCannotAnswerIt.length).toBeGreaterThan(0);
    }
  });

  it("names the conflict with the existing Information Fabric decision", () => {
    // Recorded rather than resolved. A reviewer should meet it, not discover it.
    const text = UNRESOLVED_CONSTITUTIONAL_QUESTIONS.map((q) => q.question).join(" ");
    expect(text).toContain("Information Fabric");
  });

  it("gives every excluded responsibility the plausible request that would breach it", () => {
    for (const excluded of NEURAL_FABRIC_DOES_NOT_OWN) {
      expect(excluded.arrivesAs.trim().length).toBeGreaterThan(0);
      expect(excluded.ownedBy.trim().length).toBeGreaterThan(0);
    }
  });

  it("refuses authority, identity, workflow and security response", () => {
    const ids = NEURAL_FABRIC_DOES_NOT_OWN.map((e) => e.id);
    for (const id of ["authority", "identity", "business.workflow", "security.response", "self.evolution"]) {
      expect(ids).toContain(id);
    }
  });

  it("assigns every owned responsibility to a chamber", () => {
    for (const owned of NEURAL_FABRIC_OWNS) {
      expect(["NEXUS", "PULSE", "BOTH"]).toContain(owned.chamber);
    }
  });

  it("carries all seven hard gates", () => {
    expect(HARD_GATES).toHaveLength(7);
    const ids = HARD_GATES.map((g) => g.id);
    expect(ids).toContain("no-lane-bypass");
    expect(ids).toContain("local-continuity");
    expect(ids).toContain("no-self-deploying-topology");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("eight lanes, eight different sets of guarantees", () => {
  it("declares semantics for every lane", () => {
    expect(LANES).toHaveLength(8);
    for (const lane of LANES) {
      const s = semanticsFor(lane);
      expect(s.lane).toBe(lane);
      expect(s.misuseFailure.length).toBeGreaterThan(0);
    }
  });

  it("NEVER offers exactly-once delivery", () => {
    // The promise most likely to be made by somebody being helpful in a
    // contract review. There is no enum member to select it with.
    expect(exactlyOnceDeliveryOffered()).toBe(false);
    const semantics = Object.values(LANE_SEMANTICS).map((s) => s.delivery as string);
    expect(semantics).not.toContain("EXACTLY_ONCE");
  });

  it("offers exactly-once EFFECT where the consumer is idempotent", () => {
    // The property people actually mean. Different word, deliberately.
    expect(exactlyOnceEffectAchievable("COMMAND")).toBe(true);
    expect(exactlyOnceEffectAchievable("HEALTH")).toBe(false);
    expect(exactlyOnceEffectAchievable("QUERY")).toBe(false);
  });

  it("keeps health traffic out of durable storage", () => {
    // Made durable, heartbeats become the largest table in the system.
    expect(LANE_SEMANTICS.HEALTH.durable).toBe(false);
    expect(LANE_SEMANTICS.HEALTH.delivery).toBe("AT_MOST_ONCE");
  });

  it("makes commands durable and requires idempotency", () => {
    expect(LANE_SEMANTICS.COMMAND.durable).toBe(true);
    expect(LANE_SEMANTICS.COMMAND.requiresIdempotentConsumer).toBe(true);
    expect(LANE_SEMANTICS.COMMAND.requiresAuthorizationEvidence).toBe(true);
  });

  it("gives workflow strict sequence and streams partition ordering", () => {
    // A stream given strict global ordering stops scaling.
    expect(LANE_SEMANTICS.WORKFLOW.ordering).toBe("STRICT_SEQUENCE");
    expect(LANE_SEMANTICS.STREAM.ordering).toBe("PER_PARTITION");
  });

  it("carries artifacts by reference only", () => {
    expect(LANE_SEMANTICS.ARTIFACT.payloadCarriage).toBe("REFERENCE_ONLY");
  });

  it("REFUSES to shed evidence or commands under load", () => {
    // Shedding evidence loses the record of the incident causing the load.
    expect(mayBeShed("EVIDENCE")).toBe(false);
    expect(mayBeShed("COMMAND")).toBe(false);
    expect(mayBeShed("WORKFLOW")).toBe(false);
    expect(mayBeShed("HEALTH")).toBe(true);
  });
});

describe("a consumer that does not fit its lane is refused at registration", () => {
  it("catches a non-idempotent consumer on a redelivering lane", () => {
    const problems = checkConsumerFit("COMMAND", { idempotent: false, durableStorage: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.consequence).toContain("Nothing will report an error");
  });

  it("catches a consumer persisting an ephemeral lane", () => {
    const problems = checkConsumerFit("HEALTH", { idempotent: true, durableStorage: true });
    expect(problems.some((p) => p.consequence.includes("grow without bound"))).toBe(true);
  });

  it("catches a consumer persisting what is only a reference", () => {
    const problems = checkConsumerFit("ARTIFACT", { idempotent: true, durableStorage: true });
    expect(problems.some((p) => p.consequence.includes("believe it has the artifact"))).toBe(true);
  });

  it("says nothing about a consumer that fits", () => {
    expect(checkConsumerFit("COMMAND", { idempotent: true, durableStorage: true })).toEqual([]);
    expect(checkConsumerFit("HEALTH", { idempotent: false, durableStorage: false })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const envelope = (over: Record<string, unknown> = {}) => ({
  fabricMessageId: "sig-1",
  schemaId: "forgeiq.plan.requested",
  schemaVersion: "1.0.0",
  lane: "COMMAND",
  source: { capability: "ordering" },
  destination: { capability: "manufacturing.plan" },
  instanceId: "ksix",
  tenantId: "acme",
  correlationId: "cor-1",
  causationId: null,
  idempotencyKey: "idem-1",
  authorizationEvidenceRef: "dec-1",
  provenance: {
    originComponent: "order-ingestion",
    originInstanceId: "ksix",
    principalKind: "ENGINE",
    transformations: [],
  },
  classification: "TENANT_PRIVATE",
  priority: "NORMAL",
  contentType: "application/json",
  isTest: false,
  ...over,
});

describe("the envelope refuses what it cannot check", () => {
  it("accepts a complete envelope", () => {
    expect(acceptEnvelope(envelope()).accepted).toBe(true);
  });

  it("REFUSES a redelivering lane with no idempotency key", () => {
    const { idempotencyKey, ...without } = envelope();
    const outcome = acceptEnvelope(without);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(outcome.issues.join()).toContain("indistinguishable from a second, genuine request");
    }
  });

  it("REFUSES a consequential lane with no authorization evidence reference", () => {
    const { authorizationEvidenceRef, ...without } = envelope();
    const outcome = acceptEnvelope(without);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.issues.join()).toContain("where to look");
  });

  it("REFUSES an artifact signal carrying its bytes inline", () => {
    const outcome = acceptEnvelope(envelope({ lane: "ARTIFACT" }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.issues.join()).toContain("what this lane exists to prevent");
  });

  it("accepts an artifact signal carrying a reference", () => {
    expect(acceptEnvelope(envelope({ lane: "ARTIFACT", payloadRef: "file://model-v3" })).accepted).toBe(true);
  });

  it("does not require an idempotency key on a query", () => {
    const { idempotencyKey, authorizationEvidenceRef, ...base } = envelope();
    expect(acceptEnvelope({ ...base, lane: "QUERY" }).accepted).toBe(true);
  });

  it("REFUSES an envelope that does not say whether it is a test", () => {
    // The defect this rule exists for put four test work orders into a
    // production database, and nothing complained.
    const { isTest, ...without } = envelope();
    expect(acceptEnvelope(without).accepted).toBe(false);
  });

  it("REFUSES an unknown field", () => {
    // A sender with a stale contract, or a sender trying something.
    expect(acceptEnvelope({ ...envelope(), authorized: true }).accepted).toBe(false);
  });

  it("requires causationId to be present even when null", () => {
    const { causationId, ...without } = envelope();
    expect(acceptEnvelope(without).accepted).toBe(false);
    expect(acceptEnvelope(envelope({ causationId: null })).accepted).toBe(true);
  });

  it("REFUSES an AI-originated signal that will not say which model", () => {
    const outcome = acceptEnvelope(
      envelope({
        provenance: {
          originComponent: "aria",
          originInstanceId: "ksix",
          principalKind: "AI_MODEL",
          transformations: [],
        },
      }),
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.issues.join()).toContain("every AI on the instance is equally suspect");
  });

  it("accepts an AI-originated signal that names its model", () => {
    expect(
      acceptEnvelope(
        envelope({
          provenance: {
            originComponent: "aria",
            originInstanceId: "ksix",
            principalKind: "AI_MODEL",
            modelProvenance: { provider: "anthropic", model: "claude-opus-5" },
            transformations: [],
          },
        }),
      ).accepted,
    ).toBe(true);
  });

  it("refuses an unknown lane rather than routing it somewhere plausible", () => {
    expect(acceptEnvelope(envelope({ lane: "GOSSIP" })).accepted).toBe(false);
  });
});

describe("a reference to authority is not authority", () => {
  it("reports that a reference is present without calling it permission", () => {
    const outcome = acceptEnvelope(envelope());
    if (outcome.accepted) expect(carriesAuthorizationReference(outcome.envelope)).toBe(true);
  });

  it("never grants authority from a reference", () => {
    // `if (envelope.authorizationEvidenceRef) { proceed(); }` reads as a
    // permission check and tests only that somebody wrote a string.
    expect(referenceGrantsAuthority()).toBe(false);
  });

  it("never treats possession of a route as permission to use it", () => {
    expect(routePossessionGrantsPermission()).toBe(false);
  });
});

describe("expiry is judged against a supplied clock", () => {
  const sent = "2026-08-30T10:00:00.000Z";

  it("expires on a deadline", () => {
    const e = fabricEnvelopeSchema.parse(envelope({ deadline: "2026-08-30T10:00:05.000Z" }));
    expect(isExpired(e, sent, "2026-08-30T10:00:04.000Z")).toBe(false);
    expect(isExpired(e, sent, "2026-08-30T10:00:05.000Z")).toBe(true);
  });

  it("expires on a TTL measured from when it was sent", () => {
    const e = fabricEnvelopeSchema.parse(envelope({ ttlSeconds: 30 }));
    expect(isExpired(e, sent, "2026-08-30T10:00:29.000Z")).toBe(false);
    expect(isExpired(e, sent, "2026-08-30T10:00:30.000Z")).toBe(true);
  });

  it("never expires a signal with neither", () => {
    const e = fabricEnvelopeSchema.parse(envelope());
    expect(isExpired(e, sent, "2030-01-01T00:00:00.000Z")).toBe(false);
  });

  it("takes `now` as an argument so the decision can be replayed", () => {
    // "Was this expired when we dropped it?" is exactly the post-incident
    // question, and a clock read inside makes it unanswerable.
    const e = fabricEnvelopeSchema.parse(envelope({ ttlSeconds: 30 }));
    const at = "2026-08-30T10:00:31.000Z";
    expect(isExpired(e, sent, at)).toBe(isExpired(e, sent, at));
  });
});

describe("telemetry is an allowlist, because a denylist fails open", () => {
  const parsed = fabricEnvelopeSchema.parse(envelope({ payloadRef: "s3://secret-quote" }));

  it("publishes routing metadata", () => {
    const view = telemetryView(parsed);
    expect(view["fabricMessageId"]).toBe("sig-1");
    expect(view["lane"]).toBe("COMMAND");
    expect(view["correlationId"]).toBe("cor-1");
  });

  it("withholds the tenant, which identifies a customer", () => {
    expect(telemetryView(parsed)["tenantId"]).toBeUndefined();
    expect(isTelemetrySafeField("tenantId")).toBe(false);
  });

  it("withholds the payload reference and the authorization reference", () => {
    const view = telemetryView(parsed);
    expect(JSON.stringify(view)).not.toContain("secret-quote");
    expect(JSON.stringify(view)).not.toContain("dec-1");
  });

  it("withholds a specific participant while publishing the capability", () => {
    // The capability is logical and useful in a trace. The participant id can
    // identify one workload on one host.
    const withParticipant = fabricEnvelopeSchema.parse(
      envelope({ destination: { capability: "manufacturing.plan", participantId: "worker-7" } }),
    );
    const view = telemetryView(withParticipant);
    expect(view["destinationCapability"]).toBe("manufacturing.plan");
    expect(JSON.stringify(view)).not.toContain("worker-7");
  });

  it("publishes the principal kind, which an operator needs during an incident", () => {
    expect(telemetryView(parsed)["principalKind"]).toBe("ENGINE");
  });

  it("emits nothing for a field that is absent", () => {
    expect(telemetryView(parsed)["traceContext"]).toBeUndefined();
  });
});

describe("classification answers the data question and not the route question", () => {
  it("refuses export of tenant-private, personal and restricted data", () => {
    for (const c of ["TENANT_PRIVATE", "PERSONAL", "RESTRICTED"] as const) {
      const r = classificationPermitsExport(c);
      expect(r.permitted).toBe(false);
      expect(r.note).toContain("no route health, latency benefit or urgency changes it");
    }
  });

  it("permits public and internal data — but says it is not a route approval", () => {
    const r = classificationPermitsExport("PUBLIC");
    expect(r.permitted).toBe(true);
    expect(r.note).toContain("not a route approval");
    expect(r.note).toContain("Interconnect gateway");
  });
});
