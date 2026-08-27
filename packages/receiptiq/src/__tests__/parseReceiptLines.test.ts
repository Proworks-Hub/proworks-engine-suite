// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { parseReceiptLines } from "../normalize/parseReceiptLines.js";

// The first two cases are Family Table's own M-20 assertions, carried over
// verbatim. They are the parity anchor: if these change, the port has changed
// behaviour that ran in production against real receipts.

describe("parseReceiptLines — Family Table parity (M-20)", () => {
  it("takes the price paid, not the was-price", () => {
    const [line] = parseReceiptLines("Milk was 4.99 3.89");
    expect(line!.lineTotalCents).toBe(389);
    expect(line!.originalPriceCents).toBe(499);
    expect(line!.onSale).toBe(true);
  });

  it("recognizes BOGO", () => {
    const [line] = parseReceiptLines("Chips BOGO 3.50");
    expect(line!.saleType).toBe("bogo");
    expect(line!.onSale).toBe(true);
    expect(line!.name).toBe("Chips");
  });
});

describe("parseReceiptLines — discounts", () => {
  it("applies a coupon to the line above it", () => {
    const lines = parseReceiptLines("Cereal 5.99\nCoupon 1.50");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lineTotalCents).toBe(449);
    expect(lines[0]!.originalPriceCents).toBe(599);
    expect(lines[0]!.saleType).toBe("fixed");
  });

  it("applies a bare negative line as a discount", () => {
    const lines = parseReceiptLines("Shirt 24.00\n-4.00");
    expect(lines[0]!.lineTotalCents).toBe(2000);
  });

  it("ignores a discount larger than the line it would reduce", () => {
    const lines = parseReceiptLines("Gum 1.00\nCoupon 5.00");
    expect(lines[0]!.lineTotalCents).toBe(100);
    expect(lines[0]!.onSale).toBe(false);
  });

  it("keeps a leading discount as a line rather than dropping it", () => {
    // There is nothing above it to reduce, so it cannot be applied. It is kept
    // visible instead of vanishing: a human reviewing the receipt needs to see
    // the text that was there, including the parts nothing could be done with.
    const lines = parseReceiptLines("Coupon 2.00");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lineTotalCents).toBe(200);
  });
});

describe("parseReceiptLines — quantity deals", () => {
  it("treats @ as a per-unit price", () => {
    const [line] = parseReceiptLines("Soup 2 @ 2.50");
    expect(line!.quantity).toBe(2);
    expect(line!.lineTotalCents).toBe(500);
    expect(line!.unitPriceCents).toBe(250);
  });

  it("treats / as a deal total", () => {
    const [line] = parseReceiptLines("Soda 2/5.00");
    expect(line!.quantity).toBe(2);
    expect(line!.lineTotalCents).toBe(500);
    expect(line!.unitPriceCents).toBe(250);
  });
});

describe("parseReceiptLines — units", () => {
  it("captures a printed weight and prices per unit", () => {
    const [line] = parseReceiptLines("Bananas 2.5 lb 3.75");
    expect(line!.unit).toBe("lb");
    expect(line!.quantity).toBe(2.5);
    expect(line!.name).toBe("Bananas");
    expect(line!.unitPriceCents).toBe(150);
  });

  it("never guesses a unit that was not printed", () => {
    const [line] = parseReceiptLines("Steel flat bar 18.97");
    expect(line!.unit).toBe("each");
    expect(line!.quantity).toBe(1);
  });
});

describe("parseReceiptLines — receipt facts", () => {
  it("marks tax as tax, not a product", () => {
    const [line] = parseReceiptLines("Sales Tax 2.47");
    expect(line!.isTax).toBe(true);
  });

  it("drops total and subtotal lines", () => {
    expect(parseReceiptLines("Total 42.00\nSubtotal 39.53")).toHaveLength(0);
  });

  it("keeps an unreadable line at zero rather than dropping it", () => {
    const [line] = parseReceiptLines("THANK YOU FOR SHOPPING");
    expect(line!.lineTotalCents).toBe(0);
    expect(line!.name).toBe("THANK YOU FOR SHOPPING");
  });
});

describe("parseReceiptLines — SKUs", () => {
  it("extracts a labelled SKU and keeps it out of the name", () => {
    const [line] = parseReceiptLines('1/8" steel flat bar SKU 123456 18.97');
    expect(line!.sku).toBe("123456");
    expect(line!.name).toBe('1/8" steel flat bar');
    expect(line!.lineTotalCents).toBe(1897);
  });

  it("does not mistake an unlabelled number for a SKU", () => {
    const [line] = parseReceiptLines("Register 4471 lane 3 12.00");
    expect(line!.sku).toBeUndefined();
  });
});

describe("parseReceiptLines — arithmetic", () => {
  it("does not drift on values that float arithmetic rounds badly", () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004. In cents it is 30.
    const lines = parseReceiptLines("A 0.10\nB 0.20");
    expect(lines[0]!.lineTotalCents + lines[1]!.lineTotalCents).toBe(30);
  });

  it("reads a comma decimal separator", () => {
    const [line] = parseReceiptLines("Brot 3,49");
    expect(line!.lineTotalCents).toBe(349);
  });
});
