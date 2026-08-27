// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  costResultSchema,
  decisionContextSchema,
  eventTypeSchema,
  manufacturingPlanSchema,
  normalizedReceiptSchema,
  platformEventSchema,
  priceObservationSchema,
} from "@proworks-hub/contracts";
import { buildManufacturingPlan } from "@proworks-hub/forgeiq/manufacturing";
import {
  baseConfig,
  definition,
  machine,
  machines,
  materials,
} from "../packages/forgeiq/tests/helpers.js";
import { createCostIqEngine } from "@proworks-hub/costiq";
import { createPrimeEngine } from "@proworks-hub/prime";
import { createReceiptIqEngine } from "@proworks-hub/receiptiq";

// ─────────────────────────────────────────────────────────────────────────────
// Contract tests.
//
// The portability guard proves the engines do not IMPORT each other. These
// prove the thing that actually matters next: that what one engine produces is
// what another expects to receive.
//
// A breaking change to a contract usually does not fail a unit test — each
// engine's own tests keep passing against its own idea of the shape. It fails
// at integration, in a host, later. These are the tests that move that failure
// forward to the commit that caused it.
// ─────────────────────────────────────────────────────────────────────────────

const realPlan = () =>
  buildManufacturingPlan({
    definition,
    configuration: baseConfig(),
    materials,
    machine,
    machines,
    materialName: 'Corten Steel 1/8"',
    machineName: "Gweike M3 Ultra (fiber)",
  });

describe("what an engine produces validates against the shared contract", () => {
  it("CostIQ returns a CostResult", () => {
    const plan = realPlan();

    const result = createCostIqEngine().calculate(plan);
    // Not "it looks right" — it parses as the published contract.
    expect(() => costResultSchema.parse(result)).not.toThrow();
  });

  it("ReceiptIQ returns a NormalizedReceipt", async () => {
    const receipt = await createReceiptIqEngine().read(
      { kind: "text", text: "HOME DEPOT\nBrighton, CO\n08/26/2026\nBolt 4.50\nTotal 4.50" },
      { ownerRef: "o1", ownership: "tenant-private" },
    );
    expect(() => normalizedReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("ReceiptIQ's contributions are valid PriceObservations", async () => {
    const engine = createReceiptIqEngine();
    const receipt = await engine.read(
      { kind: "text", text: "HOME DEPOT\nBrighton, CO\n08/26/2026\nBolt 4.50\nTotal 4.50" },
      { ownerRef: "o1", ownership: "tenant-private" },
    );
    const { observations } = engine.contribute(receipt, { optedIn: true });
    for (const observation of observations) {
      expect(() => priceObservationSchema.parse(observation)).not.toThrow();
    }
  });

  it("Prime accepts a DecisionContext built from CostIQ's output", () => {
    const plan = realPlan();
    const cost = createCostIqEngine().calculate(plan);

    // The whole point: ForgeIQ's actual output and CostIQ's actual output slot
    // into Prime's input unchanged. No adapter, no reshaping, no summary that
    // could drift from what the engines really produce.
    const context = decisionContextSchema.parse({
      contextVersion: 1,
      subject: { type: "configuration", reference: "cfg-1" },
      manufacturing: plan,
      cost,
    });

    const decision = createPrimeEngine().decide(context);
    expect(["proceed", "review", "blocked"]).toContain(decision.status);
  });

  it("ForgeIQ produces a plan that validates as the published contract", () => {
    // The direction that matters: not that a fixture I wrote matches the
    // schema, but that the real producer does.
    expect(() => manufacturingPlanSchema.parse(realPlan())).not.toThrow();
  });
});

describe("event contracts", () => {
  it("every registered event type is a legal name", () => {
    for (const type of Object.values(EVENT_TYPES)) {
      expect(() => eventTypeSchema.parse(type)).not.toThrow();
    }
  });

  it("every registered event type has at least a v1 payload schema", () => {
    // A registry entry with no schema is an event nobody can validate, which
    // means a malformed payload only fails at a consumer, later, elsewhere.
    for (const type of Object.values(EVENT_TYPES)) {
      const versions = (EVENT_PAYLOAD_SCHEMAS as Record<string, Record<number, unknown>>)[type];
      expect(versions?.[1], `${type} has no v1 payload schema`).toBeDefined();
    }
  });

  it("the envelope requires a trace and refuses unknown fields", () => {
    const base = {
      eventId: "e1",
      eventType: EVENT_TYPES.receiptIngested,
      occurredAt: "2026-08-27T00:00:00.000Z",
      publishedAt: "2026-08-27T00:00:00.000Z",
      source: { service: "receiptiq" },
      payload: {},
    };
    expect(() => platformEventSchema.parse(base)).toThrow();
    expect(() =>
      platformEventSchema.parse({ ...base, trace: { correlationId: "c" }, rogue: 1 }),
    ).toThrow();
    expect(() => platformEventSchema.parse({ ...base, trace: { correlationId: "c" } })).not.toThrow();
  });
});

describe("contract versions are declared, not implied", () => {
  it("each versioned contract carries its marker", () => {
    const plan = realPlan();
    expect(plan.planVersion).toBe(1);

    const cost = createCostIqEngine().calculate(plan);
    expect(cost.resultVersion).toBe(1);
  });
});
