import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { ProductConfiguration } from "../schemas/configuration.js";
import type { PriceBreakdown } from "../pricing/pricingEngine.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import type { ManufacturingPlan } from "@proworks/contracts";
import { buildBillOfMaterials } from "../production/bom.js";
import {
  resolveSurfaceDims,
  selectedOptionValues,
  totalSurfaceAreaSqFt,
} from "../resolve.js";

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
  /** Needed to nest cut parts onto real stock for the BOM section. */
  materials?: Map<number, MaterialProfileSpecs>;
  /**
   * When supplied, the routing section is rendered from the plan — the same
   * operations a costing engine sees, so the shop floor and the estimate can
   * never describe different work. Without it the work order falls back to
   * the product's single time estimate.
   */
  plan?: ManufacturingPlan;
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

  // ── Bill of materials + stock requirement ─────────────────────────────
  const bom = buildBillOfMaterials({
    definition: def,
    configuration: config,
    materials: input.materials ?? new Map(),
    materialName: input.materialName,
  });
  if (bom.items.length > 0) {
    out.push("", "BILL OF MATERIALS", line);
    for (const item of bom.items) {
      const dims = item.dimensionsIn
        ? ` — ${item.dimensionsIn.widthIn}" × ${item.dimensionsIn.heightIn}"`
        : "";
      const cost = item.totalCost !== undefined ? ` — $${item.totalCost.toFixed(2)}` : "";
      out.push(`${String(item.quantity).padStart(3)} × ${item.name}${dims}${cost}`);
      if (item.note) out.push(`      ${item.note}`);
    }
    if (bom.stock) {
      out.push(
        "",
        "STOCK REQUIRED",
        line,
        `Sheets:          ${bom.stock.sheetsNeeded} × ${bom.stock.materialName ?? "stock"} @ $${bom.stock.sheetCost.toFixed(2)}`,
        `Part area:       ${bom.stock.partAreaSqFt.toFixed(2)} sq ft of ${bom.stock.sheetAreaSqFt.toFixed(2)} sq ft purchased`,
        `Utilization:     ${Math.round(bom.stock.utilizationPct * 100)}%`,
      );
      if (bom.stock.oversizedPartIds.length > 0) {
        out.push(`⚠ Too large for stock: ${bom.stock.oversizedPartIds.join(", ")}`);
      }
    }
  }

  const areaSqFt = totalSurfaceAreaSqFt(def, config);
  const knobs = def.pricing.internalCost;

  // ── Routing ───────────────────────────────────────────────────────────
  if (input.plan && input.plan.operations.length > 0) {
    const ops = input.plan.operations;
    out.push("", "ROUTING", line);
    ops.forEach((op, index) => {
      const where = op.isLabor ? "bench" : (op.machineName ?? op.machineProcess);
      const setup = op.setupMinutes > 0 ? ` +${op.setupMinutes} setup` : "";
      out.push(
        `${index + 1}. ${op.name ?? op.type} — ${where}  (${Math.ceil(op.estimatedMinutes)} min${setup})`,
      );
      if (op.note) out.push(`      ${op.note}`);
    });
    const machineMinutes = ops
      .filter((op) => !op.isLabor)
      .reduce((sum, op) => sum + op.estimatedMinutes + op.setupMinutes, 0);
    out.push(
      "",
      "PRODUCTION ESTIMATE",
      line,
      `Panel area:      ${areaSqFt.toFixed(2)} sq ft per unit`,
      `Machine time:    ~${Math.ceil(machineMinutes)} min across ${ops.filter((o) => !o.isLabor).length} machine operation(s)`,
      `Bench labor:     ~${Math.ceil(input.plan.labor.estimatedMinutes)} min`,
    );
  } else {
    const estMachineMinutes = knobs.estMachineMinutesPerSqFt * areaSqFt * config.quantity;
    out.push(
      "",
      "PRODUCTION ESTIMATE",
      line,
      `Panel area:      ${areaSqFt.toFixed(2)} sq ft per unit`,
      `Machine time:    ~${Math.ceil(estMachineMinutes)} min (+${knobs.setupMinutes} min setup)`,
      `Labor:           ~${Math.ceil(knobs.laborMinutes * config.quantity)} min`,
      "(No routing declared for this product — single estimated operation.)",
    );
  }

  if (price) {
    out.push(
      "",
      "COSTING (INTERNAL — DO NOT SHIP)",
      line,
      `Material cost:   $${price.internal.materialCost.toFixed(2)}`,
      `Hardware/pkg:    $${(price.internal.hardwareCost ?? 0).toFixed(2)}`,
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
