import { describe, expect, it } from "vitest";
import { computePrice } from "../src/core/pricing/pricingEngine";
import { buildWorkOrder } from "../src/core/export/workOrder";
import { buildPanelCutlineSvg } from "../src/core/export/cutlineSvg";
import { baseConfig, definition, machine, materials } from "./helpers";

describe("work order builder", () => {
  const config = baseConfig({
    quantity: 2,
    notes: "Leave the patina raw please",
    surfaces: {
      front: [
        { id: "t1", type: "text", text: "THOMPSON", fontFamily: "Impact", xIn: 4, yIn: 5, heightIn: 3, rotationDeg: 0 },
        { id: "i1", type: "image", url: "/uploads/emblem.png", naturalWidthPx: 2000, naturalHeightPx: 2000, xIn: 9, yIn: 9, widthIn: 5, heightIn: 5, rotationDeg: 0 },
      ],
    },
  });
  const price = computePrice({ definition, configuration: config, materials, machine });
  const doc = buildWorkOrder({
    orderRef: "KSix order #9",
    customerName: "Print Test",
    productVersion: 2,
    definition,
    configuration: config,
    price,
    machineName: "Gweike M3 Ultra (fiber)",
    materialName: 'Corten Steel 1/8"',
  });

  it("carries identity, options, and panels", () => {
    expect(doc).toContain("KSix order #9");
    expect(doc).toContain("firepit-24 v2");
    expect(doc).toContain("Gweike M3 Ultra (fiber)");
    expect(doc).toContain('Size        24"');
    expect(doc).toContain('CUT TEXT: "THOMPSON" — Impact, 3" tall');
    expect(doc).toContain("ARTWORK:  /uploads/emblem.png");
    expect(doc).toContain("(blank panel)"); // back/left/right untouched
    expect(doc).toContain("Quantity:   2");
  });

  it("carries internal costing and estimates", () => {
    expect(doc).toContain("COSTING (INTERNAL — DO NOT SHIP)");
    expect(doc).toContain(`Total cost:      $${price.internal.totalCost.toFixed(2)}`);
    expect(doc).toContain(`Sale price:      $${price.customerPrice.toFixed(2)}`);
    expect(doc).toContain("Panel area:      12.00 sq ft per unit");
    // 4 min/sqft × 12 sqft × qty 2 = 96 min
    expect(doc).toContain("~96 min (+20 min setup)");
  });

  it("carries customer notes", () => {
    expect(doc).toContain("Leave the patina raw please");
  });
});

describe("cutline SVG with traced contour", () => {
  it("emits the artwork silhouette as a scaled magenta cut path", () => {
    const svg = buildPanelCutlineSvg({
      productSlug: "firepit-24",
      panelId: "front",
      panelName: "Front",
      widthIn: 24,
      heightIn: 18,
      elements: [
        { id: "i1", type: "image", url: "/uploads/emblem.png", naturalWidthPx: 1000, naturalHeightPx: 1000, xIn: 10, yIn: 6, widthIn: 4, heightIn: 4, rotationDeg: 0 },
      ],
      cutContours: {
        i1: {
          outer: [
            { x: 0.5, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          holes: [
            [
              { x: 0.4, y: 0.5 },
              { x: 0.6, y: 0.5 },
              { x: 0.5, y: 0.75 },
            ],
          ],
        },
      },
    });
    // Triangle scaled into the 4" box at (10,6): apex (12,6), corners (14,10),(10,10)
    expect(svg).toContain('id="cut-artwork"');
    expect(svg).toContain("M12.0000,6.0000 L14.0000,10.0000 L10.0000,10.0000 Z");
    // Interior hole is cut too: (11.6,8) (12.4,8) (12,9)
    expect(svg).toContain("M11.6000,8.0000 L12.4000,8.0000 L12.0000,9.0000 Z");
    // The artwork stays as a dimmed operator reference, not an engrave frame.
    expect(svg).toContain('opacity="0.5"');
    expect(svg).not.toContain('stroke="#00B050"');
  });

  it("falls back to the engrave frame without a contour", () => {
    const svg = buildPanelCutlineSvg({
      productSlug: "firepit-24",
      panelId: "front",
      panelName: "Front",
      widthIn: 24,
      heightIn: 18,
      elements: [
        { id: "i1", type: "image", url: "/uploads/photo.jpg", naturalWidthPx: 1000, naturalHeightPx: 800, xIn: 10, yIn: 6, widthIn: 4, heightIn: 3.2, rotationDeg: 0 },
      ],
    });
    expect(svg).toContain('stroke="#00B050"');
    expect(svg).not.toContain('id="cut-artwork"');
  });
});
