// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createParticipantRuntime,
  resolveCapability,
  type ParticipantRuntime,
} from "@proworks-hub/hive-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// The Golden Reference Engine.
//
// The function it performs is deliberately trivial: normalize a string. The
// ARCHITECTURE is the artifact. Anything with a real domain would let a reader
// argue about the domain instead of the shape, and the shape is the whole
// point — this is what "conformant" looks like, in code somebody can run.
//
// IT DOES NOT DEPEND ON THE CONFORMANCE CHAMBER. Deliberately, and there is a
// test for it. If the reference engine needed the evaluator in order to work,
// then the Architecture Engine would be a runtime parent, its outage would be
// everyone's outage, and an assurance system would have quietly become
// infrastructure. Conformance is judged from outside or it is not assurance.
// ─────────────────────────────────────────────────────────────────────────────

export const GOLDEN_REFERENCE_ID = "hive.architecture.golden-reference";

/** The declaration. Every field is real; none is placeholder. */
export const goldenReferenceRuntime: ParticipantRuntime = createParticipantRuntime({
  identity: {
    stableId: GOLDEN_REFERENCE_ID,
    instanceId: "instance.reference",
    version: "1.0.0",
    environment: "development",
  },
  charter: {
    mission: "Demonstrate a fully conformant Hive participant in executable form.",
    classification: "SHARED_PLATFORM",
    owner: "Architecture Engine",
    owns: ["the reference implementation of the Common Hive Runtime Standard"],
    doesNotOwn: [
      "any domain state",
      "any authority over another participant",
      "the conformance verdict on itself",
    ],
    charterRef: "docs/architecture/ARCHITECTURE-ENGINE-CHARTER.md",
  },
  // Honest: it is proven through a real governed path in its own tests, and it
  // is not carrying production load. Claiming CERTIFIED would be the exact
  // failure ARCH-MATURITY-HONEST exists to catch.
  maturity: "INTEGRATED",
  runtimeState: "READY",
  evidenceRefs: ["test:packages/architecture-engine/src/__tests__/goldenReference.test.ts"],
  collaboration: {
    offers: [
      {
        capabilityId: "reference.normalize",
        version: "1.0.0",
        purpose: "Normalize whitespace and case in a short structured string.",
        requiresAuthorization: false,
        dataClasses: ["PUBLIC"],
        determinism: "DETERMINISTIC",
        sideEffect: "READ_ONLY",
        idempotent: true,
      },
      {
        capabilityId: "reference.record",
        version: "1.0.0",
        purpose: "Record a normalized value against a correlation id.",
        // Protected because it leaves a trace outside the call. The capability
        // is trivial; the DECLARATION is what the Governance-first rule reads.
        requiresAuthorization: true,
        dataClasses: ["INTERNAL"],
        determinism: "DETERMINISTIC",
        sideEffect: "EXTERNAL_CONSEQUENCE",
        idempotent: true,
      },
    ],
    requires: [
      {
        dependencyId: "@proworks-hub/eventiq",
        dependencyClass: "DEGRADABLE",
        whenUnavailable:
          "Normalization continues and returns results; recording is refused with a retryable outcome, and no result is silently dropped.",
      },
      {
        dependencyId: "@proworks-hub/architecture-engine",
        dependencyClass: "DEVELOPMENT",
      },
    ],
    publishes: [],
    subscribes: [],
  },
});

export interface ReferenceOutcome {
  readonly ok: boolean;
  readonly value?: string;
  readonly refusal?: string;
  /** Echoed so a caller can tie a result to the request that produced it. */
  readonly correlationId: string;
}

/** The unprotected capability. Deterministic, read-only, idempotent. */
export function normalize(input: string, correlationId: string): ReferenceOutcome {
  return { ok: true, value: input.trim().replace(/\s+/g, " ").toLowerCase(), correlationId };
}

/**
 * The protected capability, resolved the way DEC-024 requires.
 *
 * `authorized` is a parameter rather than something this function works out,
 * because a participant deciding its own authorization is the inversion the
 * rule exists to prevent. Governance decides; this obeys.
 *
 * The refusal says nothing about whether the capability exists. A caller who
 * is refused learns only that they were refused.
 */
export function record(
  input: string,
  correlationId: string,
  options: { authorized: boolean; eventBusAvailable: boolean },
): ReferenceOutcome {
  const capability = resolveCapability(goldenReferenceRuntime, "reference.record", options.authorized);
  if (!capability) return { ok: false, refusal: "Denied.", correlationId };

  if (!options.eventBusAvailable) {
    // The declared degraded behaviour, honoured exactly. Refusing loudly beats
    // returning ok and dropping the record, which would make the outage
    // invisible until somebody went looking for data that was never written.
    return { ok: false, refusal: "Recording unavailable; retry when EventIQ returns.", correlationId };
  }

  return { ok: true, value: normalize(input, correlationId).value, correlationId };
}

/**
 * The Architecture Engine's own declaration.
 *
 * It conforms to the standard it enforces, and its own conformance is
 * evaluated by the same chamber as everything else — an assurance system that
 * exempted itself would be asking for trust it will not extend to anyone.
 *
 * Note what it does NOT own: the verdict on whether its findings are acted on.
 * Reporting a FAIL and blocking a release are different powers, and this
 * engine holds only the first.
 */
export const architectureEngineRuntime: ParticipantRuntime = createParticipantRuntime({
  identity: {
    stableId: "hive.architecture.engine",
    instanceId: "instance.reference",
    version: "1.0.0",
    environment: "development",
  },
  charter: {
    mission: "Make Hive architecture executable, inspectable and testable.",
    classification: "SHARED_PLATFORM",
    owner: "Architecture",
    owns: [
      "the architecture rule catalog",
      "conformance evaluation",
      "the Golden Reference",
      "stable identity checking",
    ],
    doesNotOwn: [
      "Governance authority",
      "whether a release proceeds",
      "any domain state",
      "the runtime of any engine it evaluates",
    ],
  },
  maturity: "IMPLEMENTED",
  runtimeState: "READY",
  evidenceRefs: ["test:packages/architecture-engine/src/__tests__/conformance.test.ts"],
  collaboration: {
    offers: [
      {
        capabilityId: "architecture.evaluate",
        version: "1.0.0",
        purpose: "Evaluate a world of package facts against the rule catalog.",
        requiresAuthorization: false,
        dataClasses: ["INTERNAL"],
        determinism: "DETERMINISTIC",
        sideEffect: "READ_ONLY",
        idempotent: true,
      },
    ],
    requires: [],
    publishes: [],
    subscribes: [],
  },
});
