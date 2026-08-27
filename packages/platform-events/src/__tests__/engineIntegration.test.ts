// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import { EVENT_TYPES, newCorrelationId, type PlatformEvent } from "@proworks-hub/contracts";
import { createReceiptIqEngine } from "@proworks-hub/receiptiq";
import { createInMemoryEventBus } from "../inMemoryEventBus.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engines publishing for real.
//
// Everything here goes through the actual engine entry points, not fixtures, so
// what is asserted is what a host would observe.
// ─────────────────────────────────────────────────────────────────────────────

const RECEIPT = `METAL SUPERMARKETS
Brighton, CO 80601
08/26/2026
A36 steel sheet 4x8x.125 SKU 55120 138.00
Sales Tax 9.66
Total 147.66`;

const tenant = { organizationId: "acme-fabrication", roles: [] };

describe("an engine with no bus", () => {
  it("behaves exactly as before", async () => {
    // The setup Family Table can adopt without adopting an event system at all.
    const engine = createReceiptIqEngine();
    const receipt = await engine.read(
      { kind: "text", text: RECEIPT },
      { ownerRef: "household-1", ownership: "tenant-private" },
    );
    expect(receipt.merchantName).toBe("Metal Supermarkets");
    expect(receipt.lines.length).toBeGreaterThan(0);
  });
});

describe("ReceiptIQ publishing", () => {
  it("announces ingestion and normalization under one correlation", async () => {
    const bus = createInMemoryEventBus();
    const heard: PlatformEvent[] = [];
    bus.subscribe("receipt.*", (e) => void heard.push(e), { consumer: "test" });

    const engine = createReceiptIqEngine({ eventBus: bus });
    const correlationId = newCorrelationId();

    await engine.read(
      { kind: "text", text: RECEIPT },
      {
        ownerRef: "shop-1",
        ownership: "tenant-private",
        source: "photo",
        tenant,
        trace: { correlationId },
      },
    );

    expect(heard.map((e) => e.eventType)).toEqual([
      EVENT_TYPES.receiptIngested,
      EVENT_TYPES.receiptNormalized,
    ]);
    // One unit of work, one thread to pull.
    expect(heard.every((e) => e.trace.correlationId === correlationId)).toBe(true);
    // A private receipt is tenant-scoped; these events carry the tenant.
    expect(heard.every((e) => e.tenant?.organizationId === "acme-fabrication")).toBe(true);
  });

  it("publishes the observation with no tenant, so the price can be shared", async () => {
    const bus = createInMemoryEventBus();
    const shared: PlatformEvent[] = [];
    bus.subscribe(EVENT_TYPES.materialPurchaseDetected, (e) => void shared.push(e), {
      consumer: "costiq-price-history",
    });

    const engine = createReceiptIqEngine({ eventBus: bus });
    const receipt = await engine.read(
      { kind: "text", text: RECEIPT },
      { ownerRef: "shop-1", ownership: "tenant-private", tenant },
    );

    engine.contribute(receipt, { optedIn: true, tenant });

    expect(shared.length).toBeGreaterThan(0);
    for (const event of shared) {
      // The engine was GIVEN a tenant and still published without one, because
      // the payload is canonical. That is the whole boundary in one assertion.
      expect(event.tenant).toBeUndefined();
      expect(JSON.stringify(event)).not.toMatch(/acme-fabrication|shop-1|ownerRef/);
    }
  });

  it("publishes nothing when the owner has not opted in", async () => {
    const bus = createInMemoryEventBus();
    const shared: PlatformEvent[] = [];
    bus.subscribe(EVENT_TYPES.materialPurchaseDetected, (e) => void shared.push(e), {
      consumer: "test",
    });

    const engine = createReceiptIqEngine({ eventBus: bus });
    const receipt = await engine.read(
      { kind: "text", text: RECEIPT },
      { ownerRef: "shop-1", ownership: "tenant-private" },
    );
    engine.contribute(receipt, { optedIn: false });

    expect(shared).toEqual([]);
  });
});

describe("publication is best-effort", () => {
  it("does not fail the operation when the bus throws", async () => {
    const onPublishError = vi.fn();
    const brokenBus = {
      publish: () => Promise.reject(new Error("broker unreachable")),
      subscribe: () => () => {},
    };

    const engine = createReceiptIqEngine({ eventBus: brokenBus, onPublishError });
    const receipt = await engine.read(
      { kind: "text", text: RECEIPT },
      { ownerRef: "shop-1", ownership: "tenant-private" },
    );

    // The receipt was read. Failing to tell anyone does not un-read it.
    expect(receipt.merchantName).toBe("Metal Supermarkets");
    await new Promise((r) => setTimeout(r, 0));
    expect(onPublishError).toHaveBeenCalled();
  });
});

describe("the cross-host loop, end to end", () => {
  it("carries a purchase from one application's receipt to another's cost history", async () => {
    const bus = createInMemoryEventBus();

    // A consumer standing in for CostIQ's price history. ReceiptIQ does not
    // know it exists, and nothing in ReceiptIQ imports it.
    const priceHistory: Array<{ itemKey: string; cents: number; merchant: string }> = [];
    bus.subscribe<{ observation: { itemKey: string; unitPrice: { cents: number }; merchantName: string } }>(
      EVENT_TYPES.materialPurchaseDetected,
      (event) => {
        priceHistory.push({
          itemKey: event.payload.observation.itemKey,
          cents: event.payload.observation.unitPrice.cents,
          merchant: event.payload.observation.merchantName,
        });
      },
      { consumer: "costiq-price-history" },
    );

    // A household scans a receipt in one application.
    const familyTable = createReceiptIqEngine({ eventBus: bus });
    const receipt = await familyTable.read(
      { kind: "text", text: RECEIPT },
      {
        ownerRef: "household-kreutzer",
        ownership: "tenant-private",
        tenant: { organizationId: "family-table", roles: [] },
      },
    );
    familyTable.contribute(receipt, { optedIn: true });

    // A different application now knows what steel costs.
    expect(priceHistory.length).toBeGreaterThan(0);
    const steel = priceHistory.find((p) => p.itemKey.includes("steel"));
    expect(steel?.cents).toBe(13800);
    expect(steel?.merchant).toBe("Metal Supermarkets");

    // And learned nothing about the household.
    expect(JSON.stringify(priceHistory)).not.toMatch(/household|kreutzer|family-table/i);
  });
});
