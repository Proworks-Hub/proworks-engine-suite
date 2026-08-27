// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  assertTrackingSafeFor,
  internalTrackingDetailSchema,
  mergeShipmentIntoTracking,
  orderTrackingSnapshotSchema,
  redactTrackingFor,
  toPublicTrackingSnapshot,
  trackingStageIndex,
  validateTrackingSnapshot,
  type OrderTrackingSnapshot,
  type ShipmentTrackingSnapshot,
} from "../tracking.js";

// ─────────────────────────────────────────────────────────────────────────────
// The two things that can actually go wrong here: a customer sees something
// they shouldn't, or an order appears to move backwards.
// ─────────────────────────────────────────────────────────────────────────────

const snapshot = (over: Partial<OrderTrackingSnapshot> = {}): OrderTrackingSnapshot => ({
  orderRef: "KSX-10284",
  organizationId: "org-a",
  stage: "in_production",
  stageIndex: 3,
  percentComplete: 45,
  estimatedCompletionAt: "2026-09-04T17:00:00.000Z",
  confidence: "tentative",
  runningBehind: false,
  generatedAt: "2026-08-27T12:00:00.000Z",
  internal: {
    workOrderId: "wo_991",
    currentStation: "Laser #2",
    assignedOperatorId: "op-14",
    riskReason: "dependency_blocked",
    priority: "rush",
    completedStepCount: 4,
    totalStepCount: 9,
  },
  ...over,
});

const shipment = (over: Partial<ShipmentTrackingSnapshot> = {}): ShipmentTrackingSnapshot => ({
  carrier: "UPS",
  trackingNumber: "1Z999AA10123456784",
  status: "in_transit",
  shippedAt: "2026-09-02T15:00:00.000Z",
  estimatedDeliveryAt: "2026-09-05T17:00:00.000Z",
  lastKnownLocation: "Denver, CO",
  ...over,
});

