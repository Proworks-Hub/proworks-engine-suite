import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { ProductConfiguration } from "../schemas/configuration.js";
import type { MachineProfileSpecs } from "../schemas/machineProfile.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import { selectedOptionValues, totalSurfaceAreaSqFt } from "../resolve.js";
import { buildBillOfMaterials } from "../production/bom.js";
import { resolveQuantityTier } from "./quantity.js";

// NOTE ON ARCHITECTURE: this engine computes the customer price and a rough
// internal cost estimate. The internal-cost half is the piece a dedicated
// costing engine (CostIQ) is expected to supplement or replace, by consuming
// the `ManufacturingPlan` instead — see src/core/cost/costEngine.ts. Nothing
// here depends on that migration happening; both paths can coexist.

export interface PricingInput {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
  // Resolved by the caller (server storage) — core stays DB-free.
  materials: Map<number, MaterialProfileSpecs>;
  machine: MachineProfileSpecs;
}

export interface PriceLine {
  label: string;
  amount: number;
  kind: "base" | "option" | "element" | "material" | "quantity";
}

export interface InternalCost {
  materialCost: number;
  machineTimeCost: number;
  setupCost: number;
  laborCost: number;
  /** Hardware, consumables, and packaging from the bill of materials. */
  hardwareCost: number;
  totalCost: number;
  margin: number; // customerPrice - totalCost
  marginPct: number;
  /** Stock sheets the cut parts consume, when a BOM is defined. */
  sheetsNeeded?: number;
}

export interface PriceBreakdown {
  unitPrice: number;
  quantity: number;
  customerPrice: number;
  lines: PriceLine[]; // customer-safe
  internal: InternalCost; // NEVER serialized on public endpoints
}

// Customer-safe view. Public endpoints must send breakdowns through this —
// omission by construction, not by serializer accident.
export type PublicPriceBreakdown = Omit<PriceBreakdown, "internal">;

export function toPublicBreakdown(b: PriceBreakdown): PublicPriceBreakdown {
  const { internal: _internal, ...pub } = b;
  return pub;
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computePrice(input: PricingInput): PriceBreakdown {
  const { definition, configuration, materials, machine } = input;
  const pricing = definition.pricing;
  const areaSqFt = totalSurfaceAreaSqFt(definition, configuration);

  const lines: PriceLine[] = [];
  let subtotal = pricing.basePrice;
  lines.push({ label: definition.name, amount: pricing.basePrice, kind: "base" });

  // Option modifiers, applied in definition order of the groups.
  for (const value of selectedOptionValues(definition, configuration)) {
    if (value.priceModifier) {
      const { kind, amount } = value.priceModifier;
      const delta = kind === "flat" ? amount : subtotal * amount;
      if (delta !== 0) {
        subtotal += delta;
        lines.push({ label: value.label, amount: roundMoney(delta), kind: "option" });
      }
    }
    // Material-backed values additionally charge by customizable area.
    if (value.materialProfileId !== undefined) {
      const material = materials.get(value.materialProfileId);
      if (material && material.customerUpchargePerSqFt > 0) {
        const upcharge = areaSqFt * material.customerUpchargePerSqFt;
        subtotal += upcharge;
        lines.push({
          label: `${value.label} material`,
          amount: roundMoney(upcharge),
          kind: "material",
        });
      }
    }
  }

  // Per-element personalization charges.
  let textCount = 0;
  let imageCount = 0;
  for (const elements of Object.values(configuration.surfaces)) {
    for (const el of elements) {
      if (el.type === "text") textCount++;
      else imageCount++;
    }
  }
  const elementCharge =
    textCount * pricing.perElementCharge.text +
    imageCount * pricing.perElementCharge.image;
  if (elementCharge > 0) {
    subtotal += elementCharge;
    lines.push({
      label: `Personalization (${textCount} text, ${imageCount} image)`,
      amount: roundMoney(elementCharge),
      kind: "element",
    });
  }

  const unitPrice = roundMoney(subtotal);
  const quantity = configuration.quantity;
  const tier = resolveQuantityTier(pricing.quantityTiers, quantity);
  const customerPrice = roundMoney(unitPrice * quantity * tier.unitMultiplier);
  if (quantity > 1 || tier.unitMultiplier !== 1) {
    lines.push({
      label:
        tier.unitMultiplier !== 1
          ? `Quantity ×${quantity} (tier ×${tier.unitMultiplier})`
          : `Quantity ×${quantity}`,
      amount: roundMoney(customerPrice - unitPrice),
      kind: "quantity",
    });
  }

  // ── Internal cost estimate (admin-only) ──────────────────────────────────
  const knobs = pricing.internalCost;
  // Material and hardware come from the bill of materials, which nests cut
  // parts onto real stock sheets. Products without a BOM fall back to a raw
  // area estimate inside buildBillOfMaterials.
  const bom = buildBillOfMaterials({ definition, configuration, materials });
  const perUnitMachine =
    ((knobs.estMachineMinutesPerSqFt * areaSqFt) / 60) * machine.costPerHour;
  const machineTimeCost = roundMoney(perUnitMachine * quantity);
  const setupCost = roundMoney((knobs.setupMinutes / 60) * machine.costPerHour);
  const laborCost = roundMoney((knobs.laborMinutes / 60) * knobs.laborRatePerHour * quantity);
  const totalCost = roundMoney(
    bom.materialCost + bom.hardwareCost + machineTimeCost + setupCost + laborCost,
  );
  const margin = roundMoney(customerPrice - totalCost);

  return {
    unitPrice,
    quantity,
    customerPrice,
    lines,
    internal: {
      materialCost: bom.materialCost,
      machineTimeCost,
      setupCost,
      laborCost,
      hardwareCost: bom.hardwareCost,
      totalCost,
      margin,
      marginPct: customerPrice > 0 ? roundMoney(margin / customerPrice) : 0,
      sheetsNeeded: bom.stock?.sheetsNeeded,
    },
  };
}
