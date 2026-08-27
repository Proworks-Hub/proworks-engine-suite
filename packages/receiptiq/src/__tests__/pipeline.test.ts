// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import type { PriceObservation } from "@proworks-hub/contracts";
import { createReceiptIqEngine } from "../receiptiqEngine.js";
import { estimatePrice, summarizeByMerchant } from "../pricing/estimator.js";
import { classifyItem } from "../knowledge/classifier.js";
import { convertUnit, normalizeUnit } from "../normalize/units.js";
import { normalizeMerchant } from "../normalize/merchant.js";

// ─────────────────────────────────────────────────────────────────────────────
// The whole pipeline, end to end:
//
//   raw receipt → extraction → normalization → merchant recognition
//               → item normalization → price observations
//
// The worked example is the one from the specification: a household scans a
// Home Depot receipt for steel flat bar, and a fabrication shop later benefits
// from the price without either seeing the other's records.
// ─────────────────────────────────────────────────────────────────────────────

const engine = createReceiptIqEngine();

const HOME_DEPOT_RECEIPT = `THE HOME DEPOT #1234
Brighton, CO 80601
08/26/2026
1/8" steel flat bar SKU 123456 2 @ 18.97
Wood screws 1lb box 8.47
Sales Tax 3.28
Total 49.69`;

describe("raw receipt → price observations", () => {
  it("reads a real-shaped receipt end to end", async () => {
    const receipt = await engine.read(
      { kind: "text", text: HOME_DEPOT_RECEIPT },
      { ownerRef: "household-1", ownership: "tenant-private", source: "manual" },
    );

    expect(receipt.merchantName).toBe("Home Depot");
    expect(receipt.merchantKey).toBe("homedepot");
    expect(receipt.region).toBe("US-CO");
    expect(receipt.purchaseDate).toBe("2026-08-26");

    const steel = receipt.lines.find((line) => line.sku === "123456");
    expect(steel).toBeDefined();
    expect(steel!.quantity).toBe(2);
    expect(steel!.lineTotal.cents).toBe(3794);
    expect(steel!.unitPrice.cents).toBe(1897);
    expect(steel!.name).toContain("steel flat bar");

    expect(receipt.lines.some((line) => line.isTax)).toBe(true);
    expect(receipt.total!.cents).toBe(4969);
  });

  it("produces the observation the specification describes", async () => {
    const receipt = await engine.read(
      { kind: "text", text: HOME_DEPOT_RECEIPT },
      { ownerRef: "household-1", ownership: "tenant-private" },
    );
    const { observations } = engine.contribute(receipt, { optedIn: true });

    const steel = observations.find((o) => o.itemName.includes("steel flat bar"));
    expect(steel).toMatchObject({
      merchantName: "Home Depot",
      region: "US-CO",
      quantity: 2,
      observedOn: "2026-08-26",
      source: "receipt",
      ownership: "canonical",
    });
    expect(steel!.unitPrice.cents).toBe(1897);
  });

  it("recognizes the same item from another host months later", async () => {
    // Family Table scans the receipt and contributes.
    const household = await engine.read(
      { kind: "text", text: HOME_DEPOT_RECEIPT },
      { ownerRef: "household-1", ownership: "tenant-private" },
    );
    const shared = engine.contribute(household, { optedIn: true }).observations;

    // ProWorks, which has never seen that receipt, asks what steel costs.
    const steelKey = shared.find((o) => o.itemName.includes("steel flat bar"))!.itemKey;
    const estimate = engine.estimate(steelKey, shared);

    expect(estimate).not.toBeNull();
    expect(estimate!.median.cents).toBe(1897);
    // One purchase is a transaction, not a market rate, and it says so.
    expect(estimate!.confidence).toBe("low");
  });
});

