/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/recipeBomCostMethod.ts
 * Module:   cost-iq-engine / core
 * Purpose:  RECIPE_BOM — what an assembly costs when it is made of things
 *           that are themselves made of things.
 */

import { z } from "zod";

import {
  type Decimal,
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  toString as decToString,
} from "../domain/decimal.js";
import { decimalStringSchema } from "../domain/costModel.js";
import type { CostComponent } from "../domain/costModel.js";
import type { CostAssumption } from "../domain/provenance.js";
import type { CostMethod, CostMethodContext, CostMethodResult } from "./methodRegistry.js";

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLICATION THROUGH LEVELS IS WHERE BOM COSTING GOES WRONG
//
// A fire pit needs 4 panels. Each panel needs 2.5 kg of steel. So the pit
// needs 10 kg — and the mistake nearly everybody makes at least once is
// costing the panel at 2.5 kg and forgetting the 4.
//
// So quantities MULTIPLY down the tree, and the multiplier at each level is
// carried explicitly rather than folded into an amount. That is what lets an
// explanation say "2.5 kg per panel × 4 panels" instead of "10 kg" with no
// account of where the 10 came from.
//
// YIELD IS NOT WASTE
//
// They are different numbers applied in different directions and confusing
// them is a real and expensive error.
//
//   WASTE  is extra input consumed:  need × wasteFactor.  1.1 means 10% more
//          material is drawn than ends up in the product.
//   YIELD  is the fraction of output that is GOOD:  need ÷ yield.  A 0.9 yield
//          means 10% of what is made is scrapped, so more must be started.
//
// A 10% waste factor and a 90% yield are NOT the same: 100 × 1.1 = 110, while
// 100 ÷ 0.9 = 111.11. Small on one line, and it compounds through every level
// of a deep assembly.
//
// EFFECTIVITY IS EVALUATED AT THE CALCULATION'S INSTANT
//
// A BOM revision that takes effect next month must not appear in this month's
// cost. Every effective-date comparison uses the supplied instant, so
// replaying an old estimate reads the structure that was in force then.
// ─────────────────────────────────────────────────────────────────────────────

const nonNegative = decimalStringSchema.refine((v) => !v.startsWith("-"), {
  message: "Must not be negative.",
});

const positive = decimalStringSchema.refine((v) => !v.startsWith("-") && compare(fromString(v), ZERO) > 0, {
  message: "Must be greater than zero.",
});

/** One line of a bill of materials or recipe. */
const bomLineSchema = z
  .object({
    lineId: z.string().min(1),
    label: z.string().min(1),
    /** How many of this per ONE of its parent. Multiplied down the tree. */
    quantityPerParent: nonNegative,
    quantityUnit: z.string().min(1),

    /**
     * Extra input consumed. 1 means none.
     *
     * Applied by MULTIPLICATION. Distinct from yield — see the header.
     */
    wasteFactor: decimalStringSchema.optional(),
    /**
     * Fraction of output that is good, 0 to 1.
     *
     * Applied by DIVISION. A 0.9 yield means more must be started.
     */
    yield: decimalStringSchema.optional(),

    /** Priced directly, for a purchased part or raw material. */
    unitCost: nonNegative.optional(),
    /** Or made of other things. A line has one or the other, never both. */
    children: z.array(z.lazy(() => bomLineSchema)).optional(),

    basisId: z.string().min(1).optional(),
    /** From when this line is part of the structure. */
    effectiveFrom: z.string().min(1).optional(),
    effectiveTo: z.string().min(1).optional(),
    /** Cost that exists here with nothing to price it. */
    unpricedReason: z.string().min(1).optional(),
  })
  .strict() as z.ZodType<BomLine>;

export interface BomLine {
  readonly lineId: string;
  readonly label: string;
  readonly quantityPerParent: string;
  readonly quantityUnit: string;
  readonly wasteFactor?: string;
  readonly yield?: string;
  readonly unitCost?: string;
  readonly children?: readonly BomLine[];
  readonly basisId?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly unpricedReason?: string;
}

