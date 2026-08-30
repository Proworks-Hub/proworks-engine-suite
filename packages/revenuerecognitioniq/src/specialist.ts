// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import {
  allocateRelativeSsp,
  classifySatisfaction,
  identifyContract,
  recognizeOverTime,
  refuse,
  REVREC_METHODS,
} from "./kernel.js";

// Question-shaped names. `recognize_revenue` is the SHARED_CONTRACTS
// canonical form; the rest are this engine's own vocabulary. B-4 resolution
// (Part Three Q): the unbilled unconditional right is OWNED here — the
// conditionality test needs the obligation model and only this engine holds
// one.
export const REVREC_CAPABILITIES = [
  "recognize_revenue",
  "identify_revenue_contract",
  "classify_satisfaction_pattern",
  "allocate_transaction_price",
] as const;

export type RevRecCapability = (typeof REVREC_CAPABILITIES)[number];

export function createRevRecSpecialist(): Specialist<RevRecCapability> {
  return {
    id: "revenuerecognitioniq",
    capabilities: [...REVREC_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const input = request.input as Record<string, unknown>;
      switch (request.capability) {
        case "recognize_revenue":
          return { ok: true, value: recognizeOverTime(input as unknown as Parameters<typeof recognizeOverTime>[0]) };
        case "identify_revenue_contract":
          return identifyContract(input as unknown as Parameters<typeof identifyContract>[0]);
        case "classify_satisfaction_pattern":
          return classifySatisfaction(input as unknown as Parameters<typeof classifySatisfaction>[0]);
        case "allocate_transaction_price":
          return allocateRelativeSsp(
            BigInt(String(input.transactionPriceMinor)),
            input.obligations as Parameters<typeof allocateRelativeSsp>[1],
          );
        default: {
          const unknown: never = request.capability;
          return refuse(
            "contract-criteria-incomplete",
            REVREC_METHODS.registry,
            `RevenueRecognitionIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Pure kernel; schedules and modification accounting arrive in a later wave." };
    },
  };
}
