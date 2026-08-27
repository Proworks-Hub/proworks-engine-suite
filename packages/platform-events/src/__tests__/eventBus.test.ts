// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_TYPES,
  newCorrelationId,
  type PlatformEvent,
  type PriceObservation,
} from "@proworks-hub/contracts";
import {
  createInMemoryEventBus,
  createInMemoryProcessedEventLedger,
  type InMemoryEventBus,
} from "../inMemoryEventBus.js";

const source = { service: "receiptiq" } as const;
const trace = () => ({ correlationId: newCorrelationId() });
const tenant = { organizationId: "acme", roles: [] };

const observation = (): PriceObservation => ({
  ownership: "canonical",
  itemKey: "a36 steel sheet",
  itemName: "A36 steel sheet",
  merchantKey: "metalsupermarkets",
  merchantName: "Metal Supermarkets",
  region: "US-CO",
  price: { cents: 13800, currency: "USD" },
  quantity: 1,
  unit: "each",
  unitPrice: { cents: 13800, currency: "USD" },
  onSale: false,
  saleType: null,
  observedOn: "2026-08-26",
  source: "receipt",
  confidence: 0.8,
  fingerprint: "fp-1",
});

let bus: InMemoryEventBus;
beforeEach(() => {
  bus = createInMemoryEventBus();
});

describe("publishing", () => {
  it("assigns identity and timing so publishers cannot get them wrong", async () => {
    const event = await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source,
      tenant,
      trace: trace(),
      payload: { fingerprint: "fp-1", source: "photo", extractor: "receiptiq-text", lineCount: 3 },
    });
    expect(event.eventId).toBeTruthy();
    expect(event.publishedAt).toBeTruthy();
    expect(event.occurredAt).toBe(event.publishedAt);
    expect(event.eventVersion).toBe(1);
  });

  it("keeps occurredAt distinct from publishedAt for a backfill", async () => {
    const event = await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source,
      tenant,
      trace: trace(),
      occurredAt: "2020-01-01T00:00:00.000Z",
      payload: { fingerprint: "old", source: "import", extractor: "receiptiq-text", lineCount: 1 },
    });
    expect(event.occurredAt).not.toBe(event.publishedAt);
  });

  it("refuses an event type that is not domain.entity.action", async () => {
    await expect(
      bus.publish({ eventType: "PlanGenerated", source, tenant, trace: trace(), payload: {} }),
    ).rejects.toThrow();
  });

  it("refuses a payload that does not match its registered schema", async () => {
    await expect(
      bus.publish({
        eventType: EVENT_TYPES.receiptNormalized,
        source,
        tenant,
        trace: trace(),
        payload: { fingerprint: "fp-1" },
      }),
    ).rejects.toThrow();
  });
});

describe("the canonical boundary on the bus", () => {
  it("refuses a tenant on a canonical event", async () => {
    await expect(
      bus.publish({
        eventType: EVENT_TYPES.materialPurchaseDetected,
        source,
        tenant,
        trace: trace(),
        payload: { observation: observation() },
      }),
    ).rejects.toThrow(/must be published without a tenant/i);
  });

  it("publishes the same event happily with no tenant", async () => {
    const event = await bus.publish({
      eventType: EVENT_TYPES.materialPurchaseDetected,
      source,
      trace: trace(),
      payload: { observation: observation() },
    });
    expect(event.tenant).toBeUndefined();
  });
});

