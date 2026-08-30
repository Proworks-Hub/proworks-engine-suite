// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import {
  buildSchedule,
  classifyAsc842Lessee,
  LEASE_METHODS,
  periodicRateUnits,
  presentValueMinor,
  refuse,
  selectDiscountRate,
} from "./kernel.js";

// Question-shaped names. `amortize_right_of_use` is deliberately distinct
// from AssetFinanceIQ's owned-asset capability, per the flagged guard-9
// pair: a right-of-use asset is AMORTIZED, driven by the lease term and
// remeasurement events, never by asset life.
export const LEASE_CAPABILITIES = [
  "classify_lease",
  "select_lease_discount_rate",
  "measure_lease_liability",
  "amortize_right_of_use",
] as const;

export type LeaseCapability = (typeof LEASE_CAPABILITIES)[number];

export function createLeaseFinanceSpecialist(): Specialist<LeaseCapability> {
  return {
    id: "leasefinanceiq",
    capabilities: [...LEASE_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const input = request.input as Record<string, unknown>;
      switch (request.capability) {
        case "classify_lease":
          return classifyAsc842Lessee(
            input.evidence as Parameters<typeof classifyAsc842Lessee>[0],
            input.policy as Parameters<typeof classifyAsc842Lessee>[1],
          );
        case "select_lease_discount_rate":
          return selectDiscountRate(input as unknown as Parameters<typeof selectDiscountRate>[0]);
        case "measure_lease_liability": {
          const rate = periodicRateUnits(
            String(input.annualPercent),
            input.compoundingConvention as Parameters<typeof periodicRateUnits>[1],
          );
          if (!rate.ok) return rate;
          return {
            ok: true,
            value: {
              openingLiabilityMinor: presentValueMinor(
                BigInt(String(input.paymentMinor)),
                Number(input.periods),
                rate.value,
                (input.timing as "arrears" | "advance") ?? "arrears",
              ),
              capturedRateUnits: rate.value,
            },
          };
        }
        case "amortize_right_of_use":
          return { ok: true, value: buildSchedule(input as unknown as Parameters<typeof buildSchedule>[0]) };
        default: {
          const unknown: never = request.capability;
          return refuse(
            "DiscountRateUnavailable",
            LEASE_METHODS.registry,
            `LeaseFinanceIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Pure kernel; remeasurement and modification arrive in a later wave." };
    },
  };
}
