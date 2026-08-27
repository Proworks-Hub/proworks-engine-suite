/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/pricingEngine.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Phase 1 deliverable per docs/COST-IQ-ENGINE-SPEC.md §19 —
 *           the canonical entry point that composes calculateJobCost
 *           and applyMargin into a single PricingResult. This is what
 *           UI / reports / Cost IQ tab will call.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. All product decisions, business logic, domain rules,
 * workflows, and architecture were defined by Steven. AI tools (Cursor,
 * Claude, Codex, ChatGPT, Perplexity) were used strictly as coding
 * assistants — comparable to working with a hired developer — and hold
 * no rights, claim, license, or beneficial interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 * Library and framework imports remain governed by their respective
 * licenses; no third-party source code has been copied, adapted, or
 * paraphrased into this file.
 */

/**
 * Layer:        Orchestrator (Cost IQ engine, Phase 1 entry point)
 * Imported by:  Future Cost IQ tab UI, snapshot writers, reports
 * Depends on:   costCalculator, marginCalculator, all model files
 * Stability:    CANONICAL (Phase 1)
 *
 * Responsibility
 * --------------
 * Combine the two pure pieces (cost math + margin math) into the
 * single result UI consumers care about. Adds:
 *   - per-unit cost and per-unit price (pre-divided so consumers
 *     don't re-derive)
 *   - capturedAt ISO timestamp (snapshot moment, useful for the
 *     learning layer in later phases)
 *   - workOrderId / tenantId pass-through for audit + attribution
 *
 * Phase 1 scope: cost + suggested price only. Discounts, surcharges,
 * benchmark comparison, batch tier logic, and warning generation
 * arrive in Phase 2+. This is intentional — Phase 1 proves the
 * foundation works end-to-end before layering business rules on top.
 *
 * Determinism
 * -----------
 * The clock is injected (defaults to `() => new Date()`). Tests can
 * pass a frozen clock for deterministic snapshots; production uses
 * the wall clock. The function is otherwise pure.
 */

import { calculateJobCost } from "./costCalculator";
import {
  applyMargin,
  type MarginInput,
} from "./marginCalculator";
import type { JobCostInput } from "../models/jobCostInputModel";
import type { PricingResult } from "../models/pricingResultModel";

export interface CalculateJobPricingDeps {
  /** Clock override for deterministic tests. Defaults to wall clock. */
  readonly now?: () => Date;
}

/**
 * Compute a complete `PricingResult` for a job. Synchronous, pure
 * (modulo the clock dep). The single function downstream consumers
 * should call when they want "what should I charge for this work
 * order, and why?"
 */
export function calculateJobPricing(
  input: JobCostInput,
  margin: MarginInput,
  deps: CalculateJobPricingDeps = {},
): PricingResult {
  const now = deps.now ?? (() => new Date());

  const breakdown = calculateJobCost(input);
  const marginResult = applyMargin(breakdown.totalCost, margin);

  // Per-unit values: divide by the job's overall quantity. Quantity 0
  // is a degenerate case but we guard against /0 by reporting 0 — the
  // job-level totals are still accurate.
  const safeQuantity = input.quantity > 0 ? input.quantity : 1;
  const perUnitCost = input.quantity > 0
    ? breakdown.totalCost / safeQuantity
    : 0;
  const perUnitPrice = input.quantity > 0
    ? marginResult.suggestedPrice / safeQuantity
    : 0;

  return Object.freeze({
    workOrderId: input.workOrderId,
    tenantId: input.tenantId,
    capturedAt: now().toISOString(),
    quantity: input.quantity,
    breakdown,
    perUnitCost,
    mode: margin.mode,
    marginPercent: margin.marginPercent,
    suggestedPrice: marginResult.suggestedPrice,
    perUnitPrice,
    grossProfit: marginResult.grossProfit,
    realizedMarginPercent: marginResult.realizedMarginPercent,
  });
}
