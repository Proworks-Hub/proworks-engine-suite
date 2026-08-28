// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { batchObservations } from "./ingestion.js";
import type { LocalObservation } from "./observation.js";
import type { StateTransition } from "./ingestion.js";

// ─────────────────────────────────────────────────────────────────────────────
// What SenseIQ hands CostIQ.
//
// The boundary is the entire point of this file, and it is one sentence:
//
//   SENSEIQ MEASURES. COSTIQ MONETIZES.
//
// There is no currency, no rate, no tariff and no price anywhere in this
// module, and that is enforced rather than remembered — `assertNoMonetaryFields`
// refuses a report carrying one. The temptation is real: SenseIQ knows the
// kilowatt-hours and multiplying by a rate is one line. But the moment it does,
// there are two engines that both know how to price energy, they disagree the
// first time a tariff changes, and nobody can say which number is right.
//
// The same rule runs the other way. CostIQ must not read a device, a threshold
// or a sensor. It receives a measurement of a class of equipment doing a class
// of work, and decides what that is worth.
// ─────────────────────────────────────────────────────────────────────────────

export const resourceKindSchema = z.enum(["energy", "runtime", "cycles"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const resourceUseReportSchema = z
  .object({
    reportId: z.string().min(1),
    /** Opaque owner reference, as everywhere else in the suite. */
    ownerRef: z.string().min(1),

    /**
     * What was measured. NOT a device id.
     *
     * CostIQ costs equipment, not sensors. Passing a device id would make the
     * financial model depend on which plug happened to be monitoring the
     * machine, and replacing the plug would look like replacing the machine.
     */
    equipmentRef: z.string().min(1),
    equipmentClass: z.string().min(1),

    kind: resourceKindSchema,
    quantity: z.number().nonnegative(),
    /** kWh, minutes, count. Carried, never assumed. */
    unit: z.string().min(1),

    from: z.string().min(1),
    to: z.string().min(1),

    /** Ties the measurement to the work that caused it, when known. */
    correlationId: z.string().min(1).optional(),

    /**
     * How the figure was arrived at.
     *
     * `measured` came from a meter. `inferred` came from a proxy, such as
     * machine state derived from power draw. CostIQ needs the difference — an
     * actual-versus-estimate comparison built on inferred runtime is comparing
     * one estimate with another, and should say so.
     */
    basis: z.enum(["measured", "inferred"]),
    /** How many readings stand behind it. */
    sampleCount: z.number().int().positive(),
  })
  .strict();
export type ResourceUseReport = z.infer<typeof resourceUseReportSchema>;

/** Words that mean money. A report carrying one has crossed the boundary. */
const MONETARY_WORDS: ReadonlySet<string> = new Set([
  "cost", "price", "rate", "tariff", "usd", "gbp", "eur", "currency",
  "amount", "charge", "billing", "spend", "margin", "revenue",
]);

function fieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Refuses a report that has started pricing things.
 *
 * Throws rather than returning false: this is a boundary violation, not a
 * validation failure, and a caller who could ignore the result would. Mirrors
 * `assertNoIdentityFields` in the shared contracts, deliberately — the same
 * shape of rule deserves the same shape of enforcement.
 */
export function assertNoMonetaryFields(value: unknown, path = "report"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoMonetaryFields(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (fieldWords(key).some((word) => MONETARY_WORDS.has(word))) {
      throw new Error(
        `SenseIQ measures; it does not price. Found "${key}" at ${path}. ` +
          `Hand the measurement to CostIQ and let it decide what the number is worth.`,
      );
    }
    assertNoMonetaryFields(entry, `${path}.${key}`);
  }
}

export interface BuildEnergyReportInput {
  observations: readonly LocalObservation[];
  equipmentRef: string;
  equipmentClass: string;
  correlationId?: string;
  reportId: string;
}

/**
 * Sums metered energy for one piece of equipment over a period.
 *
 * `basis: "measured"` because a meter reported it. Returns null rather than a
 * zero report when there is nothing to sum — zero kilowatt-hours is a claim
 * that the machine ran and used nothing, which would make an actual-versus-
 * estimate comparison read as a saving.
 */
export function buildEnergyReport(input: BuildEnergyReportInput): ResourceUseReport | null {
  const energy = input.observations.filter((observation) => observation.kind === "energy");
  if (energy.length === 0) return null;

  const batches = batchObservations(energy);
  if (batches.length !== 1) {
    // More than one unit or owner in the set. Summing across them would produce
    // a number that looks authoritative and means nothing.
    return null;
  }

  const batch = batches[0]!;
  const report = resourceUseReportSchema.parse({
    reportId: input.reportId,
    ownerRef: batch.ownerRef,
    equipmentRef: input.equipmentRef,
    equipmentClass: input.equipmentClass,
    kind: "energy",
    quantity: batch.sum,
    unit: batch.unit,
    from: batch.from,
    to: batch.to,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    basis: "measured",
    sampleCount: batch.count,
  });

  assertNoMonetaryFields(report);
  return report;
}

export interface BuildRuntimeReportInput {
  transitions: readonly StateTransition[];
  ownerRef: string;
  equipmentRef: string;
  equipmentClass: string;
  correlationId?: string;
  reportId: string;
  /** The end of the window, for a machine still running when it closed. */
  until: string;
}

/**
 * Totals how long equipment was actively working.
 *
 * `basis: "inferred"` — always. This is derived from power draw crossing a
 * threshold, not from the machine reporting its own state, and CostIQ has to
 * know that. A per-job energy cost built on inferred runtime is an estimate
 * dressed as an actual unless the basis travels with it.
 *
 * A machine still active when the window closed counts up to `until` rather
 * than being dropped, because dropping it systematically undercounts the
 * longest jobs — exactly the ones costing most.
 */
export function buildRuntimeReport(input: BuildRuntimeReportInput): ResourceUseReport | null {
  const sorted = [...input.transitions].sort((a, b) => a.at.localeCompare(b.at));

  let activeSince: string | undefined;
  let totalMs = 0;
  let spans = 0;

  for (const transition of sorted) {
    if (transition.to === "active") {
      activeSince = transition.at;
      continue;
    }
    if (activeSince) {
      totalMs += Date.parse(transition.at) - Date.parse(activeSince);
      spans += 1;
      activeSince = undefined;
    }
  }

  if (activeSince) {
    totalMs += Date.parse(input.until) - Date.parse(activeSince);
    spans += 1;
  }

  if (spans === 0) return null;

  const report = resourceUseReportSchema.parse({
    reportId: input.reportId,
    ownerRef: input.ownerRef,
    equipmentRef: input.equipmentRef,
    equipmentClass: input.equipmentClass,
    kind: "runtime",
    quantity: Math.round(totalMs / 60_000),
    unit: "minutes",
    from: sorted[0]!.at,
    to: input.until,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    basis: "inferred",
    sampleCount: spans,
  });

  assertNoMonetaryFields(report);
  return report;
}

/**
 * The event SenseIQ publishes for CostIQ to consume.
 *
 * Named as a fact that happened, per the platform convention. CostIQ subscribes;
 * SenseIQ never learns it did — which is what keeps the two separable and stops
 * either becoming a dependency of the other.
 */
export const RESOURCE_USE_OBSERVED = "resource.use.observed";
