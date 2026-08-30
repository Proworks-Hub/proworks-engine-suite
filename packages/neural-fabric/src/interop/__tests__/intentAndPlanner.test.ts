/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  communicationIntentSchema,
  crossesInstance,
  intentGrantsAuthority,
  type CommunicationIntent,
} from "../communicationIntent.js";
import {
  PATTERN_CATALOG,
  PATTERN_IDS,
  catalogIsExtensibleAtRuntime,
  deliverySatisfies,
  orderingSatisfies,
} from "../patternCatalog.js";
import {
  PATTERN_CATALOG_VERSION,
  planPattern,
  planningMayWidenReachability,
  type PlanVersions,
} from "../patternPlanner.js";

const VERSIONS: PlanVersions = {
  catalogVersion: PATTERN_CATALOG_VERSION,
  topologyVersionId: "v-1",
  policyVersionId: "pol-1",
  aiParticipation: "NONE",
};

/** A minimal valid intent: local, small, no guarantees demanded. */
const intent = (over: Record<string, unknown> = {}): CommunicationIntent =>
  communicationIntentSchema.parse({
    intentId: "int-1",
    purpose: "Ask the planner for a plan.",
    sourceCapability: "ordering",
    destinationCapability: "manufacturing.plan",
    operation: "QUERY",
    delivery: "BEST_EFFORT",
    ordering: "NONE",
    consumerIsIdempotent: false,
    requiresReplay: false,
    requiresDurability: false,
    deadlineMs: null,
    timeToLiveMs: null,
    approximatePayloadBytes: 2_048,
    continuous: false,
    batched: false,
    classification: "INTERNAL",
    tenantId: "acme",
    locality: {
      sourceInstanceId: "ksix",
      destinationInstanceId: "ksix",
      senderMayBeOffline: false,
      receiverMayBeOffline: false,
      constrainedBandwidth: false,
    },
    authorizationEvidenceRef: null,
    degradation: "DELAY_PERMITTED",
    isTest: true,
    ...over,
  });