describe("merchant recognition", () => {
  it("collapses the ways one chain prints itself", () => {
    const forms = ["THE HOME DEPOT #1234", "HOME DEPOT 4512 POS DEBIT", "homedepot.com", "Home Depot"];
    const keys = new Set(forms.map((form) => normalizeMerchant(form).key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("homedepot");
  });

  it("still identifies an unknown merchant usefully", () => {
    const merchant = normalizeMerchant("BRIGHTON STEEL SUPPLY #22 POS DEBIT");
    expect(merchant.key).toBeTruthy();
    expect(merchant.name).toBe("Brighton Steel Supply");
  });
});

describe("units", () => {
  it("normalizes the ways a unit is printed", () => {
    expect(normalizeUnit("LBS")).toBe("lb");
    expect(normalizeUnit("Fluid Ounces")).toBe("fl oz");
  });

  it("converts within a dimension and refuses across", () => {
    expect(convertUnit(1, "lb", "oz")).toBeCloseTo(16, 5);
    expect(convertUnit(1, "gallon", "lb")).toBeNull();
  });
});

describe("classification uses the host's taxonomy, not its own", () => {
  const lexicon = [
    { category: "raw-material", pattern: /steel|aluminum|plate|bar/ },
    { category: "fastener", pattern: /screw|bolt|nut|washer/ },
  ] as const;

  it("classifies within the taxonomy it was given", () => {
    expect(classifyItem('1/8" steel flat bar', { lexicon }).category).toBe("raw-material");
    expect(classifyItem("Wood screws", { lexicon }).category).toBe("fastener");
  });

  it("returns nothing rather than guessing", () => {
    const result = classifyItem("Birthday card", { lexicon });
    expect(result.category).toBeNull();
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("lets a human correction outrank the lexicon", () => {
    const result = classifyItem('1/8" steel flat bar', {
      lexicon,
      learned: { "1 8 steel flat bar": "stock-inventory" },
    });
    expect(result.category).toBe("stock-inventory");
    expect(result.source).toBe("learned");
  });
});

describe("the estimator", () => {
  const observation = (
    cents: number,
    observedOn: string,
    onSale = false,
    merchantKey = "homedepot",
  ): PriceObservation => ({
    ownership: "canonical",
    itemKey: "steel flat bar",
    itemName: "steel flat bar",
    merchantKey,
    merchantName: merchantKey === "homedepot" ? "Home Depot" : "Lowe's",
    region: "US-CO",
    price: { cents, currency: "USD" },
    quantity: 1,
    unit: "each",
    unitPrice: { cents, currency: "USD" },
    onSale,
    saleType: onSale ? "other" : null,
    observedOn,
    source: "receipt",
    confidence: 0.8,
    fingerprint: `${merchantKey}|${observedOn}|${cents}`,
  });

  const now = new Date("2026-08-27T12:00:00Z");

  it("prefers regular prices over sale prices", () => {
    const rows = [
      observation(1897, "2026-08-01"),
      observation(1899, "2026-07-01"),
      observation(1200, "2026-08-20", true),
    ];
    const estimate = estimatePrice("steel flat bar", rows, { now })!;
    expect(estimate.basis).toBe(2);
    expect(estimate.saleCount).toBe(1);
    expect(estimate.median.cents).toBe(1898);
  });

  it("falls back to sale prices when regular ones are too few", () => {
    const rows = [observation(1897, "2026-08-01"), observation(1200, "2026-08-20", true)];
    const estimate = estimatePrice("steel flat bar", rows, { now })!;
    expect(estimate.basis).toBe(2);
  });

  it("earns high confidence only with enough recent observations", () => {
    const recent = ["2026-08-01", "2026-08-05", "2026-08-10", "2026-08-15", "2026-08-20"].map((d) =>
      observation(1897, d),
    );
    expect(estimatePrice("steel flat bar", recent, { now })!.confidence).toBe("high");

    const old = ["2023-01-01", "2023-01-05", "2023-01-10", "2023-01-15", "2023-01-20"].map((d) =>
      observation(1897, d),
    );
    expect(estimatePrice("steel flat bar", old, { now })!.confidence).toBe("low");
  });

  it("prefers a merchant the caller actually buys from", () => {
    const rows = [
      observation(1897, "2026-08-01", false, "homedepot"),
      observation(2200, "2026-08-02", false, "lowes"),
      observation(2300, "2026-08-03", false, "lowes"),
    ];
    const estimate = estimatePrice("steel flat bar", rows, { merchantKey: "lowes", now })!;
    expect(estimate.source).toBe("merchant");
    expect(estimate.median.cents).toBe(2250);
  });

  it("returns nothing when it knows nothing", () => {
    expect(estimatePrice("unknown thing", [], { now })).toBeNull();
  });

  it("compares merchants for the same item", () => {
    const rows = [
      observation(1897, "2026-08-01", false, "homedepot"),
      observation(2200, "2026-08-02", false, "lowes"),
    ];
    const summary = summarizeByMerchant("steel flat bar", rows);
    expect(summary).toHaveLength(2);
    expect(summary.map((s) => s.merchantKey).sort()).toEqual(["homedepot", "lowes"]);
  });
});
