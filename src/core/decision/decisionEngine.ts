import { z } from "zod";
import { manufacturingPlanSchema } from "../manufacturing/manufacturingPlan";
import { costResultSchema } from "../cost/costEngine";

// ─────────────────────────────────────────────────────────────────────────────
// The decision seam.
//
// ForgeIQ answers "can we make it?". CostIQ answers "what does it cost?".
// A decision engine (Prime) answers "given everything we know, what should
// happen next?" — routing, prioritization, approval, outsourcing, risk.
//
// This file is the PORT, not the implementation. ForgeIQ never imports a
// decision engine and never makes business decisions; a host wires one in.
//
// Everything a decision engine sees arrives through published contracts:
// a ManufacturingPlan from ForgeIQ, a CostResult from CostIQ, and operational
// context supplied by whatever systems know it (order management, capacity,
// inventory). It never reaches into another engine's private internals.
//
// Every field is optional except the subject, because a decision engine must
// be usable on partial information — a quote with no cost yet, an order with
// no capacity data — rather than requiring the full stack to be present.
// ─────────────────────────────────────────────────────────────────────────────

export const DECISION_CONTEXT_VERSION = 1;
export const DECISION_RESULT_VERSION = 1;

/** Operational facts ForgeIQ does not produce; hosts and MakerOps supply them. */
export const capacitySignalSchema = z.object({
  /** Matches ManufacturingPlan operations' machineProcess where applicable. */
  process: z.string(),
  status: z.enum(["available", "constrained", "overloaded", "unavailable"]),
  queuedMinutes: z.number().min(0).optional(),
  note: z.string().optional(),
});

export const inventorySignalSchema = z.object({
  /** Matches ManufacturingPlan stock's materialCategory where applicable. */
  materialCategory: z.string(),
  onHandSheets: z.number().min(0).optional(),
  sufficient: z.boolean().optional(),
  note: z.string().optional(),
});

export const commercialContextSchema = z.object({
  orderTotal: z.number().min(0).optional(),
  currency: z.string().optional(),
  customerType: z.string().optional(),
  /** ISO 8601. */
  dueDate: z.string().optional(),
  rush: z.boolean().optional(),
});

export const decisionContextSchema = z.object({
  contextVersion: z.literal(DECISION_CONTEXT_VERSION),
  /** What is being decided about, in the host's own terms. */
  subject: z.object({
    type: z.enum(["quote", "order", "job", "configuration"]),
    reference: z.string(),
  }),
  /** From ForgeIQ. Absent when the decision does not concern a built product. */
  manufacturing: manufacturingPlanSchema.optional(),
  /** From CostIQ. Absent when nothing has been costed yet. */
  cost: costResultSchema.optional(),
  commercial: commercialContextSchema.optional(),
  capacity: z.array(capacitySignalSchema).optional(),
  inventory: z.array(inventorySignalSchema).optional(),
  /** ISO 8601 — when these signals were true. */
  observedAt: z.string().optional(),
});

export const decisionReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
});

export const decisionActionSchema = z.object({
  code: z.string(),
  label: z.string(),
  /** Which part of the business the action belongs to, when known. */
  target: z
    .enum(["purchasing", "production", "scheduling", "sales", "customer", "review"])
    .optional(),
  detail: z.string().optional(),
});

export const decisionResultSchema = z.object({
  /** Identifies the engine that decided, e.g. "prime". */
  engine: z.string(),
  resultVersion: z.literal(DECISION_RESULT_VERSION).default(DECISION_RESULT_VERSION),
  /** The verdict: proceed, put in front of a human, or stop. */
  status: z.enum(["proceed", "review", "blocked"]),
  priority: z.enum(["normal", "expedite", "hold"]).default("normal"),
  /** Why — always populated for anything other than a plain proceed. */
  reasons: z.array(decisionReasonSchema).default([]),
  /** What to do about it. */
  actions: z.array(decisionActionSchema).default([]),
  /** Optional self-assessment; omit rather than inventing certainty. */
  confidence: z.number().min(0).max(1).optional(),
});

export type CapacitySignal = z.infer<typeof capacitySignalSchema>;
export type InventorySignal = z.infer<typeof inventorySignalSchema>;
export type DecisionContext = z.infer<typeof decisionContextSchema>;
export type DecisionReason = z.infer<typeof decisionReasonSchema>;
export type DecisionAction = z.infer<typeof decisionActionSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;

/**
 * Implemented by Prime, or by any host that wants to own its own business
 * rules. The context is the only input: a decision engine must not need the
 * builder UI, a host database, or another engine's internals.
 */
export interface DecisionEngine {
  /** Identifier surfaced on results and in logs. */
  readonly name: string;
  decide(context: DecisionContext): Promise<DecisionResult> | DecisionResult;
}