describe("subscribing", () => {
  it("delivers to an exact match", async () => {
    const seen: string[] = [];
    bus.subscribe(EVENT_TYPES.receiptIngested, (e) => void seen.push(e.eventType), {
      consumer: "test",
    });
    await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source,
      tenant,
      trace: trace(),
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });
    expect(seen).toEqual([EVENT_TYPES.receiptIngested]);
  });

  it("supports a domain wildcard, so projections need no list to maintain", async () => {
    const seen: string[] = [];
    bus.subscribe("receipt.*", (e) => void seen.push(e.eventType), { consumer: "projection" });
    await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source, tenant, trace: trace(),
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });
    await bus.publish({
      eventType: EVENT_TYPES.receiptNormalized,
      source, tenant, trace: trace(),
      payload: {
        fingerprint: "f", merchantKey: "m", merchantName: "M",
        purchaseDate: "2026-08-26", lineCount: 1,
      },
    });
    expect(seen).toHaveLength(2);
  });

  it("stops delivering after unsubscribe", async () => {
    const handler = vi.fn();
    const off = bus.subscribe("*", handler, { consumer: "test" });
    off();
    await bus.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source, tenant, trace: trace(),
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("failure isolation", () => {
  it("one failing consumer does not stop the others, or the publisher", async () => {
    const good = vi.fn();
    bus.subscribe("*", () => { throw new Error("consumer exploded"); }, { consumer: "bad" });
    bus.subscribe("*", good, { consumer: "good" });

    await expect(
      bus.publish({
        eventType: EVENT_TYPES.receiptIngested,
        source, tenant, trace: trace(),
        payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
      }),
    ).resolves.toBeTruthy();

    expect(good).toHaveBeenCalledOnce();
    expect(bus.failures()).toHaveLength(1);
    expect(bus.failures()[0]!.consumer).toBe("bad");
  });

  it("reports the failure rather than swallowing it", async () => {
    const onDeliveryFailure = vi.fn();
    const b = createInMemoryEventBus({ onDeliveryFailure });
    b.subscribe("*", () => { throw new Error("nope"); }, { consumer: "bad" });
    await b.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source, tenant, trace: trace(),
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });
    expect(onDeliveryFailure).toHaveBeenCalledOnce();
  });
});

describe("idempotency", () => {
  it("does not deliver the same event to the same consumer twice", async () => {
    const ledger = createInMemoryProcessedEventLedger();
    const b = createInMemoryEventBus({ ledger, generateId: () => "evt_fixed" });
    const handler = vi.fn();
    b.subscribe("*", handler, { consumer: "inventory" });

    const publish = () =>
      b.publish({
        eventType: EVENT_TYPES.receiptIngested,
        source, tenant, trace: trace(),
        payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
      });

    await publish();
    await publish(); // the redelivery any real transport will eventually do

    expect(handler).toHaveBeenCalledOnce();
  });

  it("still delivers the same event to a different consumer", async () => {
    const ledger = createInMemoryProcessedEventLedger();
    const b = createInMemoryEventBus({ ledger, generateId: () => "evt_fixed" });
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe("*", a, { consumer: "inventory" });
    b.subscribe("*", c, { consumer: "costiq" });
    await b.publish({
      eventType: EVENT_TYPES.receiptIngested,
      source, tenant, trace: trace(),
      payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
    });
    expect(a).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });
});

describe("the loop the ecosystem was built for", () => {
  it("carries a household's price to a shop's cost basis, with no tenant crossing", async () => {
    // Family Table scanned a receipt. It publishes a canonical observation and
    // never learns who listens.
    const heard: PlatformEvent[] = [];
    bus.subscribe(EVENT_TYPES.materialPurchaseDetected, (e) => void heard.push(e), {
      consumer: "costiq-price-history",
    });

    const correlation = newCorrelationId();
    await bus.publish({
      eventType: EVENT_TYPES.materialPurchaseDetected,
      source: { service: "receiptiq" },
      trace: { correlationId: correlation },
      payload: { observation: observation() },
    });

    expect(heard).toHaveLength(1);
    const event = heard[0]!;

    // The consumer got the price...
    const payload = event.payload as { observation: PriceObservation };
    expect(payload.observation.unitPrice.cents).toBe(13800);

    // ...and nothing about who paid it.
    expect(event.tenant).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/household|organizationId|ownerRef/);

    // And the work is traceable end to end.
    expect(event.trace.correlationId).toBe(correlation);
  });
});
