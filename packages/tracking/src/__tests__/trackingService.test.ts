// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES,
  createCapabilityResolver,
  type OrderTrackingSnapshot,
  type ShipmentTrackingSnapshot,
  type TrackingStage,
} from "@proworks-hub/contracts";

import { createTrackingService } from "../trackingService.js";
import type { ShipmentProvider, TrackingSource } from "../ports.js";

const snapshot = (
  stage: TrackingStage,
  over: Partial<OrderTrackingSnapshot> = {},
): OrderTrackingSnapshot => ({
  orderRef: "KSX-10284",
  organizationId: "org-a",
  stage,
  stageIndex: 0,
  percentComplete: 40,
  estimatedCompletionAt: "2026-09-04T17:00:00.000Z",
  confidence: "tentative",
  runningBehind: false,
  generatedAt: "2026-08-27T12:00:00.000Z",
  internal: { workOrderId: "wo_991", currentStation: "Laser #2" },
  ...over,
});

const source = (name: string, result: OrderTrackingSnapshot | null): TrackingSource => ({
  name,
  get: async () => result,
});

const failing = (name: string): TrackingSource => ({
  name,
  get: async () => {
    throw new Error(`${name} is down`);
  },
});

const request = { orderRef: "KSX-10284", organizationId: "org-a" };

describe("choosing between sources that disagree", () => {
  it("prefers the one that knows more", async () => {
    // The everyday case, not an edge case: the web order says "received"
    // because that is all it will ever know, while the shop floor has started.
    const service = createTrackingService({
      application: "proworks",
      sources: [source("orders", snapshot("received")), source("production", snapshot("in_production"))],
    });

    const view = await service.track({ ...request, audience: "customer" });
    expect(view?.stage).toBe("in_production");
  });

  it("does not depend on the order sources were registered in", async () => {
    // First-non-null-wins would make the answer a function of host wiring,
    // which is not a thing anyone remembers to get right.
    const forward = createTrackingService({
      application: "proworks",
      sources: [source("orders", snapshot("received")), source("production", snapshot("packing"))],
    });
    const reversed = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("packing")), source("orders", snapshot("received"))],
    });

    expect((await forward.track({ ...request, audience: "customer" }))?.stage).toBe("packing");
    expect((await reversed.track({ ...request, audience: "customer" }))?.stage).toBe("packing");
  });

  it("lets a cancellation beat a source still reporting progress", async () => {
    // A source that has not been told about the cancellation is precisely the
    // source that keeps cheerfully reporting progress.
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("in_production")), source("orders", snapshot("cancelled"))],
    });

    expect((await service.track({ ...request, audience: "customer" }))?.stage).toBe("cancelled");
  });

  it("surfaces a hold the same way", async () => {
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("quality_check")), source("orders", snapshot("on_hold"))],
    });

    expect((await service.track({ ...request, audience: "customer" }))?.stage).toBe("on_hold");
  });

  it("compares pickup and shipping orders on their own branches", async () => {
    // Nothing is both collected and shipped, so the branches never really
    // compete — but the ranking must not treat an unknown branch as -1.
    const service = createTrackingService({
      application: "proworks",
      sources: [source("orders", snapshot("received")), source("counter", snapshot("ready_for_pickup"))],
    });

    expect((await service.track({ ...request, audience: "customer" }))?.stage).toBe(
      "ready_for_pickup",
    );
  });

  it("returns null when nobody has heard of the order", async () => {
    const service = createTrackingService({ application: "proworks", sources: [source("orders", null)] });
    expect(await service.track({ ...request, audience: "customer" })).toBeNull();
  });
});

describe("when a source is down", () => {
  it("answers from the sources that are up", async () => {
    // A tracking page that 500s because one of four inputs is unavailable is
    // worse than one that is slightly less complete.
    const onError = vi.fn();
    const service = createTrackingService({
      application: "proworks",
      sources: [failing("production"), source("orders", snapshot("received"))],
      onError,
    });

    const view = await service.track({ ...request, audience: "customer" });
    expect(view?.stage).toBe("received");
    expect(onError).toHaveBeenCalledWith("production", expect.any(Error));
  });

  it("degrades to production-only when the carrier is unreachable", async () => {
    const shipments: ShipmentProvider = {
      name: "ups",
      get: async () => {
        throw new Error("carrier timeout");
      },
    };
    const onError = vi.fn();
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("packing"))],
      shipments,
      onError,
    });

    const view = await service.track({ ...request, audience: "customer" });
    expect(view?.stage).toBe("packing");
    expect(view?.shipment).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("ups", expect.any(Error));
  });
});

describe("merging the carrier in", () => {
  it("advances the order once the parcel is moving", async () => {
    const shipment: ShipmentTrackingSnapshot = {
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      status: "out_for_delivery",
    };
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("packing"))],
      shipments: { name: "ups", get: async () => shipment },
    });

    const view = await service.track({ ...request, audience: "customer" });
    expect(view?.stage).toBe("out_for_delivery");
    expect(view?.shipment?.trackingNumber).toBe("1Z999AA10123456784");
  });
});

describe("who is allowed to see what", () => {
  it("strips the shop from a customer's view", async () => {
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("in_production"))],
    });

    const view = await service.track({ ...request, audience: "customer" });
    expect(view?.internal).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Laser #2");
  });

  it("refuses a deep view outright when no resolver was wired", async () => {
    // Fails closed. An optional access check is not an access check: a service
    // built without a resolver has no way to know whether this consumer is
    // entitled to station names, so it declines to guess.
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("in_production"))],
    });

    await expect(service.track({ ...request, audience: "shop_floor" })).rejects.toThrow(
      /requires a capability resolver/,
    );
  });

  it("refuses a consumer that is not entitled to shop-floor depth", async () => {
    // §49's basic-versus-advanced split, actually enforced rather than
    // available. This organization has the engine; it does not have this view.
    const service = createTrackingService({
      sources: [source("production", snapshot("in_production"))],
      capabilities: createCapabilityResolver([
        { organizationId: "org-a", application: "makerops", capabilities: [CAPABILITIES.workOrder.basic] },
      ]),
      application: "makerops",
    });

    await expect(service.track({ ...request, audience: "shop_floor" })).rejects.toThrow();
  });

  it("serves the depth to a consumer that holds the capability", async () => {
    const service = createTrackingService({
      // Must match the grant's `application` below. They are separate values
      // and nothing but agreement makes the lookup succeed — which is exactly
      // why the service no longer defaults it to a host name.
      application: "proworks",
      sources: [source("production", snapshot("in_production"))],
      capabilities: createCapabilityResolver([
        {
          organizationId: "org-a",
          application: "proworks",
          capabilities: [CAPABILITIES.workOrder.shopFloor],
        },
      ]),
    });

    const view = await service.track({ ...request, audience: "shop_floor" });
    expect(view?.internal?.currentStation).toBe("Laser #2");
  });

  it("never asks for an entitlement to answer a customer", async () => {
    // A customer asking where their order is must not be gated behind the
    // shop's licence tier.
    const granted = vi.fn(async () => new Set<string>());
    const service = createTrackingService({
      application: "proworks",
      sources: [source("production", snapshot("in_production"))],
      capabilities: { granted },
    });

    await service.track({ ...request, audience: "customer" });
    expect(granted).not.toHaveBeenCalled();
  });
});
