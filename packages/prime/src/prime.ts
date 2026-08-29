// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { createPrimeEngine, type PrimeConfig, type PrimeEngine } from "./primeEngine.js";
import { createPrimeNexus, type PrimeNexus } from "./nexus/nexus.js";
import { createPrimePulse, type ContinuityStore, type PrimePulse } from "./pulse/pulse.js";
import { createWorkflowRunner, type WorkflowRunner } from "./workflow/workflowRunner.js";
import { createEngineRegistry, type EnginePort } from "./routing/ports.js";
import { createPrimeEvidence, type AuditSink } from "./evidence/evidence.js";

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
  /**
   * Runs a workflow, selecting each step through Nexus.
   *
   * Present only alongside a continuity store, because a runner needs
   * somewhere to persist. `null` for the same reason `pulse` is null: a runner
   * with nowhere to write would complete workflows whose state vanished, and a
   * caller must be able to tell that apart from a working one.
   *
   * Phase 1 left this outside the facade, which meant Prime exposed two
   * chambers and the code that actually ran workflows was somewhere else,
   * sequencing steps by itself. One engine now, with one selector inside it.
   */
  readonly runner: WorkflowRunner | null;
  /**
   * What a host has bound, for a host to check its own wiring.
   *
   * READ-ONLY on purpose, and this was a mistake caught by a test rather than
   * a decision made up front. Exposing the registry itself put `route()` in
   * reach of any caller, which is a general-purpose execution surface: a way
   * to invoke a capability without a workflow, without Nexus, and therefore
   * without any of the checks Nexus performs. The facade's own surface test
   * refuses exactly that, and it refused this.
   *
   * A host may ask WHAT is bound. Only the runner may route to it.
   */
  readonly boundCapabilities: () => readonly string[];
  /**
   * Whether evidence is actually going anywhere.
   *
   * A boolean rather than the sink itself, for the reason `boundCapabilities`
   * is a function rather than the registry: a host may ask whether it is
   * configured; nothing outside Prime writes Prime's audit trail.
   */
  readonly recordsEvidence: boolean;
}

export interface PrimeOptions extends PrimeConfig {
  /** Supplied by the host. Without one, Prime runs with no continuity chamber. */
  readonly continuity?: ContinuityStore;
  readonly now?: () => Date;
  /**
   * Identifies this process when it takes a workflow lease.
   *
   * Required alongside a continuity store: two instances sharing an id would
   * each believe they hold the other's lease, which is the overlapping-recovery
   * failure the lease exists to prevent.
   */
  readonly instanceId?: string;
  /**
   * Engines the host binds to capability names.
   *
   * Prime imports none of them — the dependency law is `prime: ["platform"]`
   * — so this is the only way an engine reaches it, and the only place that
   * knows which package answers which capability.
   */
  readonly engines?: readonly EnginePort[];
  /** Where decisions and continuity transitions are recorded. */
  readonly audit?: AuditSink;
  /** Reported when an evidence write fails. Never silent. */
  readonly onEvidenceFailure?: (info: { action: string; error: Error }) => void;
}

export function createPrime(options: PrimeOptions = {}): Prime {
  const {
    continuity,
    now,
    instanceId,
    engines: _boundEngines,
    audit: _audit,
    onEvidenceFailure: _onEvidenceFailure,
    ...decisionConfig
  } = options;
  const engine = createPrimeEngine(decisionConfig);
  // One Nexus, shared by the facade and by the runner. Two would be two
  // sequencers again, with the same rules configured twice.
  const nexus = createPrimeNexus();
  const engines = createEngineRegistry(options.engines ?? []);
  const evidence = createPrimeEvidence({
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.onEvidenceFailure ? { onSinkFailure: options.onEvidenceFailure } : {}),
    ...(now ? { now } : {}),
  });

  // One Pulse as well as one Nexus. The runner takes every claim through the
  // same chamber the facade exposes, so a caller inspecting `pulse.health()`
  // is reading the state of the thing that actually holds the leases.
  const pulse = continuity
    ? createPrimePulse({ store: continuity, ...(now ? { now } : {}) })
    : null;

  return {
    name: "prime",
    nexus,
    pulse,
    boundCapabilities: () => engines.capabilities(),
    recordsEvidence: evidence.enabled,
    runner:
      continuity && pulse
        ? createWorkflowRunner({
            store: continuity,
            instanceId: instanceId ?? "prime",
            nexus,
            pulse,
            engines,
            evidence,
            ...(now ? { now } : {}),
          })
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
