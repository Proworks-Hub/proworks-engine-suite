// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import {
  createSpecialistRegistry,
  type CoreAnswer,
  type CoreRefusal,
  type CoreRequest,
  type Specialist,
  type SpecialistRegistry,
} from "@proworks-hub/core-kit";

// ─────────────────────────────────────────────────────────────────────────────
// Finance Core: what it coordinates.
//
// The machinery moved to core-kit once Operations Core needed the same thing.
// What stays here is the only part that is actually financial: the closed
// vocabulary of questions this domain answers.
//
// The public names are unchanged. `FinanceSpecialist`, `FinanceRegistry` and
// the rest are now aliases over the generic — hosts that already registered
// CostIQ against this Core keep compiling, which is the point of doing it this
// way rather than renaming everything to match the new shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the financial domain can be asked.
 *
 * Named for the QUESTION, not the engine. `calculate_cost` survives CostIQ
 * being replaced; `costiq_calculate` does not, and a caller that learned the
 * second name has coupled itself to an implementation through a string.
 */
export const financeCapabilitySchema = z.enum([
  // The canonical question, and the one a UI actually asks: "what should I
  // charge for this work order, and why?" CostIQ says `calculateJobPricing` is
  // the function downstream consumers should call, and it composes the two
  // primitives below while adding per-unit figures and the attribution an
  // audit needs. Without this capability the Core could only answer the
  // lower-level questions, so any host wanting a real price had to go around
  // it — which is how a second door opens.
  "price_job",
  "calculate_cost",
  "estimate_margin",
  "compare_cost_scenarios",
  "normalize_receipt",
  "detect_purchase",
  "allocate_budget",
  "forecast_spend",
]);
export type FinanceCapability = z.infer<typeof financeCapabilitySchema>;

export type FinanceSpecialist = Specialist<FinanceCapability>;
export type FinanceRegistry = SpecialistRegistry<FinanceCapability>;
export type FinanceRequest<TInput = unknown> = CoreRequest<FinanceCapability, TInput>;
export type FinanceAnswer<TOutput = unknown> = CoreAnswer<FinanceCapability, TOutput>;
export type FinanceRefusal = CoreRefusal<FinanceCapability>;

export function createFinanceRegistry(
  specialists: readonly FinanceSpecialist[] = [],
): FinanceRegistry {
  return createSpecialistRegistry(specialists);
}
