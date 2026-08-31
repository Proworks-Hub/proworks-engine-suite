// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { SecurityObservation } from "./observation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sensor provider ports — directive §12/§14 (DEC-028).
//
// Sentinel does not reimplement the security industry (§8). Mature sensors
// exist; Sentinel consumes their evidence through provider-neutral ports and
// normalizes at the adapter. Directive §14 is explicit: do NOT begin by
// writing a custom kernel driver — create the port first.
//
// WHAT A PORT IS HERE: a declaration. No implementation ships in this kernel,
// and no port carries a vendor name. A provider that cannot answer says so
// (`unavailable` with a reason) — an unbound sensor is a NAMED blind spot,
// never an empty result that reads as "nothing happened". That distinction is
// the whole point: silence and safety are different, and only one of them is
// evidence.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderPull =
  | { readonly state: "observations"; readonly observations: readonly SecurityObservation[] }
  | {
      /** The port is bound but could not answer for this window. */
      readonly state: "degraded";
      readonly reason: string;
      readonly partialObservations: readonly SecurityObservation[];
    }
  | {
      /** Nothing is bound. A blind spot with a name, surfaced to coverage. */
      readonly state: "unavailable";
      readonly reason: string;
    };

/** Every provider declares what it can see, so coverage is computable rather
 * than assumed. */
export interface ProviderDescriptor {
  readonly sensorKind: SensorKind;
  readonly providerRef: string;
  /** Observation types this provider can produce — the coverage claim. */
  readonly declaredObservationTypes: readonly string[];
  /** Whether the provider attests its own integrity (§10 sourceAttested). */
  readonly selfAttesting: boolean;
}

export interface SecuritySensorProvider {
  readonly descriptor: ProviderDescriptor;
  /** Pull normalized observations for an explicit window. No clock reads. */
  pull(windowStart: string, windowEnd: string): ProviderPull;
}

/** The port taxonomy (§12). Names describe the OBSERVATION DOMAIN, never a
 * product; a vendor becomes a `providerRef`, which is data. */
export const SENSOR_KINDS = [
  "endpoint",
  "runtime",
  "network",
  "cloud-security",
  "identity-security",
  "application-security",
  "artifact-security",
  "ai-activity",
  "host-siem",
  "host-edr",
  "hive-native",
] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];

/**
 * The registry of bound providers, and — more importantly — of the ones that
 * are NOT bound. Coverage is a set difference expressed as named gaps, never
 * a percentage over an unknown denominator (the same rule FinancialRiskIQ's
 * coverage manifest enforces, for the same reason).
 */
export interface SensorCoverage {
  readonly boundKinds: readonly SensorKind[];
  readonly unboundKinds: readonly SensorKind[];
  /** Observation types no bound provider claims — the detection blind spots,
   * named. */
  readonly unclaimedObservationTypes: readonly string[];
  /** Deliberately absent: any single "coverage %" figure. */
  readonly coverageStatement: string;
}

export function computeSensorCoverage(
  providers: readonly SecuritySensorProvider[],
  observationTypesOfInterest: readonly string[],
): SensorCoverage {
  const bound = new Set(providers.map((p) => p.descriptor.sensorKind));
  const claimed = new Set(providers.flatMap((p) => p.descriptor.declaredObservationTypes));
  const unbound = SENSOR_KINDS.filter((k) => !bound.has(k));
  const unclaimed = observationTypesOfInterest.filter((t) => !claimed.has(t));
  return {
    boundKinds: [...bound].sort(),
    unboundKinds: unbound,
    unclaimedObservationTypes: unclaimed,
    coverageStatement:
      unbound.length === 0 && unclaimed.length === 0
        ? "all sensor kinds bound; every observation type of interest claimed"
        : `unbound sensor kinds: ${unbound.join(", ") || "none"}; unclaimed observation types: ${unclaimed.join(", ") || "none"}`,
  };
}

/**
 * Collecting across providers. An unavailable provider contributes a NAMED
 * gap, never an absence that reads as calm: the result carries both what was
 * seen and what could not be looked at, exactly like the coverage manifests
 * elsewhere in this suite.
 */
export interface CollectionResult {
  readonly observations: readonly SecurityObservation[];
  readonly gaps: readonly { providerRef: string; sensorKind: SensorKind; reason: string; degraded: boolean }[];
  /** True only when every provider answered fully. Consumers that need a
   * complete picture (VaR-style aggregate reasoning) must check this. */
  readonly complete: boolean;
}

export function collectObservations(
  providers: readonly SecuritySensorProvider[],
  windowStart: string,
  windowEnd: string,
): CollectionResult {
  const observations: SecurityObservation[] = [];
  const gaps: { providerRef: string; sensorKind: SensorKind; reason: string; degraded: boolean }[] = [];
  for (const provider of providers) {
    const pull = provider.pull(windowStart, windowEnd);
    if (pull.state === "observations") {
      observations.push(...pull.observations);
      continue;
    }
    if (pull.state === "degraded") {
      observations.push(...pull.partialObservations);
      gaps.push({
        providerRef: provider.descriptor.providerRef,
        sensorKind: provider.descriptor.sensorKind,
        reason: pull.reason,
        degraded: true,
      });
      continue;
    }
    gaps.push({
      providerRef: provider.descriptor.providerRef,
      sensorKind: provider.descriptor.sensorKind,
      reason: pull.reason,
      degraded: false,
    });
  }
  return { observations, gaps, complete: gaps.length === 0 };
}
