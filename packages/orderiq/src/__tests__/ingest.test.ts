// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildInteraxisSku,
  detectListingDrift,
  externalOrderKey,
  generateInteraxisSku,
  isValidInteraxisSku,
  type CatalogProduct,
  type ExternalOrder,
} from "@proworks-hub/contracts";

import { createIngestOrderUseCase, type IngestOrderUseCase } from "../ingest.js";
import {
  createInMemoryIngestionLedger,
  createInMemoryProductCatalog,
  type InMemoryIngestionLedger,
  type InMemoryProductCatalog,
} from "../inMemory.js";

const ORG = "org-a";
// Bodies avoid I, L, O and U — the alphabet excludes them, and my first draft
// of these fixtures used "FIREPIT2" and was rejected by the very check this
// file is testing.
const SKU = buildInteraxisSku("F1REPT29");
const ORNAMENT = buildInteraxisSku("RNAMENT7");

const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  sku: SKU,
  organizationId: ORG,
  name: 'Custom Fire Pit 24"',
  productDefinitionId: "pd_firepit_v3",
  configurable: true,
  active: true,
  ...over,
});

const order = (over: Partial<ExternalOrder> = {}): ExternalOrder => ({
  channel: { channel: "etsy", accountId: "shop-1" },
  externalOrderId: "3319284",
  organizationId: ORG,
  externalOrderNumber: "#1042",
  placedAt: "2026-08-27T10:00:00.000Z",
  buyer: { name: "J. Smith", email: "relay@etsy.example" },
  lines: [
    {
      externalLineId: "line-1",
      title: 'Custom Fire Pit 24" — Corten',
      sku: SKU,
      quantity: 1,
      unitPrice: { cents: 29808, currency: "USD" },
      personalization: "Engrave: THE SMITHS — EST. 2019",
    },
  ],
  paid: true,
  ...over,
});

describe("the SKU spine", () => {
  it("catches a transposed pair rather than matching the wrong product", () => {
    // These get read down a phone and typed into an Etsy field by hand. A
    // transposition either matches nothing, which is annoying, or matches
    // ANOTHER REAL PRODUCT, which ships the wrong thing.
    const sku = buildInteraxisSku("ABCDEFGH");
    const transposed = `IX-BACDEFGH${sku[11]}`;

    expect(isValidInteraxisSku(sku)).toBe(true);
    expect(isValidInteraxisSku(transposed)).toBe(false);
  });

  it("omits the characters people misread", () => {
    // I and L look like 1, O looks like 0, and U turns codes into words
    // nobody wants printed on a work order.
    const generated = Array.from({ length: 200 }, () => generateInteraxisSku());
    for (const sku of generated) {
      expect(sku.slice(3)).not.toMatch(/[ILOU]/);
      expect(isValidInteraxisSku(sku)).toBe(true);
    }
  });

  it("keeps two shops' order numbers apart", () => {
    // Two Etsy shops under one organization will both eventually mint an order
    // numbered 1001. A key without the account silently drops the second.
    const a = externalOrderKey({ channel: "etsy", accountId: "shop-1" }, "1001");
    const b = externalOrderKey({ channel: "etsy", accountId: "shop-2" }, "1001");
    expect(a).not.toBe(b);
  });
});

describe("ingesting an order", () => {
  let ledger: InMemoryIngestionLedger;
  let catalog: InMemoryProductCatalog;
  let ingest: IngestOrderUseCase;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    ledger = createInMemoryIngestionLedger();
    catalog = createInMemoryProductCatalog([product()]);
    ingest = createIngestOrderUseCase({
      ledger,
      catalog,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      generateOrderRef: () => `ord_${++counter}`,
    });
  });

  it("matches a line to a product and marks the order routable", async () => {
    const result = await ingest.execute(order());

    expect(result.outcome).toBe("ingested");
    expect(result.order?.fullyMatched).toBe(true);
    expect(result.order?.lines[0]?.sku).toBe(SKU);
    expect(result.order?.lines[0]?.productDefinitionId).toBe("pd_firepit_v3");
    expect(result.events.map((e) => e.type)).toContain("order.ready_for_production");
  });

  it("distinguishes a fixed SKU from one that still needs configuring", async () => {
    // The flag that lets one pipeline carry an ornament and a fire pit. Ready
    // is not the same as routable.
    catalog.add(product({ sku: ORNAMENT, name: "Snowflake Ornament", configurable: false }));

    const configurable = await ingest.execute(order());
    expect(
      configurable.events.find((e) => e.type === "order.ready_for_production")?.payload,
    ).toMatchObject({ requiresConfiguration: true });

    const fixed = await ingest.execute(
      order({
        externalOrderId: "3319285",
        lines: [{ externalLineId: "l1", sku: ORNAMENT, quantity: 12 }],
      }),
    );
    expect(
      fixed.events.find((e) => e.type === "order.ready_for_production")?.payload,
    ).toMatchObject({ requiresConfiguration: false });
  });

  it("never loses what the buyer typed", async () => {
    // Personalization is the thing a buyer phones about, and the channel may
    // not keep it either.
    const result = await ingest.execute(order());
    expect(result.order?.lines[0]?.personalization).toBe("Engrave: THE SMITHS — EST. 2019");
  });

  it("keeps the channel as data rather than as structure", async () => {
    // The channel appears in exactly one place: a field whose value is a
    // string. No channel-specific keys, no per-channel branches in the shape.
    // (A buyer's relay email may of course contain the channel's name — that
    // is the buyer's data, not our structure, and my first version of this
    // test failed on exactly that.)
    const result = await ingest.execute(
      order({ buyer: { name: "J. Smith", email: "j.smith@example.com" } }),
    );

    expect(result.order?.channel.channel).toBe("etsy");
    const { channel: _c, buyer: _b, ...rest } = result.order!;
    expect(JSON.stringify(rest).toLowerCase()).not.toContain("etsy");
    expect(Object.keys(result.order!).filter((k) => /etsy|shopify/i.test(k))).toEqual([]);
  });
});

