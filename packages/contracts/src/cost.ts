// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { traceContextSchema } from "./trace.js";
import type { ManufacturingPlan } from "./manufacturingPlan.js";

// ─────────────────────────────────────────────────────────────────────────────
// The costing seam.
//
// ForgeIQ deliberately stops at "what does making this require?". Turning
// requirements into money — purchasing cost, waste, overhead allocation,
// margin rules, recommended price — belongs to a costing engine (CostIQ).
//
// This file is the PORT, not the implementation. It exists so a costing
// engine can be plugged in, replaced, or extracted into its own package
// without touching ForgeIQ's core. ForgeIQ never imports a cost engine; a
// host wires one in.
//
// ForgeIQ's existing PricingEngine still computes customer prices and a
// rough internal cost estimate, and continues to work unchanged. Once a real
// CostIQ exists, a host can route pricing through
// ForgeIQ → ManufacturingPlan → CostIQ → CostResult instead.
// ─────────────────────────────────────────────────────────────────────────────

export const costLineSchema = z.object({
  /** Stable machine-readable key, e.g. "material", "machine-time". */
  code: z.string(),
  label: z.string(),
  amount: z.number(),
  category: z.enum([
    "material",
    "machine",
    "labor",
    "setup",
    "consumable",
    "finishing",
    "packaging",
    "outsourced",
    "overhead",
    "other",
  ]),
});

export const COST_RESULT_VERSION = 1;

export const costResultSchema = z.object({
  /** Identifies the costing engine that produced this, e.g. "costiq". */
  engine: z.string(),
  resultVersion: z.literal(COST_RESULT_VERSION).default(COST_RESULT_VERSION),
  currency: z.string().default("USD"),
  /** Everything it costs the business to produce the plan, in total. */
  totalCost: z.number().min(0),
  lines: z.array(costLineSchema),
  /** Optional: a costing engine may also recommend what to charge. */
  recommendedPrice: z.number().min(0).optional(),
  margin: z.number().optional(),
  marginPct: z.number().optional(),
  /**
   * What the engine assumed to reach this number — flat overhead rates,
   * uncosted finishing, estimates not yet validated against production.
   * Stated so a caller never mistakes an estimate for a measured cost.
   */
  assumptions: z.array(z.string()).default([]),
  /** Anything the engine could not cost, so callers can say so honestly. */
  unpriced: z.array(z.string()).default([]),
  /**
   * Ties this to the unit of work that produced it. Optional so nothing
   * existing breaks; supplied, it is what makes a wrong answer traceable back
   * through the engines that produced it.
   */
  trace: traceContextSchema.optional(),
});

export type CostLine = z.infer<typeof costLineSchema>;
export type CostResult = z.infer<typeof costResultSchema>;

/**
 * Implemented by CostIQ, or by any host that wants to own its own economics.
 * The plan is the only input: a cost engine must not need the builder UI,
 * the host application, or the original product definition.
 *
 * A cost engine is therefore usable without ForgeIQ at all — ForgeIQ is the
 * preferred producer of a ManufacturingPlan, not the only possible one. Any
 * system that can construct a valid plan can be costed.
 */
export interface CostEngine {
  /** Identifier surfaced on results and in logs. */
  readonly name: string;
  calculate(plan: ManufacturingPlan): Promise<CostResult> | CostResult;
}
