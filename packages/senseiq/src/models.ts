// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// A device, as SenseIQ understands it.
//
// The rule this file is arranged around: NOTHING PROVIDER-SPECIFIC LEAKS PAST
// THE ADAPTER. A Zigbee cluster id, a Home Assistant entity id, a Shelly
// channel number — all of those are opaque strings SenseIQ stores and never
// interprets. The moment SenseIQ can read one, every consumer eventually reads
// one too, and the engine has quietly become a client of that protocol.
//
// It is also not a manufacturing model. A device is a device; a plug in a
// kitchen and a plug on a UV printer are the same shape here. ProWorks decides
// that `energy.measure` on a particular device means machine operating cost;
// Family Table decides it means the household bill. SenseIQ does not care, and
// the moment it does it stops being portable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a device can do, as `domain.action`.
 *
 * A STRING, not an enum, and the choice is deliberate. A closed enum makes
 * every new device class a package release — and worse, an adapter meeting a
 * capability the enum lacks would invent its own name in a metadata field,
 * which is the same vocabulary drift with none of the visibility.
 *
 * The shape is validated so the namespace stays legible; the membership is not.
 */
export const capabilitySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, "capability must look like power.switch");
export type Capability = z.infer<typeof capabilitySchema>;

/** The ones the ecosystem starts with. Not a limit — a shared starting vocabulary. */
export const CAPABILITIES = {
  power: { switch: "power.switch", measure: "power.measure" },
  energy: { measure: "energy.measure" },
  occupancy: { detect: "occupancy.detect" },
  motion: { detect: "motion.detect" },
  camera: { stream: "camera.stream" },
  environment: {
    temperature: "environment.temperature",
    humidity: "environment.humidity",
    airQuality: "environment.airQuality",
  },
  machine: { state: "machine.state" },
  device: { display: "device.display", health: "device.health" },
} as const;

/**
 * Whether SenseIQ can currently see the device.
 *
 * `unknown` is distinct from `offline` and the distinction is the usual one:
 * an adapter that has not reported is not evidence the device is down. Merging
 * them would make a broken adapter look like a room full of dead hardware.
 */
export const availabilitySchema = z.enum(["online", "offline", "unknown"]);
export type Availability = z.infer<typeof availabilitySchema>;

export const deviceHealthSchema = z
  .object({
    availability: availabilitySchema,
    /** Why, in words. Shown to a person, so it is not a code. */
    detail: z.string().min(1),
    lastSeenAt: z.string().optional(),
    /** Reported by the device or adapter, when it says. Never inferred. */
    batteryPercent: z.number().min(0).max(100).optional(),
    signalPercent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type DeviceHealth = z.infer<typeof deviceHealthSchema>;

/**
 * How sure SenseIQ is about something it worked out rather than was told.
 *
 * Every inferred field carries one. A device SenseIQ *thinks* is the UV printer
 * must be visibly a guess until somebody confirms it, because the alternative
 * is a shop map that looks authoritative and is wrong in two places.
 */
export const confidenceSchema = z
  .object({
    /** 0..1. */
    score: z.number().min(0).max(1),
    /** What led here. Required — a confidence with no basis is a number. */
    basis: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * A device's identity, separated from the device itself.
 *
 * `confirmedBy` is what makes a guess into a fact. Until a person has said so,
 * `identifiedAs` is SenseIQ's opinion and is rendered as one.
 */
export const deviceIdentitySchema = z
  .object({
    /** What SenseIQ believes this is, e.g. "UV flatbed printer energy monitor". */
    identifiedAs: z.string().min(1).optional(),
    confidence: confidenceSchema.optional(),
    /** Who confirmed it. Absent means nobody has. */
    confirmedBy: z.string().min(1).optional(),
    confirmedAt: z.string().optional(),
    manufacturer: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
  .refine((identity) => !identity.confirmedBy || Boolean(identity.identifiedAs), {
    // Confirming nothing is not a confirmation.
    message: "A confirmed identity must say what was confirmed.",
    path: ["identifiedAs"],
  });
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export const senseDeviceSchema = z
  .object({
    /** Stable for the life of the device, assigned by SenseIQ, never by a provider. */
    deviceId: z.string().min(1),
    /** Which adapter surfaced it. */
    adapterId: z.string().min(1),
    /**
     * The provider's own handle for it. OPAQUE.
     *
     * SenseIQ stores this and passes it back to the adapter that issued it. It
     * never parses it, and no consumer should — the day something reads a
     * Zigbee address out of here is the day SenseIQ is coupled to Zigbee.
     */
    providerRef: z.string().min(1),
    capabilities: z.array(capabilitySchema).min(1),
    identity: deviceIdentitySchema.default({}),
    health: deviceHealthSchema,
    /** Where it is, if placed. A device may be discovered before it is located. */
    spaceId: z.string().min(1).optional(),
    /** Placement SenseIQ inferred rather than was told. */
    spaceConfidence: confidenceSchema.optional(),
    /** Free-form, adapter-supplied. Not read by the engine. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    discoveredAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SenseDevice = z.infer<typeof senseDeviceSchema>;

/** True when a person has confirmed what this device is. */
export function isIdentityConfirmed(device: SenseDevice): boolean {
  return Boolean(device.identity.confirmedBy);
}

/**
 * Whether a device is claimed to do something.
 *
 * A helper rather than a bare `includes` because callers should not be reaching
 * into the array — and because "claimed" is the honest word: a capability is
 * what an adapter reported, not something SenseIQ has verified.
 */
export function hasCapability(device: SenseDevice, capability: Capability): boolean {
  return device.capabilities.includes(capability);
}

/**
 * Merges a fresh discovery into a device already known.
 *
 * Adapters re-report on every scan, and the naive merge overwrites. Two things
 * are protected here:
 *
 *   A CONFIRMED IDENTITY SURVIVES. A person said what this is; a later scan
 *   guessing differently does not get to overrule them silently.
 *
 *   A PLACEMENT SURVIVES. Somebody put this device in a room. Rediscovery must
 *   not empty that field, which is how a shop map quietly loses its layout.
 */
export function mergeDiscovered(existing: SenseDevice, incoming: SenseDevice): SenseDevice {
  return senseDeviceSchema.parse({
    ...incoming,
    deviceId: existing.deviceId,
    discoveredAt: existing.discoveredAt,
    identity: isIdentityConfirmed(existing)
      ? existing.identity
      : { ...existing.identity, ...incoming.identity },
    spaceId: existing.spaceId ?? incoming.spaceId,
    ...(existing.spaceConfidence ? { spaceConfidence: existing.spaceConfidence } : {}),
    metadata: { ...existing.metadata, ...incoming.metadata },
  });
}
