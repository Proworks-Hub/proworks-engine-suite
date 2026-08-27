// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { traceContextSchema } from "./trace.js";

/**
 * The shop-floor step an operation represents. Declared here rather than
 * imported so this package depends on nothing but zod — a producer other
 * than ForgeIQ must be able to build a plan.
 */
export const operationTypeSchema = z.enum([
  "cut",
  "engrave",
  "print",
  "bend",
  "weld",
  "assemble",
  "finish",
  "qc",
  "pack",
]);
export type OperationType = z.infer<typeof operationTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// ManufacturingPlan — ForgeIQ's normalized output, and the contract a costing
// engine (CostIQ) consumes.
//
// ForgeIQ answers: what is being built, can we make it, and what does making
// it require? The plan therefore describes REQUIREMENTS AND QUANTITIES —
// parts, sheets, minutes, operations — not money.
//
// Rates the host happens to have recorded on its machine and material
// profiles are passed through under `advisoryRates`, clearly marked: a
// costing engine may use them when it has nothing better, but it owns the
// economics and is free to ignore them entirely.
//
// A consumer of this plan needs no knowledge of the builder UI, the host
// application, or how the customer arrived at this configuration.
// ─────────────────────────────────────────────────────────────────────────────

export const PLAN_VERSION = 1;

export const planPartSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "cut-part" parts are nested onto stock; the rest are bought in. */
  kind: z.enum(["cut-part", "hardware", "consumable", "packaging"]),
  /** Total across the whole order (perUnit × quantity). */
  quantity: z.number().int().min(0),
  perUnit: z.number().min(0),
  widthIn: z.number().positive().optional(),
  heightIn: z.number().positive().optional(),
  /** Area of a single part, when it has dimensions. */
  areaSqFt: z.number().min(0).optional(),
  /** Cost the host recorded for a bought-in item, if any. Advisory. */
  knownUnitCost: z.number().min(0).optional(),
  note: z.string().optional(),
});

export const planStockSchema = z.object({
  materialName: z.string().optional(),
  materialCategory: z.string(),
  thicknessIn: z.number().positive(),
  sheetWidthIn: z.number().positive(),
  sheetHeightIn: z.number().positive(),
  sheetsNeeded: z.number().int().min(0),
  partAreaSqFt: z.number().min(0),
  sheetAreaSqFt: z.number().min(0),
  /** Purchased area the parts do not consume. */
  wasteAreaSqFt: z.number().min(0),
  utilizationPct: z.number().min(0).max(1),
  /** Parts that do not fit the stock in any orientation. */
  oversizedPartIds: z.array(z.string()),
});

export const planOperationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: operationTypeSchema,
  /** Machine process this runs on; "bench" when no machine is involved. */
  machineProcess: z.string(),
  machineName: z.string().optional(),
  /** Which machine profile runs this step, when a machine does. */
  machineProfileId: z.number().int().optional(),
  /**
   * That machine's hourly cost, carried per operation because a job may
   * touch several machines at different rates. Advisory, like every rate on
   * the plan — a costing engine may substitute its own.
   */
  advisoryRatePerHour: z.number().min(0).optional(),
  /** Run time across the whole order, excluding setup. */
  estimatedMinutes: z.number().min(0),
  /** Once-per-job setup, not multiplied by quantity. */
  setupMinutes: z.number().min(0),
  /**
   * Bench work — costed at a labor rate, not a machine rate. Its minutes are
   * also summed into `labor.estimatedMinutes`, so a costing engine must not
   * charge both (see `labor.derivedFromOperations`).
   */
  isLabor: z.boolean().default(false),
  note: z.string().optional(),
});

export const planLaborSchema = z.object({
  estimatedMinutes: z.number().min(0),
  /**
   * True when this total is the sum of the plan's own labor operations. A
   * costing engine should then cost those operations and skip this block,
   * rather than counting the same minutes twice.
   */
  derivedFromOperations: z.boolean().default(false),
  note: z.string().optional(),
});

// Rates ForgeIQ happens to know from the host's profiles. Present so a
// costing engine can bootstrap; never authoritative.
export const planAdvisoryRatesSchema = z.object({
  materialCostPerSqFt: z.number().min(0).optional(),
  sheetCost: z.number().min(0).optional(),
  machineCostPerHour: z.number().min(0).optional(),
  laborRatePerHour: z.number().min(0).optional(),
  targetMarginPct: z.number().min(0).max(1).optional(),
});

export const manufacturingPlanSchema = z.object({
  planVersion: z.literal(PLAN_VERSION),
  product: z.object({
    definitionId: z.number().int().optional(),
    slug: z.string(),
    name: z.string(),
    version: z.number().int().optional(),
    category: z.string(),
    manufacturingProcess: z.string(),
  }),
  configurationId: z.number().int().optional(),
  quantity: z.number().int().min(1),
  /** Resolved customer choices, id → label, for traceability. */
  selections: z.record(z.string()),
  material: z
    .object({
      profileId: z.number().int().optional(),
      name: z.string().optional(),
      category: z.string(),
      thicknessIn: z.number().positive(),
    })
    .nullable(),
  /**
   * The product's primary machine — the one that cuts. Retained as the
   * headline machine; `machines` lists everything the job actually touches.
   */
  machine: z
    .object({
      profileId: z.number().int().optional(),
      name: z.string().optional(),
      process: z.string(),
      workAreaWidthIn: z.number().positive(),
      workAreaHeightIn: z.number().positive(),
    })
    .nullable(),
  /** Every machine this job routes through, in first-use order. */
  machines: z
    .array(
      z.object({
        profileId: z.number().int().optional(),
        name: z.string().optional(),
        process: z.string(),
        workAreaWidthIn: z.number().positive(),
        workAreaHeightIn: z.number().positive(),
      }),
    )
    .default([]),
  parts: z.array(planPartSchema),
  stock: planStockSchema.nullable(),
  operations: z.array(planOperationSchema),
  labor: planLaborSchema,
  /** Finishing selected by the customer, e.g. "High-temp black coating". */
  finishing: z.array(z.object({ id: z.string(), name: z.string() })),
  advisoryRates: planAdvisoryRatesSchema,
  manufacturability: z.object({
    valid: z.boolean(),
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
  }),
  /**
   * True when no bill of materials was defined and quantities were inferred
   * from panel area alone. A costing engine should treat such a plan as a
   * rough estimate.
   */
  estimatedFromArea: z.boolean(),
  /**
   * Ties this to the unit of work that produced it. Optional so nothing
   * existing breaks; supplied, it is what makes a wrong answer traceable back
   * through the engines that produced it.
   */
  trace: traceContextSchema.optional(),
});

export type ManufacturingPlan = z.infer<typeof manufacturingPlanSchema>;
export type PlanPart = z.infer<typeof planPartSchema>;
export type PlanStock = z.infer<typeof planStockSchema>;
export type PlanOperation = z.infer<typeof planOperationSchema>;
