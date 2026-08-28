// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import type { RequestContext } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Finance Core: what it coordinates, and how it finds it.
//
// The rule that shapes this whole package: A CORE COORDINATES ITS SPECIALISTS;
// IT DOES NOT IMPORT THEM. This file declares a port, and a host registers
// CostIQ and ReceiptIQ against it at runtime.
//
// The alternative — importing CostIQ here — is the version that feels natural
// and is wrong. Finance Core could then not be tested without CostIQ, could not
// be deployed without it, and would drag every financial specialist into the
// bundle of anything that touched the Core. It would also make CostIQ
// unreplaceable, which Rule 13 forbids.
//
// So Prime asks Finance Core a domain question. Finance Core knows which
// capability answers it. Something else supplied the implementation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the financial domain can be asked.
 *
 * Named for the QUESTION, not the engine. `calculate_cost` survives CostIQ
 * being replaced; `costiq_calculate` does not, and a caller that learned the
 * second name has coupled itself to an implementation through a string.
 */
export const financeCapabilitySchema = z.enum([
  "calculate_cost",
  "estimate_margin",
  "compare_cost_scenarios",
  "normalize_receipt",
  "detect_purchase",
  "allocate_budget",
  "forecast_spend",
]);
export type FinanceCapability = z.infer<typeof financeCapabilitySchema>;

export interface FinanceRequest<TInput = unknown> {
  readonly capability: FinanceCapability;
  readonly input: TInput;
  /** Established by Prime, enriched by the Core, consumed by the specialist. */
  readonly context: RequestContext;
  readonly correlationId: string;
  /** What caused this. Distinct from correlation: one trace, many causes. */
  readonly causationId?: string;
}

export interface FinanceAnswer<TOutput = unknown> {
  readonly capability: FinanceCapability;
  readonly output: TOutput;
  /** Which specialist actually answered. */
  readonly servedBy: string;
  readonly latencyMs: number;
}

/**
 * A financial specialist, as the Core sees it.
 *
 * Deliberately narrow. The Core does not know CostIQ's shape, its options, or
 * its internals — only that something claims a capability and can be asked.
 * That is what makes a specialist replaceable by another implementation
 * honouring the same contract.
 */
export interface FinanceSpecialist {
  readonly id: string;
  readonly capabilities: readonly FinanceCapability[];
  /** Lower is preferred when two specialists claim one capability. */
  readonly preference?: number;
  handle(request: FinanceRequest): Promise<unknown>;
  /** Optional. Absent means the Core cannot know whether it is well. */
  health?(): Promise<{ healthy: boolean; detail: string }>;
}

export interface FinanceRegistry {
  register(specialist: FinanceSpecialist): void;
  /** Best specialist for a capability, or undefined. */
  resolve(capability: FinanceCapability): FinanceSpecialist | undefined;
  /** Every specialist that claims it, best first — for fallback. */
  candidates(capability: FinanceCapability): FinanceSpecialist[];
  /** What this Core can currently answer. Derived, never declared. */
  capabilities(): FinanceCapability[];
  registered(): FinanceSpecialist[];
}

export function createFinanceRegistry(
  specialists: readonly FinanceSpecialist[] = [],
): FinanceRegistry {
  const byId = new Map<string, FinanceSpecialist>();
  for (const specialist of specialists) byId.set(specialist.id, specialist);

  const registry: FinanceRegistry = {
    register(specialist) {
      // Replacing by id rather than appending: a host re-registering after a
      // reconnect should not end up with two copies, one of them dead.
      byId.set(specialist.id, specialist);
    },

    candidates(capability) {
      return [...byId.values()]
        .filter((specialist) => specialist.capabilities.includes(capability))
        .sort((a, b) => (a.preference ?? 100) - (b.preference ?? 100) || a.id.localeCompare(b.id));
    },

    resolve(capability) {
      return registry.candidates(capability)[0];
    },

    capabilities() {
      // Derived from what is actually registered. A Core that DECLARED its
      // capabilities would claim to answer questions after the specialist that
      // answered them was removed.
      const all = new Set<FinanceCapability>();
      for (const specialist of byId.values()) {
        for (const capability of specialist.capabilities) all.add(capability);
      }
      return [...all].sort();
    },

    registered() {
      return [...byId.values()];
    },
  };

  return registry;
}
