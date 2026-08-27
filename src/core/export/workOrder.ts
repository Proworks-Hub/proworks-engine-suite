import type { ProductDefinition } from "../schemas/productDefinition";
import type { ProductConfiguration } from "../schemas/configuration";
import type { PriceBreakdown } from "../pricing/pricingEngine";
import {
  resolveSurfaceDims,
  selectedOptionValues,
  totalSurfaceAreaSqFt,
} from "../resolve";

// Internal production work order (plain text, printable). Contains internal
// cost data — route it to shop-facing surfaces only, never to customers.

export interface WorkOrderInput {
  orderRef: string; // e.g. "KSix order #9"
  customerName?: string;
  productVersion: number;
  definition: ProductDefinition;
  configuration: ProductConfiguration;
  price?: PriceBreakdown | null;
  machineName?: string;
  materialName?: string;
}

const line = "─".repeat(58);

export function buildWorkOrder(input: WorkOrderInput): string {
  const { definition: def, configuration: config, price } = input;
  const out: string[] = [];

  out.push(
    "FORGEIQ PRODUCTION WORK ORDER",
    line,
    `Order:      ${input.orderRef}`,
    ...(input.customerName ? [`Customer:   ${input.customerName}`] : []),
    `Product:    ${def.name} (${def.slug} v${input.productVersion})`,
    `Process:    ${def.manufacturingProcess}`,
    ...(input.machineName ? [`Machine:    ${input.machineName}`] : []),
    ...(input.materialName ? [`Material:   ${input.materialName}`] : []),
    `Quantity:   ${config.quantity}`,
    "",
    "SELECTED OPTIONS",
    line,
  );

  const values = selectedOptionValues(def, config);
  for (const group of def.optionGroups) {
    const value = values.find((v) => group.values.some((gv) => gv.id === v.id));
    out.push(`${group.label.padEnd(12)}${value?.label ?? "—"}`);
  }

  out.push("", "PANELS", line);
  const dims = resolveSurfaceDims(def, config);
  for (const surface of def.surfaces) {
    const d = dims.get(surface.id)!;
    const elements = config.surfaces[surface.id] ?? [];
    out.push(`${surface.name} — ${d.widthIn}" × ${d.heightIn}"`);
    if (elements.length === 0) {
      out.push(`  (blank panel)`);
    }
    for (const el of elements) {
      if (el.type === "text") {
        out.push(
          `  CUT TEXT: "${el.text}" — ${el.fontFamily}, ${el.heightIn}" tall at (${el.xIn}", ${el.yIn}")${el.rotationDeg ? `, rotated ${el.rotationDeg}°` : ""}`,
        );
      } else {
        out.push(
          `  ARTWORK:  ${el.url} — ${el.widthIn}" × ${el.heightIn}" at (${el.xIn}", ${el.yIn}")${el.rotationDeg ? `, rotated ${el.rotationDeg}°` : ""}`,
        );
      }
    }
  }

  const areaSqFt = totalSurfaceAreaSqFt(def, config);
  const knobs = def.pricing.internalCost;
  const estMachineMinutes = knobs.estMachineMinutesPerSqFt * areaSqFt * config.quantity;
  out.push(
    "",
    "PRODUCTION ESTIMATE",
    line,
    `Panel area:      ${areaSqFt.toFixed(2)} sq ft per unit`,
    `Machine time:    ~${Math.ceil(estMachineMinutes)} min (+${knobs.setupMinutes} min setup)`,
    `Labor:           ~${Math.ceil(knobs.laborMinutes * config.quantity)} min`,
  );

  if (price) {
    out.push(
      "",
      "COSTING (INTERNAL — DO NOT SHIP)",
      line,
      `Material cost:   $${price.internal.materialCost.toFixed(2)}`,
      `Machine time:    $${price.internal.machineTimeCost.toFixed(2)}`,
      `Setup:           $${price.internal.setupCost.toFixed(2)}`,
      `Labor:           $${price.internal.laborCost.toFixed(2)}`,
      `Total cost:      $${price.internal.totalCost.toFixed(2)}`,
      `Sale price:      $${price.customerPrice.toFixed(2)}`,
      `Gross profit:    $${price.internal.margin.toFixed(2)} (${Math.round(price.internal.marginPct * 100)}%)`,
    );
  }

  if (config.notes) {
    out.push("", "CUSTOMER NOTES", line, config.notes);
  }

  out.push(
    "",
    "FILES",
    line,
    "Per-panel cutline SVGs travel with the order (…-cutline.svg).",
    "#FF00FF hairline = cut through · #00B050 = engrave reference.",
    "Convert text objects to paths before cutting.",
    "",
  );

  return out.join("\n");
}
