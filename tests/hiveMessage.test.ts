// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  HIVE_MESSAGE_SCHEMA_VERSION,
  deliverableTo,
  hiveMessageSchema,
  messageCategorySchema,
  parseHiveMessage,
  platformEventSchema,
  replyTo,
  type HiveMessage,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// One context shape for the whole fabric, so tenancy, authority provenance and
// correlation survive a hop without every engine understanding every payload.
//
// Constitution §2.3 — Prime shall not become the mandatory execution path.
// This is a SHAPE, not a bus: nothing here routes anything.
// ─────────────────────────────────────────────────────────────────────────────

const message = (over: Record<string, unknown> = {}): unknown => ({
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

const parsed = (over: Record<string, unknown> = {}): HiveMessage =>
  hiveMessageSchema.parse(message(over));

describe("the four categories", () => {
  it("carries exactly command, event, query and result", () => {
    expect(messageCategorySchema.options).toEqual(["COMMAND", "EVENT", "QUERY", "RESULT"]);
  });

  it("requires a COMMAND to carry the authority it was produced under", () => {
    // Commands are consequential by definition. One with no traceable
    // authority cannot be audited afterwards.
    const without = parseHiveMessage(message({ category: "COMMAND" }));
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.reason).toContain("producedUnderAuthority");

    const withAuthority = parseHiveMessage(
      message({
        category: "COMMAND",
        producedUnderAuthority: { decisionId: "gd-1", decidedAt: "2026-08-29T09:59:00.000Z" },
      }),
    );
    expect(withAuthority.ok).toBe(true);
  });

  it("requires a RESULT to name the message it answers", () => {
    // A result nobody can tie to a request is an answer to an unknown question.
    expect(parseHiveMessage(message({ category: "RESULT" })).ok).toBe(false);
    expect(
      parseHiveMessage(
        message({ category: "RESULT", trace: { correlationId: "cor-1", causationId: "msg_0" } }),
      ).ok,
    ).toBe(true);
  });

  it("lets an EVENT report a fact without authority", () => {
    // An event reports something that already happened. Requiring authority to
    // state a fact would confuse reporting with acting.
    expect(parseHiveMessage(message({ category: "EVENT" })).ok).toBe(true);
  });
});

describe("authority on a message is provenance, not a grant", () => {
  it("names the authority the SENDER acted under", () => {
    const m = parsed({
      category: "COMMAND",
      producedUnderAuthority: { decisionId: "gd-7", decidedAt: "2026-08-29T09:00:00.000Z" },
    });
    expect(m.producedUnderAuthority?.decisionId).toBe("gd-7");
  });

  it("is named so a consumer cannot read it as its own permission", () => {
    // The §7 mistake, one layer out: the sender was authorized to send, which
    // says nothing about what the receiver may do. The field name has to make
    // misuse read wrongly.
    const m = parsed({
      category: "COMMAND",
      producedUnderAuthority: { decisionId: "gd-7", decidedAt: "2026-08-29T09:00:00.000Z" },
    });
    const keys = Object.keys(m);
    expect(keys).toContain("producedUnderAuthority");
    expect(keys).not.toContain("authority");
    expect(keys).not.toContain("permissions");
  });
});

describe("tenancy cannot go quietly missing", () => {
  it("refuses a message with neither tenant nor system scope", () => {
    // A missing tenant is far more often a bug than a system message, so the
    // absence has to be declared rather than inferred.
    const result = parseHiveMessage(message({ tenant: undefined, systemScoped: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("system-scoped");
  });

  it("refuses a message claiming both", () => {
    expect(parseHiveMessage(message({ systemScoped: true })).ok).toBe(false);
  });

  it("accepts a genuinely system-scoped message", () => {
    // A heartbeat or an engine registration belongs to no tenant.
    expect(
      parseHiveMessage(message({ tenant: undefined, systemScoped: true, messageType: "engine.heartbeat" }))
        .ok,
    ).toBe(true);
  });

  it("delivers only within a tenant", () => {
    const m = parsed();
    expect(deliverableTo(m, "ksix")).toBe(true);
    expect(deliverableTo(m, "another-shop")).toBe(false);
  });

  it("delivers a system-scoped message to anyone", () => {
    const m = parsed({ tenant: undefined, systemScoped: true });
    expect(deliverableTo(m, "ksix")).toBe(true);
    expect(deliverableTo(m, "another-shop")).toBe(true);
  });
});

describe("payload or reference, never both and never neither", () => {
  it("refuses both", () => {
    // Two versions of the truth, and nothing says which one is current.
    expect(
      parseHiveMessage(
        message({ payloadReference: { locator: "file://x", contentType: "application/json" } }),
      ).ok,
    ).toBe(false);
  });

  it("refuses neither", () => {
    expect(parseHiveMessage(message({ payload: undefined })).ok).toBe(false);
  });

  it("accepts a reference alone", () => {
    expect(
      parseHiveMessage(
        message({
          payload: undefined,
          payloadReference: { locator: "fileiq://f_1", contentType: "image/png", sizeBytes: 90_000 },
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("protected content travels by reference only", () => {
  it("refuses restricted content inline", () => {
    // Constitution §1.8. A protected payload copied through every hop has left
    // its authorized boundary long before anybody notices.
    const result = parseHiveMessage(
      message({ dataClassification: "restricted", payload: { ssn: "000-00-0000" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("by reference, never inline");
  });

  it("refuses secret content inline", () => {
    expect(
      parseHiveMessage(message({ dataClassification: "secret", payload: { apiKey: "sk-live" } })).ok,
    ).toBe(false);
  });

  it("accepts restricted content by reference", () => {
    expect(
      parseHiveMessage(
        message({
          dataClassification: "restricted",
          payload: undefined,
          payloadReference: { locator: "fileiq://protected_1", contentType: "application/json" },
        }),
      ).ok,
    ).toBe(true);
  });

  it("lets ordinary content stay inline", () => {
    for (const c of ["public", "internal", "tenant-confidential"]) {
      expect(parseHiveMessage(message({ dataClassification: c })).ok, c).toBe(true);
    }
  });

  it("defaults to internal rather than public", () => {
    // The safer default. A message whose author did not think about
    // classification should not be treated as publishable.
    const m = hiveMessageSchema.parse(message({ dataClassification: undefined }));
    expect(m.dataClassification).toBe("internal");
  });
});

describe("replyTo ties a result to its request", () => {
  const request = parsed({
    messageId: "msg_req",
    category: "QUERY",
    messageType: "inventory.availability",
    executionId: "exec_1",
    trace: { correlationId: "cor-9" },
  });

  const reply = replyTo(request, {
    messageId: "msg_res",
    messageType: "inventory.availability.result",
    producerId: "hive.inventoryiq",
    timestamp: "2026-08-29T10:00:01.000Z",
    payload: { available: 36 },
  });

  it("keeps the correlation and sets causation to the request", () => {
    // Hand-wiring this at each call site is how a trace ends up as two
    // unrelated halves.
    expect(reply.trace.correlationId).toBe("cor-9");
    expect(reply.trace.causationId).toBe("msg_req");
  });

  it("carries the request's tenant and execution forward", () => {
    expect(reply.tenant?.organizationId).toBe("ksix");
    expect(reply.executionId).toBe("exec_1");
  });

  it("is a RESULT", () => {
    expect(reply.category).toBe("RESULT");
  });
});

describe("it does not replace the event schema", () => {
  it("leaves platformEventSchema working", () => {
    // Eight consumers including the live in-memory bus. This envelope is the
    // wider shape, not a migration of that one.
    const event = platformEventSchema.safeParse({
      eventId: "evt_1",
      eventType: "inventory.adjusted",
      occurredAt: "2026-08-29T10:00:00.000Z",
      publishedAt: "2026-08-29T10:00:00.000Z",
      // `service`, not `engine` — I guessed the field name and the schema
      // caught it, which is what .strict() is for.
      source: { service: "inventoryiq" },
      trace: { correlationId: "cor-1" },
      payload: {},
    });
    expect(event.success).toBe(true);
  });

  it("can carry a platform event as an EVENT payload", () => {
    const wrapped = parseHiveMessage(
      message({
        category: "EVENT",
        messageType: "inventory.adjusted",
        payload: { eventId: "evt_1", eventType: "inventory.adjusted" },
      }),
    );
    expect(wrapped.ok).toBe(true);
  });
});

describe("the envelope routes nothing", () => {
  it("mentions no bus, queue, broker or Prime", () => {
    // §2.3 — Prime shall not become the mandatory execution path. A field
    // naming a transport would make one transport the default by gravity.
    const keys = Object.keys(parsed());
    for (const forbidden of ["bus", "queue", "topic", "broker", "route", "prime", "destination"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden)), forbidden).toBe(false);
    }
  });

  it("refuses an unrecognized field", () => {
    // A field some engines act on and others drop is how two halves of a
    // workflow come to disagree about what was sent.
    expect(parseHiveMessage(message({ deliverVia: "eventiq" })).ok).toBe(false);
  });
});