export const recipeBomInputSchema = z
  .object({
    productRef: z.string().min(1),
    /** How many finished units this estimate is for. */
    quantity: positive,
    quantityUnit: z.string().min(1).default("each"),
    /** Process steps, costed like direct-job operations. */
    operations: z
      .array(
        z
          .object({
            operationId: z.string().min(1),
            label: z.string().min(1),
            /** Minutes per ONE finished unit. */
            minutesPerUnit: nonNegative,
            ratePerMinute: nonNegative,
            /** Once per batch, not per unit. */
            setupMinutes: nonNegative.optional(),
            setupRatePerMinute: nonNegative.optional(),
            basisId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    lines: z.array(bomLineSchema).default([]),
  })
  .strict();

export type RecipeBomInput = z.infer<typeof recipeBomInputSchema>;

/** Whether a line is part of the structure at `asOf`. */
function isEffective(line: BomLine, asOf: Date): boolean {
  if (line.effectiveFrom !== undefined) {
    const from = Date.parse(line.effectiveFrom);
    if (Number.isNaN(from) || from > asOf.getTime()) return false;
  }
  if (line.effectiveTo !== undefined) {
    const to = Date.parse(line.effectiveTo);
    if (!Number.isNaN(to) && to <= asOf.getTime()) return false;
  }
  return true;
}

/**
 * The quantity of a line, given how many of its parent are needed.
 *
 * `parentQuantity × quantityPerParent × wasteFactor ÷ yield`, in that order.
 * Waste multiplies (more is drawn); yield divides (more must be started).
 */
function effectiveQuantity(
  line: BomLine,
  parentQuantity: Decimal,
  scale: number,
  mode: Parameters<typeof divide>[3],
): { readonly quantity: Decimal; readonly notes: readonly string[] } {
  const notes: string[] = [];
  let quantity = multiply(parentQuantity, fromString(line.quantityPerParent));

  if (line.wasteFactor !== undefined) {
    const waste = fromString(line.wasteFactor);
    if (compare(waste, ONE) < 0) {
      throw new RangeError(
        `Line ${line.lineId} has a waste factor of ${line.wasteFactor}. A factor below 1 would mean less is consumed than used — that is a yield, and it divides rather than multiplies.`,
      );
    }
    quantity = multiply(quantity, waste);
    if (compare(waste, ONE) > 0) notes.push(`Waste factor ${line.wasteFactor} applied.`);
  }

  if (line.yield !== undefined) {
    const y = fromString(line.yield);
    if (compare(y, ZERO) <= 0 || compare(y, ONE) > 0) {
      throw new RangeError(
        `Line ${line.lineId} has a yield of ${line.yield}. A yield is the fraction of output that is good, so it must be above 0 and at most 1.`,
      );
    }
    quantity = divide(quantity, y, scale, mode);
    if (compare(y, ONE) < 0) notes.push(`Yield ${line.yield} means more must be started than is delivered.`);
  }

  return { quantity, notes };
}

export const recipeBomCostMethodV1: CostMethod<RecipeBomInput> = {
  id: "RECIPE_BOM",
  version: "1.0.0",
  summary:
    "Multi-level bill of materials and recipe costing. Quantities multiply down the tree; waste multiplies and yield divides; effectivity is evaluated at the calculation's instant. Operations are costed per finished unit with setup charged once per batch.",
  inputSchema: recipeBomInputSchema,

  compute(input: RecipeBomInput, context: CostMethodContext): CostMethodResult {
    const currency = context.policy.currency;
    const scale = context.policy.calculationScale;
    const mode = context.policy.roundingMode;
    const components: CostComponent[] = [];
    const assumptions: CostAssumption[] = [];
    const diagnostics: string[] = [];
    const seen = new Set<string>();

    const orderQuantity = fromString(input.quantity);

    // Iterative, not recursive: a deep bill of materials would overflow the
    // stack, and the crash would name framework code rather than say the data
    // was deep.
    const stack: Array<{ line: BomLine; parentQuantity: Decimal; parentId: string | undefined; path: string[] }> = [];
    for (const line of input.lines) {
      stack.push({ line, parentQuantity: orderQuantity, parentId: undefined, path: [] });
    }

    while (stack.length > 0) {
      const { line, parentQuantity, parentId, path } = stack.pop()!;

      if (!isEffective(line, context.asOf)) {
        diagnostics.push(`${line.label} is not effective at this calculation's instant and was excluded.`);
        continue;
      }

      // A line reachable twice through the same chain is a structural loop.
      // The graph builder catches cycles by parent link; this catches them
      // during expansion, before an infinite tree is built.
      if (path.includes(line.lineId)) {
        return {
          ok: false,
          reason: `Bill of materials contains a cycle: ${[...path, line.lineId].join(" -> ")}.`,
          issues: ["A component cannot contain itself, directly or through its children."],
        };
      }

      if (seen.has(line.lineId)) {
        return {
          ok: false,
          reason: `Line id ${line.lineId} appears more than once.`,
          issues: ["Ids identify nodes in the cost graph, so a duplicate makes the structure ambiguous."],
        };
      }
      seen.add(line.lineId);

      let quantity: Decimal;
      let notes: readonly string[];
      try {
        const computed = effectiveQuantity(line, parentQuantity, scale, mode);
        quantity = computed.quantity;
        notes = computed.notes;
      } catch (cause) {
        return {
          ok: false,
          reason: cause instanceof Error ? cause.message : String(cause),
          issues: [],
        };
      }

      const hasChildren = line.children !== undefined && line.children.length > 0;
      if (line.unitCost !== undefined && hasChildren) {
        return {
          ok: false,
          reason: `Line ${line.lineId} has both a unit cost and children.`,
          issues: [
            "A line is either purchased at a price or made of other things. Having both would count the same cost twice — once as the price and once as the sum of its parts.",
          ],
        };
      }

      const componentId = `bom:${line.lineId}`;

      if (line.unpricedReason !== undefined) {
        components.push({
          componentId,
          kind: "UNPRICED",
          label: line.label,
          amount: "0",
          currency,
          included: true,
          notes: [line.unpricedReason, ...notes],
          quantity: decToString(quantity),
          quantityUnit: line.quantityUnit,
          ...(parentId ? { parentId } : {}),
        } as CostComponent);
        diagnostics.push(`${line.label} has no basis and is not priced: ${line.unpricedReason}`);
      } else if (line.unitCost !== undefined) {
        components.push({
          componentId,
          kind: "MATERIAL",
          label: line.label,
          amount: decToString(multiply(quantity, fromString(line.unitCost))),
          currency,
          included: true,
          notes: [...notes],
          quantity: decToString(quantity),
          quantityUnit: line.quantityUnit,
          basisId: line.basisId ?? "unspecified",
          ...(parentId ? { parentId } : {}),
        } as CostComponent);
      } else if (hasChildren) {
        // A sub-assembly carries no cost of its own; its children do. Zero
        // here rather than absent, so the node exists in the graph and the
        // structure survives into the explanation.
        components.push({
          componentId,
          kind: "MATERIAL",
          label: line.label,
          amount: "0",
          currency,
          included: true,
          notes: [...notes],
          quantity: decToString(quantity),
          quantityUnit: line.quantityUnit,
          basisId: line.basisId ?? "assembly",
          ...(parentId ? { parentId } : {}),
        } as CostComponent);
      } else {
        return {
          ok: false,
          reason: `Line ${line.lineId} has neither a unit cost nor children.`,
          issues: [
            "A line with no price and no parts cannot be costed. If its cost is genuinely unknown, mark it with unpricedReason so it is reported rather than silently costed at zero.",
          ],
        };
      }

      for (const child of line.children ?? []) {
        stack.push({
          line: child,
          parentQuantity: quantity,
          parentId: componentId,
          path: [...path, line.lineId],
        });
      }
    }

    // ── Operations ────────────────────────────────────────────────────────
    for (const op of input.operations) {
      const runMinutes = multiply(fromString(op.minutesPerUnit), orderQuantity);
      components.push({
        componentId: `op:${op.operationId}`,
        kind: "MACHINE",
        label: op.label,
        amount: decToString(multiply(runMinutes, fromString(op.ratePerMinute))),
        currency,
        included: true,
        notes: [],
        quantity: decToString(runMinutes),
        quantityUnit: "min",
        basisId: op.basisId ?? "unspecified",
      } as CostComponent);

      if (op.setupMinutes !== undefined) {
        if (op.setupRatePerMinute === undefined) {
          return {
            ok: false,
            reason: `Operation ${op.label} has setup minutes but no setup rate.`,
            issues: ["Costing an incomplete setup rule at zero would hide a missing rate."],
          };
        }
        // ONCE per batch, not per unit. Charging setup per unit is the other
        // classic BOM error, and it makes large orders look far too expensive.
        components.push({
          componentId: `setup:${op.operationId}`,
          kind: "SETUP",
          label: `Setup — ${op.label}`,
          amount: decToString(multiply(fromString(op.setupMinutes), fromString(op.setupRatePerMinute))),
          currency,
          included: true,
          notes: ["Charged once per batch, not per unit."],
          basisId: op.basisId ?? "unspecified",
        } as CostComponent);
      }
    }

    const unpricedCount = components.filter((c) => c.kind === "UNPRICED").length;
    if (unpricedCount > 0) {
      assumptions.push({
        id: "bom.incomplete",
        statement: `${unpricedCount} line(s) in this structure have no basis and contribute nothing to the total.`,
        because: "Costing them at zero would make the total confidently too low; guessing would make it wrong with no evidence.",
        affectsComponentIds: components.filter((c) => c.kind === "UNPRICED").map((c) => c.componentId),
      });
    }

    return { ok: true, output: { components, assumptions, diagnostics } };
  },
};

/** The total quantity of a line for a given order size, for explanations. */
export function explodeQuantity(
  line: BomLine,
  orderQuantity: Decimal,
  scale: number,
  mode: Parameters<typeof divide>[3],
): Decimal {
  return effectiveQuantity(line, orderQuantity, scale, mode).quantity;
}

/** Sums a decimal list. Exported so callers need not import the arithmetic. */
export function sumAmounts(values: readonly string[]): string {
  return decToString(values.reduce<Decimal>((acc, v) => add(acc, fromString(v)), ZERO));
}
