// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { senseDeviceSchema, type Confidence, type SenseDevice } from "./models.js";
import { spacePath, type PhysicalSpace } from "./space.js";

// ─────────────────────────────────────────────────────────────────────────────
// Working out what a thing is, and being honest about the guess.
//
// This is the machinery behind "I think this energy monitor belongs to the UV
// printer." Everything here produces a SUGGESTION with its reasoning attached,
// and nothing here changes a device — a suggestion becomes a fact only when a
// person accepts it.
//
// The temptation is to auto-apply anything above some threshold. That is how a
// shop map ends up authoritative and wrong in two places, and how somebody
// stops trusting the whole feature after one confident mistake. Confirmation is
// cheap; recovering credibility is not.
//
// Deterministic on purpose. Every rule states its evidence, so a wrong
// suggestion can be traced to the rule that made it rather than to a model
// nobody can interrogate. AI may later propose additional candidates through
// the same shape — as suggestions, with provenance, subject to the same
// confirmation.
// ─────────────────────────────────────────────────────────────────────────────

export const identitySuggestionSchema = z
  .object({
    deviceId: z.string().min(1),
    /** What SenseIQ thinks it is. */
    identifiedAs: z.string().min(1),
    confidence: z.object({ score: z.number().min(0).max(1), basis: z.array(z.string()).min(1) }).strict(),
    /** Where it thinks the device belongs, when it has an opinion. */
    suggestedSpaceId: z.string().min(1).optional(),
    /** The rule that produced this, so a bad suggestion is traceable. */
    rule: z.string().min(1),
  })
  .strict();
export type IdentitySuggestion = z.infer<typeof identitySuggestionSchema>;

/** A thing already in the world that a device might belong to. */
export interface KnownEquipment {
  readonly equipmentId: string;
  /** How a person refers to it: "UV Printer 2". */
  readonly name: string;
  readonly spaceId: string;
  /** Words that would appear in a device name near it. */
  readonly aliases?: readonly string[];
}

export interface IdentifyInput {
  device: SenseDevice;
  equipment: readonly KnownEquipment[];
  spaces: readonly PhysicalSpace[];
  /** Devices already placed, used to infer a room from neighbours. */
  placed?: readonly SenseDevice[];
}

/** Normalises for comparison without pretending it is clever. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/**
 * Suggests what a device is and where it belongs.
 *
 * Returns every plausible candidate rather than one answer. A person choosing
 * between three named machines is doing something easy; being told the wrong
 * one confidently is how they learn to distrust the list.
 */
export function suggestIdentity(input: IdentifyInput): IdentitySuggestion[] {
  const { device } = input;
  const suggestions: IdentitySuggestion[] = [];

  const haystack = tokens(
    [device.identity.identifiedAs, device.identity.model, device.identity.manufacturer, device.providerRef]
      .filter(Boolean)
      .join(" "),
  );

  // Rule 1 — the device's own name mentions a machine somebody has named.
  for (const equipment of input.equipment) {
    const needles = [equipment.name, ...(equipment.aliases ?? [])].flatMap(tokens);
    const overlap = needles.filter((needle) => haystack.includes(needle));
    if (overlap.length === 0) continue;

    // Scaled by how much of the equipment's name matched, and capped below
    // certainty. A name match is strong evidence and never proof — two plugs
    // labelled "printer" are exactly the case this must not resolve alone.
    const score = Math.min(0.85, 0.4 + 0.15 * overlap.length);
    suggestions.push(
      identitySuggestionSchema.parse({
        deviceId: device.deviceId,
        identifiedAs: `${equipment.name} monitor`,
        confidence: {
          score,
          basis: [`the device name mentions ${overlap.join(", ")}`, `${equipment.name} is known equipment`],
        },
        suggestedSpaceId: equipment.spaceId,
        rule: "name-matches-known-equipment",
      }),
    );
  }

  // Rule 2 — one piece of equipment sits alone in a space, and this device
  // measures power. Weaker, and stated as such.
  if (device.capabilities.some((capability) => capability.startsWith("power.") || capability.startsWith("energy."))) {
    const bySpace = new Map<string, KnownEquipment[]>();
    for (const equipment of input.equipment) {
      bySpace.set(equipment.spaceId, [...(bySpace.get(equipment.spaceId) ?? []), equipment]);
    }

    for (const [spaceId, equipment] of bySpace) {
      if (equipment.length !== 1) continue;
      const only = equipment[0]!;
      if (suggestions.some((suggestion) => suggestion.suggestedSpaceId === spaceId)) continue;

      suggestions.push(
        identitySuggestionSchema.parse({
          deviceId: device.deviceId,
          identifiedAs: `${only.name} energy monitor`,
          confidence: {
            score: 0.35,
            basis: [
              "this device measures power or energy",
              `${only.name} is the only equipment in ${spacePath(spaceId, input.spaces) || spaceId}`,
            ],
          },
          suggestedSpaceId: spaceId,
          rule: "sole-equipment-in-space",
        }),
      );
    }
  }

  // Best first, and ties broken by rule name so the order is reproducible
  // rather than dependent on however the equipment list happened to be sorted.
  return suggestions.sort(
    (a, b) => b.confidence.score - a.confidence.score || a.rule.localeCompare(b.rule),
  );
}

