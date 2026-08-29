// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { authorityCrossesTo, isTrustedProduction, type Environment, type Sandbox } from "./environment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Controlled fault injection.
//
// Directive §5 lists the fault classes and adds: "Do not hard-code tests to one
// infrastructure product. Fault injection should occur through abstractions
// where possible."
//
// So a fault is a DESCRIPTION of what should go wrong, and an injector is a
// host-supplied thing that knows how to make it go wrong here. Nothing in this
// file knows what a queue or a database is.
//
// THE CORPUS AND THE DIRECTIVE USE DIFFERENT VOCABULARIES
//
// The directive's §5 list is infrastructure-shaped (DEPENDENCY_TIMEOUT,
// QUEUE_BACKLOG, DATABASE_FAILURE). The corpus's `faultClass` values are
// constitution-shaped (SOURCE_OF_TRUTH_THEFT, ORCHESTRATOR_OWNERSHIP_VIOLATION,
// AUTHORITY_BYPASS). Both are real and neither is wrong — they describe the
// same failures at different altitudes.
//
// I kept both rather than forcing one into the other. `InjectableFault` carries
// the directive's mechanical class, `faultClass` on the scenario carries the
// corpus's constitutional class, and `CORPUS_TO_MECHANICAL` maps the ones that
// genuinely correspond. Where no mechanical equivalent exists — a scenario about
// an engine claiming another's source of truth is not a timeout — the map says
// so instead of inventing one.
// ─────────────────────────────────────────────────────────────────────────────

/** Directive §5's fault classes: what mechanically goes wrong. */
export const mechanicalFaultSchema = z.enum([
  "ENGINE_UNAVAILABLE",
  "DEPENDENCY_TIMEOUT",
  "DEPENDENCY_ERROR",
  "DUPLICATE_EVENT",
  "MISSING_EVENT",
  "OUT_OF_ORDER_EVENT",
  "MALFORMED_PAYLOAD",
  "SCHEMA_MISMATCH",
  "INVALID_AUTHORITY",
  "EXPIRED_AUTHORITY",
  "TENANT_MISMATCH",
  "STATE_CORRUPTION",
  "STALE_STATE",
  "CONFIGURATION_DRIFT",
  "CONTRACT_INCOMPATIBILITY",
  "DATABASE_FAILURE",
  "QUEUE_BACKLOG",
  "EXTERNAL_PROVIDER_FAILURE",
  "AI_PROVIDER_FAILURE",
  "SECRET_REVOKED",
  "PARTIAL_WORKFLOW_FAILURE",
  "NEXUS_FAILURE",
  "PULSE_FAILURE",
  "SENTINEL_ISOLATION",
  "BAD_DEPLOYMENT",
]);
export type MechanicalFault = z.infer<typeof mechanicalFaultSchema>;

/**
 * Corpus fault classes that have a mechanical equivalent.
 *
 * Deliberately incomplete. A corpus class absent from this map has no
 * mechanical analogue — SOURCE_OF_TRUTH_THEFT is not a timeout, and pretending
 * it is would make the injector lie about what it did.
 */
export const CORPUS_TO_MECHANICAL: Readonly<Record<string, MechanicalFault>> = Object.freeze({
  DUPLICATE_DELIVERY: "DUPLICATE_EVENT",
  DEPENDENCY_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  TENANT_BOUNDARY_VIOLATION: "TENANT_MISMATCH",
  AUTHORITY_BYPASS: "INVALID_AUTHORITY",
  REVISION_DRIFT: "CONTRACT_INCOMPATIBILITY",
  CONSTITUTIONAL_DRIFT: "CONFIGURATION_DRIFT",
  MULTI_ENGINE_PARTIAL_FAILURE: "PARTIAL_WORKFLOW_FAILURE",
  INVENTORY_STATE_VARIANCE: "STATE_CORRUPTION",
  TRACE_CONTEXT_LOSS: "MISSING_EVENT",
  MACHINE_FAILURE: "EXTERNAL_PROVIDER_FAILURE",
  INGEST_NORMALIZATION: "MALFORMED_PAYLOAD",
});

/** The mechanical fault for a corpus class, or null when there is honestly none. */
export function mechanicalFaultFor(corpusFaultClass: string): MechanicalFault | null {
  return CORPUS_TO_MECHANICAL[corpusFaultClass] ?? null;
}

export const injectableFaultSchema = z
  .object({
    fault: mechanicalFaultSchema,
    /** Which component the fault happens TO. */
    targetComponentId: z.string().min(1),
    /** Free-form knobs the host injector understands. Never interpreted here. */
    parameters: z.record(z.string(), z.unknown()).default({}),
    /** What the scenario author expected this to cause. Intent, not evidence. */
    intent: z.string().min(1),
  })
  .strict();
export type InjectableFault = z.infer<typeof injectableFaultSchema>;

export interface InjectionRecord {
  readonly fault: InjectableFault;
  readonly injectedAt: string;
  /** Whether the host actually managed to inject it. */
  readonly effective: boolean;
  /**
   * Why it was not injected, when it was not.
   *
   * A scenario whose fault never landed is not a passing scenario — it is an
   * untested one, and the difference has to survive into the run record.
   */
  readonly ineffectiveBecause?: string;
}

/**
 * A host's ability to actually break something.
 *
 * The abstraction §5 asks for. A host that cannot inject a given fault says so
 * rather than silently doing nothing, because a scenario that quietly ran
 * without its fault reports success for the wrong reason.
 */
export interface FaultInjector {
  readonly supports: readonly MechanicalFault[];
  inject(fault: InjectableFault, sandbox: Sandbox): Promise<InjectionRecord>;
  /** Undo, so the next run starts clean. */
  clear(): Promise<void>;
}

export type InjectionGate =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

/**
 * Whether a fault may be injected here at all.
 *
 * Deliberately paranoid about production. Injecting a fault means deliberately
 * breaking something; §4 says sandbox authority does not reach production, and
 * this is the specific case where getting it wrong causes an outage rather than
 * a failed test.
 */
export function injectionPermitted(input: {
  fault: InjectableFault;
  environment: Environment;
  /** Where the authority to run this was established. */
  authorityEstablishedIn: Environment;
}): InjectionGate {
  if (isTrustedProduction(input.environment)) {
    return {
      permitted: false,
      reason:
        `Refusing to inject ${input.fault.fault} into trusted production. Fault injection is deliberate breakage, ` +
        "and repair learning does not get to cause the incidents it studies.",
    };
  }

  const crossing = authorityCrossesTo(input.authorityEstablishedIn, input.environment);
  if (!crossing.crosses) {
    return { permitted: false, reason: crossing.reason };
  }

  return { permitted: true };
}
