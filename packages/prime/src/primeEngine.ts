// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  DecisionAction,
  DecisionContext,
  DecisionEngine,
  DecisionReason,
  DecisionResult,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Prime — evaluate it, route it, decide what happens next.
//
// A first, deliberately tiny rule set whose purpose is to prove the handoff:
// Prime reads normalized output from ForgeIQ and CostIQ plus operational
// signals, and returns a decision. Every import above is `import type`, so
// Prime has ZERO runtime dependency on either engine.
//
// Decision statuses map to the plain-language names used in the architecture:
//   proceed  = AUTO_APPROVE   — nothing needs a human
//   review   = MANUAL_REVIEW  — a person should look before it runs
//   blocked  = REJECT/BLOCK   — genuinely cannot proceed as configured
//
// Rules operate only on normalized fields — never on product names — so the
// same engine evaluates a fire pit, a sign, or anything else ForgeIQ can
// describe. AI reasoning, scheduling, outsourcing optimization, purchasing
// automation, and capacity planning are all deliberately absent.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrimeConfig {
  /** Margin below this sends the job to a human. */
  minMarginPct?: number;
  /** Manufacturing warnings at or above this count trigger review. */
  warningReviewThreshold?: number;
  /** Whether incomplete costing forces review. */
  reviewWhenCostIncomplete?: boolean;
}

const DEFAULTS = {
  minMarginPct: 0.35,
  warningReviewThreshold: 3,
  reviewWhenCostIncomplete: true,
} as const;

/**
 * A Prime instance. Narrower than the DecisionEngine port: this implementation
 * is synchronous and deterministic, so callers get a DecisionResult without
 * awaiting. It still satisfies the port.
 */
export interface PrimeEngine extends DecisionEngine {
  decide(context: DecisionContext): DecisionResult;
}

export function createPrimeEngine(config: PrimeConfig = {}): PrimeEngine {
  const settings = { ...DEFAULTS, ...config };

  return {
    name: "prime",
    decide(context: DecisionContext): DecisionResult {
      const reasons: DecisionReason[] = [];
      const actions: DecisionAction[] = [];
      let blocked = false;
      let needsReview = false;

      const plan = context.manufacturing;
      const cost = context.cost;

      // ── Manufacturability is the only hard block ────────────────────────
      if (plan && !plan.manufacturability.valid) {
        blocked = true;
        reasons.push({
          code: "not-manufacturable",
          message: `Configuration failed manufacturability validation (${plan.manufacturability.errors} error(s)).`,
          severity: "critical",
        });
        actions.push({
          code: "return-to-design",
          label: "Return to design for correction",
          target: "review",
        });
      }

      // ── Manufacturing warnings ──────────────────────────────────────────
      if (plan && plan.manufacturability.warnings >= settings.warningReviewThreshold) {
        needsReview = true;
        reasons.push({
          code: "manufacturing-warnings",
          message: `${plan.manufacturability.warnings} manufacturing warnings on this configuration.`,
          severity: "warning",
        });
      }

      // ── Economics ───────────────────────────────────────────────────────
      if (cost?.marginPct !== undefined && cost.marginPct < settings.minMarginPct) {
        needsReview = true;
        reasons.push({
          code: "margin-below-minimum",
          message: `Margin of ${Math.round(cost.marginPct * 100)}% is below the ${Math.round(settings.minMarginPct * 100)}% minimum.`,
          severity: "warning",
        });
        actions.push({
          code: "review-pricing",
          label: "Review pricing before accepting",
          target: "sales",
        });
      }

      if (settings.reviewWhenCostIncomplete && cost && cost.unpriced.length > 0) {
        needsReview = true;
        reasons.push({
          code: "cost-incomplete",
          message: `${cost.unpriced.length} item(s) could not be costed: ${cost.unpriced.join(", ")}.`,
          severity: "warning",
        });
      }

      // ── Operational signals, matched contract-to-contract ───────────────
      for (const op of plan?.operations ?? []) {
        const signal = context.capacity?.find((c) => c.process === op.machineProcess);
        if (signal && (signal.status === "overloaded" || signal.status === "unavailable")) {
          needsReview = true;
          reasons.push({
            code: "capacity-constrained",
            message: `${op.machineProcess} is ${signal.status}.`,
            severity: "warning",
          });
          actions.push({
            code: "consider-outsourcing",
            label: `Consider outsourcing ${op.type}`,
            target: "production",
          });
        }
      }

      const stock = plan?.stock;
      const inventory = stock
        ? context.inventory?.find((i) => i.materialCategory === stock.materialCategory)
        : undefined;
      if (inventory?.sufficient === false) {
        needsReview = true;
        reasons.push({
          code: "material-shortfall",
          message: `On-hand ${stock!.materialCategory} is insufficient for this job.`,
          severity: "warning",
        });
        actions.push({
          code: "purchase-material",
          label: `Purchase ${stock!.sheetsNeeded} sheet(s) of ${stock!.materialCategory}`,
          target: "purchasing",
        });
      }

      const status: DecisionResult["status"] = blocked
        ? "blocked"
        : needsReview
          ? "review"
          : "proceed";

      if (status === "proceed") {
        reasons.push({
          code: "auto-approved",
          message: "Manufacturable, adequately priced, and no operational exceptions.",
          severity: "info",
        });
      }

      return {
        engine: "prime",
        resultVersion: 1,
        status,
        priority: context.commercial?.rush ? "expedite" : "normal",
        reasons,
        actions,
      };
    },
  };
}
