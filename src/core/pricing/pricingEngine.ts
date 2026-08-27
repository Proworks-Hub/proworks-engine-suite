import type { ProductDefinition } from "../schemas/productDefinition";
import type { ProductConfiguration } from "../schemas/configuration";
import type { MachineProfileSpecs } from "../schemas/machineProfile";
import type { MaterialProfileSpecs } from "../schemas/materialProfile";
import {
  resolveMaterialProfileId,
  selectedOptionValues,
  totalSurfaceAreaSqFt,
} from "../resolve";
import { resolveQuantityTier } from "./quantity";

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
  totalCost: number;
  margin: number; // customerPrice - totalCost
  marginPct: number;
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
  const materialId = resolveMaterialProfileId(definition, configuration);
  const material = materialId !== undefined ? materials.get(materialId) : undefined;
  const knobs = pricing.internalCost;
  const perUnitMaterial = material ? areaSqFt * material.costPerSqFt : 0;
  const perUnitMachine =
    ((knobs.estMachineMinutesPerSqFt * areaSqFt) / 60) * machine.costPerHour;
  const materialCost = roundMoney(perUnitMaterial * quantity);
  const machineTimeCost = roundMoney(perUnitMachine * quantity);
  const setupCost = roundMoney((knobs.setupMinutes / 60) * machine.costPerHour);
  const laborCost = roundMoney((knobs.laborMinutes / 60) * knobs.laborRatePerHour * quantity);
  const totalCost = roundMoney(materialCost + machineTimeCost + setupCost + laborCost);
  const margin = roundMoney(customerPrice - totalCost);

  return {
    unitPrice,
    quantity,
    customerPrice,
    lines,
    internal: {
      materialCost,
      machineTimeCost,
      setupCost,
      laborCost,
      totalCost,
      margin,
      marginPct: customerPrice > 0 ? roundMoney(margin / customerPrice) : 0,
    },
  };
}
