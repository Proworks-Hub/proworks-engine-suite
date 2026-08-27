import { describe, expect, it } from "vitest";
import { buildPanelCutlineSvg, cutlineFilename } from "../src/core/export/cutlineSvg";

describe("cutline SVG generator", () => {
  const base = {
    productSlug: "firepit-24",
    panelId: "front",
    panelName: "Front",
    widthIn: 24,
    heightIn: 18,
    materialLabel: 'Corten Steel 1/8"',
    machineLabel: "fiber-laser-cut",
  };

  it("emits a real-inch document with a cut panel outline", () => {
    const svg = buildPanelCutlineSvg({ ...base, elements: [] });
    expect(svg).toContain('width="24in"');
    expect(svg).toContain('viewBox="0 0 24 18"');
    expect(svg).toContain('stroke="#FF00FF"');
    expect(svg).toContain("panel-outline");
    expect(svg).toContain("Corten Steel");
  });

  it("renders text as magenta hairline and escapes content", () => {
    const svg = buildPanelCutlineSvg({
      ...base,
      elements: [
        {
          id: "t1",
          type: "text",
          text: 'TH<OM>PSON & "SONS"',
          fontFamily: "Arial Black",
          xIn: 4,
          yIn: 5,
          heightIn: 3,
          rotationDeg: 15,
        },
      ],
    });
    expect(svg).toContain("TH&lt;OM&gt;PSON &amp; &quot;SONS&quot;");
    expect(svg).toContain('font-family="Arial Black"');
    expect(svg).toContain("rotate(15");
    expect(svg).not.toContain("<OM>");
  });

  it("renders images as engrave reference with green frame", () => {
    const svg = buildPanelCutlineSvg({
      ...base,
      elements: [
        {
          id: "i1",
          type: "image",
          url: "/uploads/emblem.png",
          naturalWidthPx: 2000,
          naturalHeightPx: 2000,
          xIn: 8,
          yIn: 4,
          widthIn: 6,
          heightIn: 6,
          rotationDeg: 0,
        },
      ],
    });
    expect(svg).toContain('xlink:href="/uploads/emblem.png"');
    expect(svg).toContain('stroke="#00B050"');
  });

  it("builds the production filename convention", () => {
    expect(
      cutlineFilename({
        productSlug: "firepit-24",
        panelId: "front",
        widthIn: 24,
        heightIn: 18,
        materialSlug: "corten-steel-1-8",
      }),
    ).toBe("firepit-24-front-corten-steel-1-8-24x18in-cutline.svg");
  });
});
