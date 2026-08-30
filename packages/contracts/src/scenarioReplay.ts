// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ZodType } from "zod";

import type { MethodRef } from "./financePrimitives.js";

// ─────────────────────────────────────────────────────────────────────────────
// The scenario replay seam (ScenarioIQ blueprint E-SC-2). These types live in
// contracts because BOTH the engine that supplies a recomputation function and
// the engine that composes over it must agree on the shape; declaring them
// locally in either would fork a contract. Additive change authorized by
// DEC-025.
//
// Readers: ScenarioIQ's overlay applicator, replay probe and breakpoint
// resolution guard; any host wrapping an engine method for what-if replay.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed for a declared-stochastic method. Present ONLY when the method's
 * attestation says `seedRequired`; a deterministic method never sees one. */
export type Seed = string;

/**
 * The smallest output difference the method can meaningfully distinguish,
 * REQUIRED on every replayable method. Read by ScenarioIQ's breakpoint
 * bisection (§16.9 r5): a search driven below this resolution converges onto
 * numeric noise and reports a confident, meaningless threshold. A defaulted
 * resolution would make that honesty impossible, so there is no default.
 */
export interface OutputResolution {
  /** Minimum meaningful delta, in minor units of the method's monetary output
   * (or in the output's own units for non-monetary outputs). */
  readonly minimumMeaningfulDeltaMinor: bigint;
  /** Where the resolution comes from — e.g. "per-line half-even rounding at 2dp". */
  readonly basis: string;
}

/** What the method's supplier claims about its determinism. A claim, not a
 * proof: ScenarioIQ's replay probe checks the cheap common failures and every
 * run record says `determinismBasis: "probe-2-runs"` so nobody mistakes the
 * probe for a proof. */
export interface DeterminismAttestation {
  /** True when the same input and env always produce the same output. */
  readonly deterministic: boolean;
  /** True when the method draws from a supplied seed (declared-stochastic).
   * Read by the probe's third run, which asserts a DIFFERENT seed changes the
   * output — an attestation that cannot be wrong is a false validator. */
  readonly seedRequired: boolean;
  /** Who attests — an engine id or a human identity, never empty. */
  readonly attestedBy: string;
}

/** The ENTIRE environment a replayable method may see: an explicit instant and
 * (only for declared-stochastic methods) a seed. No bus, no store, no logger,
 * no clock, no random — a method that wants a side effect has nowhere to put
 * it. Containment is structural, not proven. */
export interface MethodEnv {
  /** Explicit. Never a clock read. */
  readonly asOf: string;
  readonly seed?: Seed;
}

/**
 * A deterministic recomputation function injected by a HOST so that ScenarioIQ
 * can re-run another engine's calculation without importing it (LOCK-5). The
 * signature is synchronous by specification, not oversight: an async signature
 * is an invitation to I/O, and a method that needs to await something is a
 * method whose inputs were not captured.
 */
export interface ReplayableMethod<I, O> {
  readonly domain: "finance";
  readonly methodRef: MethodRef;
  /** The overlayable surface; overlay op paths validate against it. */
  readonly inputSchema: ZodType<I>;
  readonly outputSchema: ZodType<O>;
  readonly outputResolution: OutputResolution;
  readonly determinism: DeterminismAttestation;
  run(input: Readonly<I>, env: MethodEnv): O;
}

/** Host-bound catalog of replayable methods. Resolution is EXACT on
 * {methodId, semanticVersion}: falling back to the nearest version silently
 * changes what a scenario means, so no such path exists. */
export interface MethodCatalogPort {
  resolve(ref: MethodRef): ReplayableMethod<unknown, unknown> | undefined;
  list(): readonly MethodRef[];
}
