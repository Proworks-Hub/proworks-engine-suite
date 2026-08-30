// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import {
  CONSOLIDATION_METHODS,
  determineMethod,
  integrateOwnership,
  matchIntercompany,
  refuse,
  translateAndProveCta,
} from "./kernel.js";

// Capability names — question-shaped. `produce_trial_balance` is NOT claimed:
// the guard-9 screen flagged the three-way overlap with LedgerIQ and
// FinancialReportingIQ, and LedgerIQ's position stands — a book's trial
// balance is LedgerIQ's; a consolidated result is a different artefact and
// carries a different name here.
export const CONSOLIDATION_CAPABILITIES = [
  "integrate_ownership",
  "determine_consolidation_method",
  "translate_and_prove_cta",
  "match_intercompany",
] as const;

export type ConsolidationCapability = (typeof CONSOLIDATION_CAPABILITIES)[number];

export function createConsolidationSpecialist(): Specialist<ConsolidationCapability> {
  return {
    id: "consolidationiq",
    capabilities: [...CONSOLIDATION_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const input = request.input as Record<string, unknown>;
      switch (request.capability) {
        case "integrate_ownership":
          return integrateOwnership(
            input.interests as unknown as Parameters<typeof integrateOwnership>[0],
            String(input.root),
            input.dimension as "economic" | "voting",
          );
        case "determine_consolidation_method":
          return determineMethod(input as unknown as Parameters<typeof determineMethod>[0]);
        case "translate_and_prove_cta":
          return translateAndProveCta(input as unknown as Parameters<typeof translateAndProveCta>[0]);
        case "match_intercompany":
          return matchIntercompany(
            input.declarations as unknown as Parameters<typeof matchIntercompany>[0],
            BigInt(String(input.toleranceMinor ?? "0")),
          );
        default: {
          const unknown: never = request.capability;
          return refuse(
            "CONTROL_ASSESSMENT_REQUIRED",
            CONSOLIDATION_METHODS.registry,
            `ConsolidationIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Pure kernel; runs are host-orchestrated." };
    },
  };
}
