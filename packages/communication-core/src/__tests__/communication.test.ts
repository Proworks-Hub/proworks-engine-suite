// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HIVE_MESSAGE_SCHEMA_VERSION,
  hiveMessageSchema,
  type Governance,
  type HiveMessage,
  type RequestContext,
} from "@proworks-hub/contracts";

import {
  acknowledgementSchema,
  checkDeliverability,
  communicationCapabilitySchema,
  communicationRequest,
  createCommunicationCoordinator,
  createCommunicationRegistry,
  deliveryExpectationSchema,
  deliveryGuaranteeSchema,
  hasExpired,
  ownerAfterTransport,
  receiptImpliesAuthorization,
  shouldRetry,
  type CommunicationSpecialist,
} from "../communication.js";

// ─────────────────────────────────────────────────────────────────────────────
// Charter: "How is information communicated reliably, in the right form, to the
// right participant?" — the common foundation under EventIQ, NotificationIQ and
// IntegrationIQ, and not a replacement for any of them.
// ─────────────────────────────────────────────────────────────────────────────

const message = (over: Record<string, unknown> = {}): HiveMessage =>
  hiveMessageSchema.parse({
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

const permits: Governance = {
  async authorize() {
    return {
      decision: "PERMITTED" as const,
      reason: "Test fixture permits. Authorization itself is tested in governance-engine.",
      conditions: [],
      decisionId: "gd-1",
      decidedAt: "2026-08-29T10:00:00.000Z",
    };
  },
};

// A full RequestContext. `defaultAuthorityFor` fails closed without an
// identity AND a tenant — an authority question with no actor cannot be
// answered, so a partial fixture refuses every request for the wrong reason.
const context = {
  requestId: "req-1",
  tenant: { organizationId: "ksix", roles: [] },
  identity: { subject: "steven", kind: "user", roles: [], assertedCapabilities: [] },
  trace: { correlationId: "cor-1" },
  apiVersion: "v1",
  receivedAt: "2026-08-29T10:00:00.000Z",
} as unknown as RequestContext;

const ackOf = (outcome: string, reason?: string) =>
  acknowledgementSchema.parse({
    messageId: "msg_1",
    by: "hive.costiq",
    at: "2026-08-29T10:00:01.000Z",
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });

describe("delivery expectations describe guarantees that can be kept", () => {
  it("offers no exactly-once", () => {
    // Almost nothing can honestly provide it across a real boundary, and a
    // system that claims it stops building the idempotent consumers that make
    // at-least-once safe.
    expect(deliveryGuaranteeSchema.options).toEqual(["at-most-once", "at-least-once"]);
  });

  it("refuses at-most-once that retries", () => {
    expect(
      deliveryExpectationSchema.safeParse({ guarantee: "at-most-once", maxAttempts: 3 }).success,
    ).toBe(false);
  });

  it("refuses to send something critical at-most-once", () => {
    // That combination is a decision to sometimes lose something that matters,
    // usually made by nobody in particular.
    expect(
      deliveryExpectationSchema.safeParse({ guarantee: "at-most-once", consequenceIfLost: "critical" })
        .success,
    ).toBe(false);
    expect(
      deliveryExpectationSchema.safeParse({
        guarantee: "at-least-once",
        maxAttempts: 5,
        consequenceIfLost: "critical",
      }).success,
    ).toBe(true);
  });

  it("defaults ordering to none rather than promising it", () => {
    expect(deliveryExpectationSchema.parse({ guarantee: "at-least-once" }).ordering).toBe("none");
  });

  it("defaults consequence to degraded, not none", () => {
    // A message whose author did not think about consequence is more likely to
    // matter than not.
    expect(deliveryExpectationSchema.parse({ guarantee: "at-least-once" }).consequenceIfLost).toBe(
      "degraded",
    );
  });
});

describe("acknowledgement says what happened and why", () => {
  it("accepts a plain acceptance with no reason", () => {
    expect(
      acknowledgementSchema.safeParse({
        messageId: "msg_1",
        by: "hive.costiq",
        at: "2026-08-29T10:00:01.000Z",
        outcome: "accepted",
      }).success,
    ).toBe(true);
  });

  it("requires a reason for a rejection, deferral or duplicate", () => {
    // An unexplained rejection is indistinguishable from a bug in the sender.
    for (const outcome of ["rejected", "deferred", "duplicate"]) {
      const base = {
        messageId: "msg_1",
        by: "hive.costiq",
        at: "2026-08-29T10:00:01.000Z",
        outcome,
      };
      expect(acknowledgementSchema.safeParse(base).success, outcome).toBe(false);
      expect(
        acknowledgementSchema.safeParse({ ...base, reason: "stated" }).success,
        outcome,
      ).toBe(true);
    }
  });

  it("treats a duplicate as an outcome rather than a failure", () => {
    // at-least-once means duplicates are expected, so a consumer needs a way to
    // say "already done" that does not read to the sender as an error.
    const ack = ackOf("duplicate", "Already processed at 10:00:00.");
    expect(ack.outcome).toBe("duplicate");
    expect(shouldRetry(ack, deliveryExpectationSchema.parse({ guarantee: "at-least-once", maxAttempts: 3 }), 1)).toBe(
      false,
    );
  });

  it("retries only a deferral, and only within the expectation", () => {
    const atLeastOnce = deliveryExpectationSchema.parse({ guarantee: "at-least-once", maxAttempts: 3 });
    const atMostOnce = deliveryExpectationSchema.parse({ guarantee: "at-most-once" });

    expect(shouldRetry(ackOf("deferred", "Ledger unreachable."), atLeastOnce, 1)).toBe(true);
    expect(shouldRetry(ackOf("deferred", "Ledger unreachable."), atLeastOnce, 3)).toBe(false);
    // A rejection is a decision, not a fault. Retrying it just repeats it.
    expect(shouldRetry(ackOf("rejected", "Unknown message type."), atLeastOnce, 1)).toBe(false);
    expect(shouldRetry(ackOf("deferred", "Ledger unreachable."), atMostOnce, 0)).toBe(false);
  });

  it("expires only when an expiry was set", () => {
    const forever = deliveryExpectationSchema.parse({ guarantee: "at-least-once" });
    const expiring = deliveryExpectationSchema.parse({
      guarantee: "at-least-once",
      expiresAt: "2026-08-29T11:00:00.000Z",
    });
    expect(hasExpired(forever, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
    expect(hasExpired(expiring, new Date("2026-08-29T10:59:59.000Z"))).toBe(false);
    expect(hasExpired(expiring, new Date("2026-08-29T11:00:00.000Z"))).toBe(true);
  });
});

describe("the three charter rules", () => {
  it("does not gain ownership over what it transports", () => {
    // Charter: "Communication does not gain ownership over the information it
    // transports." The owner is whoever produced it, before and after the hop.
    expect(ownerAfterTransport(message({ producerId: "hive.inventoryiq" }))).toBe("hive.inventoryiq");
  });

  it("never reads receipt as authorization", () => {
    // Charter: "Receiving a message does not prove the message is authorized."
    // Not even a COMMAND carrying the authority its sender acted under — that
    // is the sender's provenance, not the recipient's permission.
    expect(receiptImpliesAuthorization(message())).toBe(false);
    expect(
      receiptImpliesAuthorization(
        message({
          category: "COMMAND",
          producedUnderAuthority: { decisionId: "gd-7", decidedAt: "2026-08-29T09:00:00.000Z" },
        }),
      ),
    ).toBe(false);
  });

  it("never treats routing capability as leave to cross a tenant", () => {
    // Charter: "Routing capability shall never be interpreted as authorization
    // to cross tenant boundaries."
    expect(checkDeliverability(message(), "ksix").deliverable).toBe(true);

    const refused = checkDeliverability(message(), "another-shop");
    expect(refused.deliverable).toBe(false);
    if (!refused.deliverable) expect(refused.reason).toContain("never authorization");
  });

  it("says deliverable rather than allowed", () => {
    // The verdict answers "does this hop cross a tenant", not "may the
    // recipient act on it". Naming it `allowed` is how the second gets skipped.
    const keys = Object.keys(checkDeliverability(message(), "ksix"));
    expect(keys).toContain("deliverable");
    for (const forbidden of ["allowed", "permitted", "authorized", "granted"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe("it is not EventIQ", () => {
  it("offers no send, publish, subscribe or deliver capability", () => {
    // Charter: Communication "does not replace EventIQ, NotificationIQ,
    // IntegrationIQ, email providers, messaging providers, or external
    // communication systems." Those move things; this defines what the moving
    // means.
    // Checked against the LEADING verb, not as a substring. The first version
    // of this test failed on `resolve_delivery_expectation` because it contains
    // "deliver" — but that capability describes what delivery means, it does not
    // perform one. What matters is the verb the capability starts with: every
    // one of these asks a question (resolve, record, check) rather than moving
    // something.
    const verbs = communicationCapabilitySchema.options.map((c) => c.split("_")[0]);
    for (const forbidden of ["send", "publish", "subscribe", "deliver", "enqueue", "route", "emit"]) {
      expect(verbs, forbidden).not.toContain(forbidden);
    }
    expect(new Set(verbs)).toEqual(new Set(["resolve", "record", "check"]));
  });

  it("names no broker, queue or protocol anywhere in its code", () => {
    // Charter portability: "No particular queue, message broker, email
    // provider, SMS provider, cloud event system, or protocol is
    // constitutionally required." A Core that imports one has chosen for every
    // tenant that will ever run it.
    const source = readFileSync(fileURLToPath(new URL("../communication.ts", import.meta.url)), "utf8");
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();

    for (const vendor of [
      "kafka",
      "rabbit",
      "sqs",
      "sns",
      "pubsub",
      "redis",
      "nats",
      "twilio",
      "sendgrid",
      "smtp",
      "amqp",
      "websocket",
      "process.env",
    ]) {
      expect(code.includes(vendor), vendor).toBe(false);
    }
  });

  it("keeps no messages", () => {
    // No store, no outbox, no delivery loop. A Core that accumulated messages
    // would be a broker with a different label on it.
    const coordinator = createCommunicationCoordinator({
      registry: createCommunicationRegistry(),
      governance: permits,
    });
    for (const forbidden of ["messages", "queue", "outbox", "subscribers", "publish"]) {
      expect(Object.keys(coordinator), forbidden).not.toContain(forbidden);
    }
  });
});

describe("it coordinates like every other Core", () => {
  const specialist: CommunicationSpecialist = {
    id: "hive.eventiq",
    capabilities: ["resolve_delivery_expectation"],
    async handle() {
      return {
        ok: true,
        output: deliveryExpectationSchema.parse({ guarantee: "at-least-once", maxAttempts: 3 }),
      };
    },
  };

  it("answers through a specialist rather than itself", async () => {
    // EventIQ is one specialist among several — a direct contract or a
    // synchronous call is equally legitimate, which is why the question goes to
    // the Core rather than to the bus.
    const coordinator = createCommunicationCoordinator({
      registry: createCommunicationRegistry([specialist]),
      governance: permits,
    });

    const outcome = await coordinator.ask(
      communicationRequest({
        capability: "resolve_delivery_expectation",
        input: { messageType: "material.reserved" },
        context,
        correlationId: "cor-1",
      }),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.answer.servedBy).toBe("hive.eventiq");
  });

  it("fails closed when governance is missing rather than proceeding", async () => {
    // The type makes it required. This asserts what happens if a JavaScript
    // caller gets past the type anyway: the coordinator refuses and says
    // Governance could not decide. Governance being absent is not permission —
    // the exact failure that let eight services authorize nothing while every
    // call site still read as guarded.
    const coordinator = createCommunicationCoordinator({
      registry: createCommunicationRegistry([specialist]),
      // @ts-expect-error deliberately bypassing the type, as a JS caller could.
      governance: undefined,
    });

    const outcome = await coordinator.ask(
      communicationRequest({
        capability: "resolve_delivery_expectation",
        input: {},
        context,
        correlationId: "cor-4",
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.failure).toBe("not_permitted");
      expect(outcome.refusal.reason).toContain("nothing is authorized");
    }
  });

  it("refuses a capability nobody implements rather than improvising", async () => {
    const coordinator = createCommunicationCoordinator({
      registry: createCommunicationRegistry([specialist]),
      governance: permits,
    });
    const outcome = await coordinator.ask(
      communicationRequest({
        capability: "resolve_channel",
        input: {},
        context,
        correlationId: "cor-2",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("no_specialist");
  });

  it("denies before asking anyone", async () => {
    // Constitution §1.9 — Governance decides before capability resolution. A
    // denied request must not reach a specialist at all.
    let asked = false;
    const coordinator = createCommunicationCoordinator({
      registry: createCommunicationRegistry([
        {
          id: "hive.eventiq",
          capabilities: ["resolve_delivery_expectation"],
          async handle() {
            asked = true;
            return { ok: true, output: {} };
          },
        },
      ]),
      governance: {
        async authorize() {
          return {
            decision: "DENIED" as const,
            reason: "Not in the grant.",
            conditions: [],
            decisionId: "gd-2",
            decidedAt: "2026-08-29T10:00:00.000Z",
          };
        },
      },
    });

    const outcome = await coordinator.ask(
      communicationRequest({
        capability: "resolve_delivery_expectation",
        input: {},
        context,
        correlationId: "cor-3",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("not_permitted");
    expect(asked).toBe(false);
  });
});
