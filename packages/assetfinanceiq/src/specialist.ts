// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import {
  ASSET_METHODS,
  capitalizationVerdict,
  determineMidQuarter,
  disposalOutcome,
  measureImpairment,
  refuse,
} from "./kernel.js";

// Question-shaped names. `read_book_tax_difference` was renamed
// `report_asset_tax_basis` per TaxIQ's ruling (Part Three, Q/B-17) and its
// consumer is declared UNOWNED — the income-tax provision has no chartered
// owner, and the rename does not fix that; it makes the gap visible.
export const ASSET_CAPABILITIES = [
  "evaluate_capitalization",
  "determine_mid_quarter_convention",
  "measure_asset_impairment",
  "compute_disposal_outcome",
  "report_asset_tax_basis",
] as const;

export type AssetCapability = (typeof ASSET_CAPABILITIES)[number];

export function createAssetFinanceSpecialist(): Specialist<AssetCapability> {
  return {
    id: "assetfinanceiq",
    capabilities: [...ASSET_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const input = request.input as Record<string, unknown>;
      switch (request.capability) {
        case "evaluate_capitalization":
          return capitalizationVerdict(input as unknown as Parameters<typeof capitalizationVerdict>[0]);
        case "determine_mid_quarter_convention":
          return determineMidQuarter(
            input.population as Parameters<typeof determineMidQuarter>[0],
            input.convention as Parameters<typeof determineMidQuarter>[1],
          );
        case "measure_asset_impairment":
          return measureImpairment(input as unknown as Parameters<typeof measureImpairment>[0]);
        case "compute_disposal_outcome":
          return { ok: true, value: disposalOutcome(input as unknown as Parameters<typeof disposalOutcome>[0]) };
        case "report_asset_tax_basis":
          // The capability's declared consumer is UNOWNED (B-17: TaxIQ
          // declines the income-tax provision). Refusing honestly keeps the
          // gap visible rather than serving a number nobody is chartered to
          // consume.
          return refuse(
            "JUDGEMENT_REQUIRED",
            ASSET_METHODS.frameworkPermission,
            "report_asset_tax_basis has no chartered consumer: the corporate income-tax provision is unowned (B-17). The gap is escalated, not papered over.",
          );
        default: {
          const unknown: never = request.capability;
          return refuse(
            "JUDGEMENT_REQUIRED",
            ASSET_METHODS.frameworkPermission,
            `AssetFinanceIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Pure kernel; schedules are host-orchestrated." };
    },
  };
}
