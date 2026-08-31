// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createParticipantRuntime,
  type MaturityLevel,
  type ParticipantRuntime,
  type RuntimeState,
} from "@proworks-hub/hive-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Migrating an existing engine onto the Common Runtime Standard.
//
// ADAPTER, NOT REWRITE, and that is the manifesto's own preference (§19,
// "prefer adapters when safer"; the build directive's "do not rewrite
// compliant behavior merely to match folder aesthetics").
//
// The discovery that shaped this file: CostIQ already declared everything the
// standard asks a charter for — classification, what it owns, what it
// deliberately does not own and who owns that instead — in its own
// `charter.ts`, written long before V5 existed. It has an `arrivesAs` field
// recording the plausible request that would drag each excluded
// responsibility in, which is richer than anything the standard requires.
//
// So the correct migration adds no metadata to CostIQ. It TRANSLATES what is
// already there. Rewriting CostIQ's charter into the standard's shape would
// have destroyed a better artifact to satisfy a newer one, and would have
// touched a real engine to achieve nothing a translation could not.
//
// This adapter takes a charter-shaped value and returns a declaration. It does
// not import any engine: the evaluator depending on its subjects would invert
// the relationship the whole package exists to keep one-directional.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape an engine charter must have to be adapted. Structural, not nominal. */
export interface AdaptableCharter {
  readonly classification: string;
  readonly owns: readonly { readonly id: string; readonly summary: string }[];
  readonly doesNotOwn: readonly {
    readonly id: string;
    readonly summary: string;
    readonly ownedBy: string;
  }[];
}

export interface AdaptationInput {
  readonly charter: AdaptableCharter;
  readonly stableId: string;
  readonly instanceId: string;
  readonly version: string;
  readonly environment: "development" | "test" | "staging" | "production";
  readonly mission: string;
  readonly owner: string;
  /**
   * Declared, never inferred.
   *
   * There is no honest way to derive maturity from a charter: a charter says
   * what a component is FOR, and maturity says what it has PROVEN. Guessing
   * would produce exactly the false confidence the M-levels exist to prevent,
   * and it would do so at scale, silently, for every engine adapted.
   */
  readonly maturity: MaturityLevel;
  readonly runtimeState: RuntimeState;
  readonly evidenceRefs?: readonly string[];
}

/**
 * Translates an existing engine charter into a Common Runtime declaration.
 *
 * The collaboration contract comes back EMPTY. That is deliberate and is the
 * honest result: a charter records responsibility, not capability surface, and
 * inventing capability declarations from responsibility statements would
 * fabricate an interface nobody wrote. Capabilities are declared by the engine
 * when it declares them — the same rule that keeps `eventMappings` empty until
 * an emitter exists, and for the same reason.
 *
 * An adapted engine therefore passes the charter and identity rules and is
 * visibly silent on capabilities, which is true.
 */
export function adaptCharterToRuntime(input: AdaptationInput): ParticipantRuntime {
  return createParticipantRuntime({
    identity: {
      stableId: input.stableId,
      instanceId: input.instanceId,
      version: input.version,
      environment: input.environment,
    },
    charter: {
      mission: input.mission,
      classification: input.charter.classification,
      owner: input.owner,
      owns: input.charter.owns.map((o) => o.summary),
      // The `ownedBy` is carried through rather than dropped. "We do not own
      // pricing" is an abstraction; "we do not own pricing, PricingIQ does" is
      // a routing instruction for the next person who asks CostIQ for a price.
      doesNotOwn: input.charter.doesNotOwn.map((o) => `${o.summary} (owned by ${o.ownedBy})`),
    },
    maturity: input.maturity,
    runtimeState: input.runtimeState,
    evidenceRefs: input.evidenceRefs ?? [],
    collaboration: { offers: [], requires: [], publishes: [], subscribes: [] },
  });
}
