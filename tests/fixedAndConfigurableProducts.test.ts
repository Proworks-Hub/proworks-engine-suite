// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  buildProductSku,
  detectListingDrift,
  type CanonicalProduct,
  type ExternalOrder,
} from "@proworks-hub/contracts";
import {
  createIngestOrderUseCase,
  createInMemoryIngestionLedger,
  createInMemoryProductCatalog,
} from "@proworks-hub/order-ingestion";

// ─────────────────────────────────────────────────────────────────────────────
// Two kinds of product, one pipeline.
//
// A stock ornament and a custom fire pit are sold differently and made the
// same way. The temptation is to give the ornament a synthetic empty
// configuration so it fits a configurator-shaped pipeline — and that is the
// mistake this file exists to prevent, because a fake configuration is a real
// object that somebody eventually validates, prices, versions and debugs.
//
// The fixed product does not get an empty configuration. It skips the
// configuration STEP, and everything downstream is identical.
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "org-a";
const FIXED_SKU = buildProductSku("RNAMENT7");
const CONFIGURABLE_SKU = buildProductSku("F1REPT29");

const ornament: CanonicalProduct = {
  productId: "prod_ornament",
  sku: FIXED_SKU,
  organizationId: ORG,
  name: "Snowflake Ornament",
  productDefinitionId: "pd_ornament_v1",
  // No options. Nothing for a customer to choose.
  configurable: false,
  basePriceCents: 1800,
  active: true,
};

const firePit: CanonicalProduct = {
  productId: "prod_firepit",
  sku: CONFIGURABLE_SKU,
  organizationId: ORG,
  name: 'Custom Fire Pit 24"',
  productDefinitionId: "pd_firepit_v3",
  configurable: true,
  active: true,
};

const order = (sku: string, over: Partial<ExternalOrder> = {}): ExternalOrder => ({
  channel: { channel: "etsy", accountId: "shop-1" },
  externalOrderId: `ext-${sku}`,
  organizationId: ORG,
  placedAt: "2026-08-27T10:00:00.000Z",
  lines: [{ externalLineId: "l1", sku, quantity: 1 }],
  paid: true,
  ...over,
});

const ingest = () =>
  createIngestOrderUseCase({
    ledger: createInMemoryIngestionLedger(),
    catalog: createInMemoryProductCatalog([ornament, firePit]),
    now: () => new Date("2026-08-27T12:00:00.000Z"),
    generateOrderRef: () => "ord_1",
  });

describe("a fixed SKU", () => {
  it("reaches production without anything being configured", async () => {
    const result = await ingest().execute(order(FIXED_SKU));
    const line = result.order?.lines[0];

    expect(result.order?.fullyMatched).toBe(true);
    expect(line?.configurable).toBe(false);
    expect(line?.productDefinitionId).toBe("pd_ornament_v1");

    const ready = result.events.find((e) => e.type === "order.ready_for_production");
    expect(ready?.payload).toMatchObject({ requiresConfiguration: false });
  });

  it("is not given a synthetic empty configuration", async () => {
    // The failure this guards: an empty `selections: {}` invented to satisfy a
    // pipeline shape. It is a real object, and something will eventually
    // validate, price, version and debug it.
    const result = await ingest().execute(order(FIXED_SKU));
    const line = result.order?.lines[0];

    expect(line?.selections).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(line ?? {}, "selections")).toBe(false);
  });

  it("carries the durable id, not just the SKU", async () => {
    // A work order built against a business identifier detaches the day
    // somebody reissues one.
    const result = await ingest().execute(order(FIXED_SKU));
    expect(result.order?.lines[0]?.productId).toBe("prod_ornament");
    expect(result.order?.lines[0]?.sku).toBe(FIXED_SKU);
  });
});

describe("a configurable product", () => {
  it("still reaches production, and says it is not routable yet", async () => {
    // Ready is not the same as routable: the options have to be resolved
    // before there is a route to price.
    const result = await ingest().execute(order(CONFIGURABLE_SKU));

    expect(result.order?.fullyMatched).toBe(true);
    expect(result.order?.lines[0]?.configurable).toBe(true);
    expect(
      result.events.find((e) => e.type === "order.ready_for_production")?.payload,
    ).toMatchObject({ requiresConfiguration: true });
  });

  it("keeps a buyer's choices when the channel supplied them", async () => {
    const result = await ingest().execute(
      order(CONFIGURABLE_SKU, {
        lines: [
          {
            externalLineId: "l1",
            sku: CONFIGURABLE_SKU,
            quantity: 1,
            selections: { size: '30"', material: "corten" },
            personalization: "THE SMITHS",
          },
        ],
      }),
    );

    expect(result.order?.lines[0]?.selections).toEqual({ size: '30"', material: "corten" });
    expect(result.order?.lines[0]?.personalization).toBe("THE SMITHS");
  });
});

describe("both kinds travel the same pipeline", () => {
  it("produces the same shape of line, differing only in one flag", async () => {
    const fixed = await ingest().execute(order(FIXED_SKU));
    const configurable = await ingest().execute(order(CONFIGURABLE_SKU));

    const shape = (line: Record<string, unknown> | undefined) =>
      Object.keys(line ?? {}).sort();

    // Identical keys. There is no separate fixed-product path to drift from
    // the configurable one.
    expect(shape(fixed.order?.lines[0] as never)).toEqual(
      shape(configurable.order?.lines[0] as never),
    );
    expect(fixed.order?.lines[0]?.configurable).toBe(false);
    expect(configurable.order?.lines[0]?.configurable).toBe(true);
  });

  it("mixes both on one order without either needing special handling", async () => {
    const result = await ingest().execute(
      order(FIXED_SKU, {
        lines: [
          { externalLineId: "l1", sku: FIXED_SKU, quantity: 12 },
          { externalLineId: "l2", sku: CONFIGURABLE_SKU, quantity: 1 },
        ],
      }),
    );

    expect(result.order?.fullyMatched).toBe(true);
    // One configurable line is enough to mean the order needs configuring
    // before it can be routed — the flag is about the order, not the line.
    expect(
      result.events.find((e) => e.type === "order.ready_for_production")?.payload,
    ).toMatchObject({ requiresConfiguration: true });
  });
});

describe("channel listings point at the canonical product", () => {
  it("matches on the durable id rather than the SKU", async () => {
    // A listing keyed only on a SKU silently detaches when a product is
    // renumbered — and nothing surfaces it, because the listing still looks
    // fine on its own.
    const drift = detectListingDrift(ornament, [
      {
        productId: "prod_ornament",
        sku: FIXED_SKU,
        channel: { channel: "etsy" },
        listingId: "L1",
        listedPriceCents: 1500,
        status: "active",
      },
      {
        // Same SKU string, different product. Must not be treated as this
        // product's listing.
        productId: "prod_something_else",
        sku: FIXED_SKU,
        channel: { channel: "shopify" },
        listingId: "L2",
        listedPriceCents: 9900,
        status: "active",
      },
    ]);

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ listingId: "L1", channelValue: 1500 });
  });
});