export type ConfirmationRefusal = "no_such_suggestion" | "already_confirmed";

export interface ConfirmationResult {
  readonly ok: boolean;
  readonly device?: SenseDevice;
  readonly refusal?: ConfirmationRefusal;
  readonly reason?: string;
}

/**
 * Accepts a suggestion on a person's behalf.
 *
 * The only path from guess to fact. Records who confirmed it, because
 * "confirmed" with no name is indistinguishable from a system that confirmed
 * itself — which is precisely what this design refuses to allow.
 */
export function confirmIdentity(
  device: SenseDevice,
  suggestion: IdentitySuggestion,
  confirmedBy: string,
  now: number,
): ConfirmationResult {
  if (suggestion.deviceId !== device.deviceId) {
    return {
      ok: false,
      refusal: "no_such_suggestion",
      reason: "That suggestion is for a different device.",
    };
  }

  if (device.identity.confirmedBy) {
    // Re-confirming is not an error to hide, but it is not a silent overwrite
    // either: somebody already decided, and changing it should be a deliberate
    // correction rather than a second click.
    return {
      ok: false,
      refusal: "already_confirmed",
      reason: `Already confirmed as "${device.identity.identifiedAs}" by ${device.identity.confirmedBy}. Correct it explicitly rather than confirming again.`,
    };
  }

  return {
    ok: true,
    device: senseDeviceSchema.parse({
      ...device,
      identity: {
        ...device.identity,
        identifiedAs: suggestion.identifiedAs,
        confidence: suggestion.confidence,
        confirmedBy,
        confirmedAt: new Date(now).toISOString(),
      },
      // Location follows the confirmation only if the device does not already
      // have one. Somebody who placed it by hand outranks a suggestion.
      spaceId: device.spaceId ?? suggestion.suggestedSpaceId,
      updatedAt: new Date(now).toISOString(),
    }),
  };
}

/**
 * Records a correction: what SenseIQ guessed was wrong, and this is right.
 *
 * Separate from confirmation because the two mean different things to whatever
 * learns from them later. A correction is the more valuable record — it is the
 * case where somebody who knew better said so.
 */
export function correctIdentity(
  device: SenseDevice,
  identifiedAs: string,
  correctedBy: string,
  now: number,
  spaceId?: string,
): SenseDevice {
  return senseDeviceSchema.parse({
    ...device,
    identity: {
      ...device.identity,
      identifiedAs,
      confidence: {
        score: 1,
        basis: [`corrected by ${correctedBy}`],
      } satisfies Confidence,
      confirmedBy: correctedBy,
      confirmedAt: new Date(now).toISOString(),
    },
    // A correction DOES override placement — that is what makes it a
    // correction rather than a confirmation.
    spaceId: spaceId ?? device.spaceId,
    updatedAt: new Date(now).toISOString(),
  });
}

/**
 * Assigns a device to a space without touching its identity.
 *
 * Two separate things a person may know independently: what a device is, and
 * where it lives. Somebody may know the room and not the machine.
 */
export function assignSpace(device: SenseDevice, spaceId: string, now: number): SenseDevice {
  return senseDeviceSchema.parse({
    ...device,
    spaceId,
    // The inferred placement confidence is dropped: this is no longer a guess,
    // and leaving a score beside a human decision would misrepresent it.
    spaceConfidence: undefined,
    updatedAt: new Date(now).toISOString(),
  });
}