describe("CommunicationIntent: mechanism cannot be smuggled in", () => {
  it("refuses an unknown field, so no caller can pin a provider or a URL", () => {
    const result = communicationIntentSchema.safeParse({
      ...intent(),
      provider: "kafka",
    });
    expect(result.success).toBe(false);
  });

  it("refuses effectively-once without an idempotent consumer", () => {
    const result = communicationIntentSchema.safeParse({
      ...intent(),
      delivery: "EFFECTIVELY_ONCE",
      consumerIsIdempotent: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("idempotent consumer");
  });

  it("refuses a COMMAND with no authorization evidence reference", () => {
    const result = communicationIntentSchema.safeParse({ ...intent(), operation: "COMMAND", authorizationEvidenceRef: null });
    expect(result.success).toBe(false);
  });

  it("refuses a TRANSFER with no authorization evidence reference", () => {
    const result = communicationIntentSchema.safeParse({ ...intent(), operation: "TRANSFER", authorizationEvidenceRef: null });
    expect(result.success).toBe(false);
  });

  it("refuses tenant-private traffic with no tenant", () => {
    const result = communicationIntentSchema.safeParse({ ...intent(), classification: "TENANT_PRIVATE", tenantId: null });
    expect(result.success).toBe(false);
  });

  it("refuses a time-to-live shorter than the deadline", () => {
    const result = communicationIntentSchema.safeParse({ ...intent(), deadlineMs: 5_000, timeToLiveMs: 1_000 });
    expect(result.success).toBe(false);
  });

  it("refuses replay without durability", () => {
    const result = communicationIntentSchema.safeParse({ ...intent(), requiresReplay: true, requiresDurability: false });
    expect(result.success).toBe(false);
  });

  it("knows when it crosses an instance boundary", () => {
    expect(crossesInstance(intent())).toBe(false);
    expect(
      crossesInstance(
        intent({ locality: { ...intent().locality, destinationInstanceId: "partner" } }),
      ),
    ).toBe(true);
  });

  it("grants nothing", () => {
    expect(intentGrantsAuthority()).toBe(false);
  });
});

describe("the pattern catalog is bounded and internally honest", () => {
  it("has exactly eleven patterns and is closed at runtime", () => {
    expect(PATTERN_IDS).toHaveLength(11);
    expect(catalogIsExtensibleAtRuntime()).toBe(false);
    expect(Object.isFrozen(PATTERN_CATALOG)).toBe(true);
  });

  it("has exactly one cross-instance pattern", () => {
    const crossing = PATTERN_IDS.filter((id) => PATTERN_CATALOG[id].crossInstance);
    expect(crossing).toEqual(["INTERCONNECT_GATEWAY_HANDOFF"]);
  });

  it("never claims replay without durability — you cannot replay what you did not keep", () => {
    for (const id of PATTERN_IDS) {
      const p = PATTERN_CATALOG[id];
      if (p.replayable) expect(p.durable).toBe(true);
    }
  });

  it("never claims effectively-once without requiring an idempotent consumer", () => {
    for (const id of PATTERN_IDS) {
      const p = PATTERN_CATALOG[id];
      if (p.delivery === "EFFECTIVELY_ONCE") expect(p.requiresIdempotentConsumer).toBe(true);
    }
  });

  it("gives every pattern a required capability, so no adapter serves one by default", () => {
    for (const id of PATTERN_IDS) {
      expect(PATTERN_CATALOG[id].requiredProviderCapabilities.length).toBeGreaterThan(0);
    }
  });

  it("treats PER_KEY and PER_PAIR as different promises, not ranked ones", () => {
    expect(orderingSatisfies("PER_KEY", "PER_PAIR")).toBe(false);
    expect(orderingSatisfies("PER_PAIR", "PER_KEY")).toBe(false);
    expect(orderingSatisfies("STRICT_SEQUENCE", "PER_KEY")).toBe(true);
    expect(orderingSatisfies("STRICT_SEQUENCE", "PER_PAIR")).toBe(true);
    expect(orderingSatisfies("NONE", "PER_KEY")).toBe(false);
    expect(orderingSatisfies("PER_KEY", "NONE")).toBe(true);
  });

  it("ranks delivery so stronger satisfies weaker and never the reverse", () => {
    expect(deliverySatisfies("EFFECTIVELY_ONCE", "AT_LEAST_ONCE")).toBe(true);
    expect(deliverySatisfies("AT_LEAST_ONCE", "EFFECTIVELY_ONCE")).toBe(false);
    expect(deliverySatisfies("BEST_EFFORT", "AT_LEAST_ONCE")).toBe(false);
  });
});

describe("the planner selects, explains, and refuses", () => {
  it("is deterministic: the same intent plans identically every time", () => {
    const a = planPattern(intent(), VERSIONS);
    const b = planPattern(intent(), VERSIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("picks the cheapest pattern that keeps every promise", () => {
    const outcome = planPattern(intent(), VERSIONS);
    expect(outcome.planned).toBe(true);
    if (outcome.planned) {
      expect(outcome.plan.chosen).toBe("SYNC_REQUEST_REPLY");
      expect(outcome.plan.lane).toBe("QUERY");
    }
  });

  it("forces the gateway pattern the moment the conversation crosses an instance", () => {
    const outcome = planPattern(
      intent({
        operation: "NOTIFY",
        delivery: "AT_LEAST_ONCE",
        consumerIsIdempotent: true,
        requiresDurability: true,
        locality: { ...intent().locality, destinationInstanceId: "partner-instance" },
      }),
      VERSIONS,
    );
    expect(outcome.planned).toBe(true);
    if (outcome.planned) {
      expect(outcome.plan.chosen).toBe("INTERCONNECT_GATEWAY_HANDOFF");
      expect(outcome.plan.crossInstance).toBe(true);
      // And every local pattern was refused for the same structural reason.
      const local = outcome.plan.rejected.find((r) => r.patternId === "PUBLISH_SUBSCRIBE");
      expect(local?.reason).toContain("crosses from instance");
    }
  });

  it("never offers the gateway pattern to local traffic", () => {
    const outcome = planPattern(intent(), VERSIONS);
    if (outcome.planned) {
      expect(outcome.plan.alternatives).not.toContain("INTERCONNECT_GATEWAY_HANDOFF");
    }
  });

  it("routes an offline sender to store-and-forward, and says why the others failed", () => {
    const outcome = planPattern(
      intent({
        operation: "COMMAND",
        authorizationEvidenceRef: "dec-1",
        delivery: "EFFECTIVELY_ONCE",
        consumerIsIdempotent: true,
        requiresDurability: true,
        locality: { ...intent().locality, senderMayBeOffline: true },
      }),
      VERSIONS,
    );
    expect(outcome.planned).toBe(true);
    if (outcome.planned) {
      expect(outcome.plan.chosen).toBe("STORE_AND_FORWARD_EDGE");
      // The async queue keeps every guarantee this intent asks for and fails
      // on exactly one thing: it needs the sender connected. Asserting here
      // rather than on a synchronous pattern isolates the offline check,
      // because rejections report the FIRST unmet requirement by design.
      const queue = outcome.plan.rejected.find((r) => r.patternId === "ASYNC_COMMAND_QUEUE");
      expect(queue?.reason).toContain("offline");
    }
  });

  it("moves a large payload by reference and refuses inline carriage", () => {
    const outcome = planPattern(
      intent({
        operation: "TRANSFER",
        authorizationEvidenceRef: "dec-2",
        delivery: "AT_LEAST_ONCE",
        consumerIsIdempotent: true,
        requiresDurability: true,
        approximatePayloadBytes: 40_000_000,
      }),
      VERSIONS,
    );
    expect(outcome.planned).toBe(true);
    if (outcome.planned) {
      expect(outcome.plan.chosen).toBe("ARTIFACT_REFERENCE");
      const pubsub = outcome.plan.rejected.find((r) => r.patternId === "PUBLISH_SUBSCRIBE");
      expect(pubsub?.reason).toContain("inline");
    }
  });

  it("refuses a pattern whose latency floor exceeds the deadline", () => {
    // consumerIsIdempotent so the batch pipeline reaches the deadline check
    // instead of being refused one step earlier for redelivery.
    const outcome = planPattern(intent({ deadlineMs: 2, consumerIsIdempotent: true }), VERSIONS);
    if (outcome.planned) {
      const batch = outcome.plan.rejected.find((r) => r.patternId === "BATCH_PIPELINE");
      expect(batch?.reason).toContain("deadline");
    }
  });

  it("refuses a redelivering pattern when the consumer is not idempotent, with a remedy", () => {
    const outcome = planPattern(intent(), VERSIONS);
    if (outcome.planned) {
      const queue = outcome.plan.rejected.find((r) => r.patternId === "ASYNC_COMMAND_QUEUE");
      expect(queue?.reason).toContain("deduplicates");
      expect(queue?.remedy).toContain("idempotent");
    }
  });

  it("plans nothing, and names the conflict, when an offline sender demands a deadline", () => {
    const outcome = planPattern(
      intent({
        deadlineMs: 50,
        timeToLiveMs: 60_000,
        locality: { ...intent().locality, senderMayBeOffline: true },
      }),
      VERSIONS,
    );
    expect(outcome.planned).toBe(false);
    if (!outcome.planned) {
      expect(outcome.reason).toContain("offline sender");
      expect(outcome.rejected).toHaveLength(11);
    }
  });

  it("honours an explicitly required lane, and refuses patterns on other lanes", () => {
    const outcome = planPattern(
      intent({
        operation: "NOTIFY",
        requiredLane: "EVENT",
        delivery: "AT_LEAST_ONCE",
        consumerIsIdempotent: true,
        requiresDurability: true,
      }),
      VERSIONS,
    );
    expect(outcome.planned).toBe(true);
    if (outcome.planned) {
      expect(PATTERN_CATALOG[outcome.plan.chosen].lane).toBe("EVENT");
      const rpc = outcome.plan.rejected.find((r) => r.patternId === "TYPED_RPC");
      expect(rpc?.reason).toContain("requires the EVENT lane");
    }
  });

  it("a required lane cannot be used to acquire weaker guarantees than were asked for", () => {
    // QUERY is best-effort. Demanding it while requiring durability must fail
    // rather than quietly downgrade the guarantee to whatever the lane offers.
    const outcome = planPattern(intent({ requiredLane: "QUERY", requiresDurability: true }), VERSIONS);
    expect(outcome.planned).toBe(false);
  });

  it("carries the authorization reference through untouched and calls it non-authoritative", () => {
    const outcome = planPattern(
      intent({ operation: "COMMAND", authorizationEvidenceRef: "dec-9", delivery: "AT_LEAST_ONCE", consumerIsIdempotent: true }),
      VERSIONS,
    );
    if (outcome.planned) {
      expect(outcome.plan.authorizationEvidenceRef).toBe("dec-9");
      expect(outcome.plan.explanation).toContain("not authorization");
    }
  });

  it("records the versions the plan was computed against, so it can be re-verified", () => {
    const outcome = planPattern(intent(), VERSIONS);
    if (outcome.planned) {
      expect(outcome.plan.versions.topologyVersionId).toBe("v-1");
      expect(outcome.plan.versions.aiParticipation).toBe("NONE");
      expect(outcome.plan.versions.catalogVersion).toBe(PATTERN_CATALOG_VERSION);
    }
  });

  it("lists every pattern exactly once across chosen, alternatives and rejections", () => {
    const outcome = planPattern(intent(), VERSIONS);
    if (outcome.planned) {
      const seen = [...outcome.plan.alternatives, ...outcome.plan.rejected.map((r) => r.patternId)];
      expect(new Set(seen).size).toBe(11);
      expect(seen).toHaveLength(11);
    }
  });

  it("widens nothing", () => {
    expect(planningMayWidenReachability()).toBe(false);
  });
});