describe("what each audience is shown", () => {
  it("gives the customer their package and none of the shop", () => {
    const view = redactTrackingFor(snapshot({ shipment: shipment() }), "customer");

    expect(view.shipment?.trackingNumber).toBe("1Z999AA10123456784");
    expect(view.internal).toBeUndefined();
    // Serialized, because that is the form it actually leaves in.
    const wire = JSON.stringify(view);
    for (const leak of ["Laser #2", "op-14", "wo_991", "dependency_blocked", "rush"]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("still tells the customer they are behind, without saying why", () => {
    const view = redactTrackingFor(
      snapshot({ runningBehind: true, confidence: "at_risk" }),
      "customer",
    );

    expect(view.runningBehind).toBe(true);
    expect(view.confidence).toBe("at_risk");
    expect(JSON.stringify(view)).not.toContain("dependency_blocked");
  });

  it("shows a subcontractor neither the shop's internals nor the customer's parcel", () => {
    // A partner is doing work for the originator. Where the finished box goes
    // afterwards is between the originator and its customer.
    const view = redactTrackingFor(snapshot({ shipment: shipment() }), "partner");

    expect(view.internal).toBeUndefined();
    expect(view.shipment).toBeUndefined();
    expect(view.stage).toBe("in_production");
  });

  it("gives the floor and the manager the detail they work from", () => {
    for (const audience of ["shop_floor", "manager"] as const) {
      const view = redactTrackingFor(snapshot({ shipment: shipment() }), audience);
      expect(view.internal?.currentStation).toBe("Laser #2");
      expect(view.shipment?.carrier).toBe("UPS");
    }
  });

  it("cannot leak a field added to the internal block later", () => {
    // The property that has to survive somebody who never reads this file.
    // Redaction deletes the block rather than picking fields out of it, so a
    // new field is hidden by construction rather than by remembering.
    const withNewField = snapshot({
      internal: {
        ...snapshot().internal,
        // As a future contributor would add it.
        holdReason: "customer owes a deposit",
      },
    });

    expect(JSON.stringify(toPublicTrackingSnapshot(withNewField))).not.toContain("deposit");
  });

  it("refuses to send a snapshot that was never redacted", () => {
    // The realistic failure: a host assembles a snapshot by hand and sends it
    // without going through redaction at all.
    expect(() => assertTrackingSafeFor(snapshot(), "customer")).toThrow(
      /carries internal detail/,
    );
    // And names every violation in one pass, rather than making the caller
    // fix one and rediscover the next.
    expect(() =>
      assertTrackingSafeFor(snapshot({ shipment: shipment() }), "partner"),
    ).toThrow(/internal detail .* and shipment detail/);

    // Naming the fields, so the caller can find them.
    expect(() => assertTrackingSafeFor(snapshot(), "customer")).toThrow(/currentStation/);
  });

  it("passes a redacted snapshot", () => {
    const view = redactTrackingFor(snapshot({ shipment: shipment() }), "customer");
    expect(() => assertTrackingSafeFor(view, "customer")).not.toThrow();
  });
});

describe("merging what the carrier knows", () => {
  it("does not move an order on a printed label alone", () => {
    // A label proves somebody printed a label. The box can sit on the bench
    // for two days, and telling a customer it shipped is the lie they remember.
    const merged = mergeShipmentIntoTracking(
      snapshot({ stage: "packing", stageIndex: 5 }),
      shipment({ status: "label_created" }),
    );

    expect(merged.stage).toBe("packing");
    // The detail is still attached — it just is not authoritative yet.
    expect(merged.shipment?.status).toBe("label_created");
  });

  it("lets the carrier win once the box has left", () => {
    const merged = mergeShipmentIntoTracking(
      snapshot({ stage: "packing", stageIndex: 5 }),
      shipment({ status: "out_for_delivery" }),
    );

    expect(merged.stage).toBe("out_for_delivery");
    expect(merged.estimatedCompletionAt).toBe("2026-09-05T17:00:00.000Z");
  });

  it("finishes at delivered, not at whatever production last said", () => {
    const merged = mergeShipmentIntoTracking(
      snapshot({ stage: "packing", stageIndex: 5, percentComplete: 80 }),
      shipment({ status: "delivered", deliveredAt: "2026-09-05T14:12:00.000Z" }),
    );

    expect(merged.stage).toBe("delivered");
    expect(merged.percentComplete).toBe(100);
    expect(merged.estimatedCompletionAt).toBe("2026-09-05T14:12:00.000Z");
  });

  it("never walks an order backwards on a late scan", () => {
    // Carrier events arrive out of order more often than anyone expects, and a
    // customer who watches their order go from Delivered back to Shipped calls.
    const delivered = snapshot({ stage: "delivered", stageIndex: 8 });
    const merged = mergeShipmentIntoTracking(delivered, shipment({ status: "in_transit" }));

    expect(merged.stage).toBe("delivered");
  });

  it("keeps an exception where it is rather than inventing a stage", () => {
    // "Exception" is not a position on the bar. Production's stage stands and
    // the shipment block carries the problem for whoever handles it.
    const merged = mergeShipmentIntoTracking(
      snapshot({ stage: "shipped", stageIndex: 6 }),
      shipment({ status: "exception" }),
    );

    expect(merged.stage).toBe("shipped");
    expect(merged.shipment?.status).toBe("exception");
  });

  it("leaves a cancelled order cancelled", () => {
    const merged = mergeShipmentIntoTracking(
      snapshot({ stage: "cancelled", stageIndex: -1 }),
      shipment({ status: "delivered" }),
    );

    expect(merged.stage).toBe("cancelled");
  });

  it("is a no-op with no shipment", () => {
    const production = snapshot();
    expect(mergeShipmentIntoTracking(production, undefined)).toBe(production);
  });
});

describe("the stage vocabulary", () => {
  it("keeps pickup and shipping on separate branches", () => {
    // One combined order would put ready_for_pickup and shipped in a false
    // relationship. An order is on exactly one branch.
    expect(trackingStageIndex("ready_for_pickup", "pickup")).toBeGreaterThan(-1);
    expect(trackingStageIndex("ready_for_pickup", "ship")).toBe(-1);
    expect(trackingStageIndex("delivered", "ship")).toBeGreaterThan(-1);
    expect(trackingStageIndex("delivered", "pickup")).toBe(-1);
  });

  it("treats cancelled and on_hold as conditions, not positions", () => {
    for (const stage of ["cancelled", "on_hold"] as const) {
      expect(trackingStageIndex(stage, "ship")).toBe(-1);
      expect(trackingStageIndex(stage, "pickup")).toBe(-1);
    }
  });
});

describe("the schema as a boundary", () => {
  it("refuses a field nobody declared", () => {
    // strict() is doing security work here, not tidiness: an undeclared field
    // is one that redaction has never heard of.
    expect(() =>
      validateTrackingSnapshot({ ...snapshot(), internalNotes: "customer is difficult" }),
    ).toThrow();

    expect(() =>
      internalTrackingDetailSchema.parse({ currentStation: "Laser #2", margin: 0.42 }),
    ).toThrow();
  });

  it("accepts a well-formed snapshot", () => {
    expect(() => validateTrackingSnapshot(snapshot())).not.toThrow();
    expect(orderTrackingSnapshotSchema.parse(snapshot()).orderRef).toBe("KSX-10284");
  });

  it("requires an explicit null rather than a missing ETA", () => {
    // Absent and "we don't know yet" are different, and a UI that cannot tell
    // them apart renders an empty date.
    expect(() => validateTrackingSnapshot({ ...snapshot(), estimatedCompletionAt: null }))
      .not.toThrow();
    const { estimatedCompletionAt: _omitted, ...missing } = snapshot();
    expect(() => validateTrackingSnapshot(missing)).toThrow();
  });
});