describe("the same order arriving twice", () => {
  let ledger: InMemoryIngestionLedger;
  let ingest: IngestOrderUseCase;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    ledger = createInMemoryIngestionLedger();
    ingest = createIngestOrderUseCase({
      ledger,
      catalog: createInMemoryProductCatalog([product()]),
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      generateOrderRef: () => `ord_${++counter}`,
    });
  });

  it("is ingested once, however many times it is pulled", async () => {
    // Pollers re-read, webhooks retry, and shops click sync twice.
    const first = await ingest.execute(order());
    const second = await ingest.execute(order());
    const third = await ingest.execute(order());

    expect(first.outcome).toBe("ingested");
    expect(second.outcome).toBe("duplicate");
    expect(third.outcome).toBe("duplicate");
    expect(ledger.all()).toHaveLength(1);
  });

  it("hands back the order it already has, not an empty answer", async () => {
    const first = await ingest.execute(order());
    const second = await ingest.execute(order());

    expect(second.order?.orderRef).toBe(first.order?.orderRef);
    expect(second.order?.lines).toHaveLength(1);
  });

  it("recognises a duplicate even when the payload is malformed", async () => {
    // The duplicate check runs BEFORE validation on purpose. Otherwise a
    // channel that starts sending a slightly wrong shape produces a loud
    // rejection on every poll, forever, for an order already safely stored.
    await ingest.execute(order());

    const mangled = { ...order(), lines: [] };
    expect((await ingest.execute(mangled)).outcome).toBe("duplicate");
  });

  it("treats the same number on two channels as two orders", async () => {
    await ingest.execute(order());
    const shopify = await ingest.execute(
      order({ channel: { channel: "shopify" }, externalOrderId: "3319284" }),
    );

    expect(shopify.outcome).toBe("ingested");
  });

  it("records the key before returning, so a crash cannot cause a second ingest", async () => {
    const result = await ingest.execute(order());
    const key = externalOrderKey({ channel: "etsy", accountId: "shop-1" }, "3319284");

    // The caller has not published anything yet, and the ledger already knows.
    expect(await ledger.find(ORG, key)).toMatchObject({ orderRef: result.order!.orderRef });
  });
});

