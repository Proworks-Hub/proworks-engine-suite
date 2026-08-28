// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { assertNoIdentityFields, type Canonical } from "@proworks-hub/contracts";

import type { Capability } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// What SenseIQ saw, and the line it must not carry across.
//
// Two kinds of observation, and the difference is the whole point:
//
//   LOCAL — "UV Printer 2 used 1.84 kWh during work order 3819 at this shop."
//   Belongs to the customer. Detailed, identifying, and theirs.
//
//   GENERALIZED — "UV flatbed printers of class X typically use about Y kWh
//   for workload Z." Belongs to nobody, and is what makes a new installation
//   useful on its first day.
//
// The boundary between them is a TYPE, not a convention. A generalized
// observation is `Canonical<T>`, which makes `ownerRef` impossible to set —
// the mistake fails to compile rather than failing in a shared database
// eighteen months from now when somebody notices a customer name in it.
//
// And removing a name is not anonymisation. `generalize()` is a deliberate,
// lossy translation that DROPS the device, the space, the correlation and the
// exact time, then refuses the result if anything identifying survived. The
// runtime check exists because the type only protects the fields it knows about.
// ─────────────────────────────────────────────────────────────────────────────

export const observationKindSchema = z.enum([
  "power",
  "energy",
  "environment",
  "occupancy",
  "machineState",
  "deviceHealth",
]);
export type ObservationKind = z.infer<typeof observationKindSchema>;

export const localObservationSchema = z
  .object({
    observationId: z.string().min(1),
    kind: observationKindSchema,
    /** Which capability produced it. */
    capability: z.string().min(1),
    deviceId: z.string().min(1),
    spaceId: z.string().min(1).optional(),
    /** Opaque owner reference, exactly as the rest of the suite uses it. */
    ownerRef: z.string().min(1),
    observedAt: z.string().min(1),
    /** The reading. Unit is carried, never assumed. */
    value: z.number(),
    unit: z.string().min(1),
    /** For a reading over a period rather than an instant. */
    durationMs: z.number().nonnegative().optional(),
    /** Ties an observation to the work that caused it. */
    correlationId: z.string().min(1).optional(),
  })
  .strict();
export type LocalObservation = z.infer<typeof localObservationSchema>;

/**
 * What may leave the customer's boundary.
 *
 * `Canonical<T>` forbids `ownerRef`, `organizationId`, `shopId`, `userId` and
 * `tenantId` at compile time. Note what is also absent by construction: no
 * device id, no space id, no correlation id, no timestamp finer than a period.
 * Each of those is individually harmless and jointly re-identifying.
 */
export type GeneralizedObservation = Canonical<{
  readonly kind: ObservationKind;
  readonly capability: Capability;
  /** The class of thing, never the thing. "uv-flatbed-printer". */
  readonly equipmentClass: string;
  /** The class of work, never the job. "full-bed-print". */
  readonly workloadClass?: string;
  readonly value: number;
  readonly unit: string;
  readonly durationMs?: number;
  /** How many local observations stand behind it. */
  readonly sampleSize: number;
  /** Coarse — a month, not a moment. */
  readonly period: string;
}>;

export interface GeneralizeInput {
  observations: readonly LocalObservation[];
  equipmentClass: string;
  workloadClass?: string;
  /** e.g. "2026-08". Deliberately coarse. */
  period: string;
  /** Below this, no generalization happens at all. */
  minimumSamples?: number;
}

/**
 * Minimum observations before anything may generalize.
 *
 * One shop's one reading is that shop's reading, however anonymous it looks —
 * a single value from a single site is re-identifiable by anybody who knows
 * what that site owns.
 */
export const MIN_GENERALIZATION_SAMPLES = 5;

/**
 * Minimum distinct owners contributing.
 *
 * Separate from sample count and load-bearing: a hundred readings from one shop
 * is still one shop's data. This is the check that makes the output about a
 * class of equipment rather than about a customer.
 */
export const MIN_GENERALIZATION_OWNERS = 3;

export type GeneralizeRefusal =
  | { ok: false; reason: string };

export type GeneralizeResult =
  | { ok: true; observation: GeneralizedObservation }
  | GeneralizeRefusal;

/**
 * Turns local readings into something shareable, or refuses.
 *
 * Refuses far more readily than it produces. Everything about this direction is
 * asymmetric: a wrong refusal costs a little knowledge, and a wrong
 * generalization puts customer data somewhere it can never be recalled from.
 */
export function generalize(input: GeneralizeInput): GeneralizeResult {
  const minimum = input.minimumSamples ?? MIN_GENERALIZATION_SAMPLES;

  if (input.observations.length < minimum) {
    return {
      ok: false,
      reason: `${input.observations.length} observation(s); ${minimum} are needed before anything may be generalized.`,
    };
  }

  const owners = new Set(input.observations.map((observation) => observation.ownerRef));
  if (owners.size < MIN_GENERALIZATION_OWNERS) {
    return {
      ok: false,
      reason: `Observations come from ${owners.size} owner(s); ${MIN_GENERALIZATION_OWNERS} are needed. A hundred readings from one shop is still one shop's data.`,
    };
  }

  const kinds = new Set(input.observations.map((observation) => observation.kind));
  const units = new Set(input.observations.map((observation) => observation.unit));
  if (kinds.size !== 1 || units.size !== 1) {
    // Averaging watts with degrees produces a number that means nothing and
    // looks like knowledge.
    return { ok: false, reason: "Observations must share one kind and one unit to be combined." };
  }

  const capabilities = new Set(input.observations.map((observation) => observation.capability));
  if (capabilities.size !== 1) {
    return { ok: false, reason: "Observations must come from one capability." };
  }

  const total = input.observations.reduce((sum, observation) => sum + observation.value, 0);

  const observation = {
    ownership: "canonical",
    kind: [...kinds][0]!,
    capability: [...capabilities][0]! as Capability,
    equipmentClass: input.equipmentClass,
    ...(input.workloadClass ? { workloadClass: input.workloadClass } : {}),
    value: total / input.observations.length,
    unit: [...units][0]!,
    sampleSize: input.observations.length,
    period: input.period,
  } as GeneralizedObservation;

  try {
    // The type has already forbidden the fields it knows about. This catches
    // what it cannot: an identifying value smuggled into `equipmentClass` or
    // `workloadClass` by a caller building those strings from local data.
    assertNoIdentityFields(observation, "generalizedObservation");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, observation };
}

/**
 * Sums energy for one device over a period.
 *
 * Stays local by construction — it returns a `LocalObservation`, so there is no
 * path from here to a shared store that does not pass through `generalize`.
 */
export function totalEnergy(
  observations: readonly LocalObservation[],
  deviceId: string,
): LocalObservation | null {
  const forDevice = observations.filter(
    (observation) => observation.deviceId === deviceId && observation.kind === "energy",
  );
  if (forDevice.length === 0) return null;

  const first = forDevice[0]!;
  return localObservationSchema.parse({
    ...first,
    observationId: `${deviceId}:energy:total`,
    value: forDevice.reduce((sum, observation) => sum + observation.value, 0),
    durationMs: forDevice.reduce((sum, observation) => sum + (observation.durationMs ?? 0), 0),
  });
}
