// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { createPrimeEngine, type PrimeConfig, type PrimeEngine } from "./primeEngine.js";
import { createPrimeNexus, type PrimeNexus } from "./nexus/nexus.js";
import { createPrimePulse, type ContinuityStore, type PrimePulse } from "./pulse/pulse.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE PRIME ENGINE — one engine, two chambers.
//
// Nexus commands authorized progression. Pulse preserves authorized continuity.
// Neither is sovereign, and neither is a replica of the other: they do
// different jobs and together they are Prime.
//
// WHY A FACADE AND NOT TWO ENGINES
//
// Two registrations would make them peers, and peers in this architecture
// communicate through events rather than imports — which would put Prime's own
// internal sequencing on a bus and, worse, make "Nexus asks Pulse" an
// asynchronous request. The chambers are internal structure, deliberately.
//
// The Hive map still holds exactly one Prime. A test asserts that, because the
// most likely way this design decays is somebody registering a chamber to make
// it addressable.
//
// WHAT THIS FACADE DOES NOT EXPOSE
//
// No `execute`, no `run`, no store handle, no engine registry. A caller reaches
// a chamber and uses that chamber's narrow contract. An orchestrator with a
// general-purpose escape hatch is one where every boundary above is optional.
// ─────────────────────────────────────────────────────────────────────────────

export interface Prime {
  readonly name: "prime";
  /** The command chamber: what authorized work happens next. */
  readonly nexus: PrimeNexus;
  /**
   * The continuity chamber. Present only when a continuity store was supplied.
   *
   * `null` rather than a stub. A no-op Pulse would report healthy and preserve
   * nothing, which is the exact lie this chamber exists to prevent — a caller
   * must be able to tell "continuity is not configured" from "continuity is
   * working".
   */
  readonly pulse: PrimePulse | null;
  /** The decision surface. Unchanged from the original engine. */
  readonly decide: PrimeEngine["decide"];
}

export interface PrimeOptions extends PrimeConfig {
  /** Supplied by the host. Without one, Prime runs with no continuity chamber. */
  readonly continuity?: ContinuityStore;
  readonly now?: () => Date;
}

export function createPrime(options: PrimeOptions = {}): Prime {
  const { continuity, now, ...decisionConfig } = options;
  const engine = createPrimeEngine(decisionConfig);

  return {
    name: "prime",
    nexus: createPrimeNexus(),
    pulse: continuity
      ? createPrimePulse({ store: continuity, ...(now ? { now } : {}) })
      : null,
    decide: engine.decide,
  };
}

/**
 * Whether either chamber may authorize work.
 *
 * Always false, and a function rather than a comment for the same reason the
 * other twelve are: a guarantee nothing can execute is a guarantee nobody can
 * check. Nexus selects from what was already permitted; Pulse resumes what was
 * already permitted. Neither has a path to permitting anything.
 */
export function chamberCreatesAuthority(): false {
  return false;
}

/**
 * Whether Nexus and Pulse are sovereign engines.
 *
 * Always false. They are chambers of one constitutional engine, and the Hive
 * map holds one Prime.
 */
export function chambersAreSovereignEngines(): false {
  return false;
}