describe("a line that cannot be matched", () => {
  let ingest: IngestOrderUseCase;
  let catalog: InMemoryProductCatalog;

  beforeEach(() => {
    catalog = createInMemoryProductCatalog([product()]);
    ingest = createIngestOrderUseCase({
      ledger: createInMemoryIngestionLedger(),
      catalog,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      generateOrderRef: () => "ord_1",
    });
  });

  // A fresh external order id per call. My first version reused one, so the
  // second call onwards came back as duplicates of the first — which is
  // idempotency working exactly as intended, defeating the assertions.
  let orderSeq = 0;
  const withSku = (sku: string | undefined, over: Partial<ExternalOrder> = {}) =>
    ingest.execute(
      order({
        externalOrderId: `ext-${++orderSeq}`,
        lines: [
          {
            externalLineId: "l1",
            title: "Something",
            quantity: 2,
            ...(sku ? { sku } : {}),
            personalization: "For Dad",
          },
        ],
        ...over,
      }),
    );

  it("still ingests the order, because the customer already paid", async () => {
    // Refusing the whole order over one bad SKU turns a five-minute mapping
    // job into a lost sale, and the shop hears about it from the buyer.
    const result = await withSku(undefined);

    expect(result.outcome).toBe("ingested");
    expect(result.order?.fullyMatched).toBe(false);
    expect(result.order?.lines[0]?.matchFailure).toBe("no_sku");
  });

  it("keeps the personalization on a line nobody could match", async () => {
    const result = await withSku(undefined);
    expect(result.order?.lines[0]?.personalization).toBe("For Dad");
  });

  it("does not call an order ready when part of it is not", async () => {
    const result = await withSku(undefined);
    expect(result.events.map((e) => e.type)).not.toContain("order.ready_for_production");
    expect(result.events.map((e) => e.type)).toContain("order.line_unmatched");
  });

  it("says which kind of wrong it is, because the fix differs", async () => {
    // A typo sends you back to the listing; an unknown SKU sends you to the
    // catalogue; a foreign one means the listing was never ours. Telling
    // somebody "unknown SKU" when they mistyped one sends them looking for a
    // product that was there all along.
    expect((await withSku(undefined)).order?.lines[0]?.matchFailure).toBe("no_sku");
    expect((await withSku("DTF-BLACK-XL")).order?.lines[0]?.matchFailure).toBe("foreign_sku");
    // A real SKU with one character changed: right shape, wrong check.
    const mistyped = `${SKU.slice(0, 11)}${SKU[11] === "2" ? "3" : "2"}`;
    expect((await withSku(mistyped)).order?.lines[0]?.matchFailure).toBe("malformed_sku");
    expect((await withSku(buildInteraxisSku("N5XCHKY2"))).order?.lines[0]?.matchFailure).toBe(
      "unknown_sku",
    );
  });

  it("does not let one organization's order pull another's product", async () => {
    catalog.add(product({ sku: ORNAMENT, organizationId: "org-b" }));
    const result = await withSku(ORNAMENT);

    expect(result.order?.lines[0]?.matchFailure).toBe("wrong_organization");
    expect(result.order?.lines[0]?.sku).toBeUndefined();
  });

  it("refuses a product that has been retired", async () => {
    catalog.add(product({ sku: ORNAMENT, active: false }));
    expect((await withSku(ORNAMENT)).order?.lines[0]?.matchFailure).toBe("inactive_product");
  });

  it("matches the lines it can and flags only the ones it cannot", async () => {
    const result = await ingest.execute(
      order({
        lines: [
          { externalLineId: "l1", sku: SKU, quantity: 1 },
          { externalLineId: "l2", title: "Mystery item", quantity: 3 },
        ],
      }),
    );

    expect(result.order?.lines[0]?.sku).toBe(SKU);
    expect(result.order?.lines[1]?.matchFailure).toBe("no_sku");
    expect(result.order?.fullyMatched).toBe(false);
  });
});

describe("a payload that is not an order at all", () => {
  const ingest = () =>
    createIngestOrderUseCase({
      ledger: createInMemoryIngestionLedger(),
      catalog: createInMemoryProductCatalog(),
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });

  it("is rejected without being recorded", async () => {
    const result = await ingest().execute({ nonsense: true });

    expect(result.outcome).toBe("rejected");
    expect(result.order).toBeUndefined();
    // Nothing recorded, so a corrected re-send is not refused as a duplicate.
    expect(result.events).toEqual([]);
  });

  it("refuses an order with no lines rather than storing an empty one", async () => {
    expect((await ingest().execute(order({ lines: [] }))).outcome).toBe("rejected");
  });

  it("refuses a field nobody declared", async () => {
    expect(
      (await ingest().execute({ ...order(), sellerNotes: "internal" })).outcome,
    ).toBe("rejected");
  });
});

describe("drift between the catalogue and a channel", () => {
  it("reports a price edited on the channel rather than overwriting it", async () => {
    // One direction of sync is a rule about writes, not a licence to clobber
    // quietly. A shop that edited a price in Etsy did it for a reason.
    const drift = detectListingDrift(product({ basePriceCents: 29808 }), [
      {
        sku: SKU,
        channel: { channel: "etsy" },
        listingId: "L1",
        listedPriceCents: 24900,
        status: "active",
      },
    ]);

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ field: "price", catalogValue: 29808, channelValue: 24900 });
  });

  it("catches a channel advertising more than the shop can make", async () => {
    // Two channels each showing the last unit, both selling it, and one
    // customer told after the fact.
    const drift = detectListingDrift(
      product({ basePriceCents: 1000 }),
      [
        {
          sku: SKU,
          channel: { channel: "shopify" },
          listingId: "L2",
          listedPriceCents: 1000,
          listedQuantity: 8,
          status: "active",
        },
      ],
      2,
    );

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ field: "quantity", catalogValue: 2, channelValue: 8 });
  });

  it("ignores a listing that has ended", async () => {
    const drift = detectListingDrift(product({ basePriceCents: 29808 }), [
      {
        sku: SKU,
        channel: { channel: "etsy" },
        listingId: "L1",
        listedPriceCents: 100,
        status: "ended",
      },
    ]);

    expect(drift).toEqual([]);
  });
});
