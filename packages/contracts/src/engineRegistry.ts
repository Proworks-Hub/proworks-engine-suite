// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { HealthState } from "./identifiers.js";
import {
  claimedDomains,
  isTrustedForConsequentialWork,
  parseRuntimeManifest,
  type RuntimeEngineManifest,
} from "./runtimeManifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine registry: what exists, and whether it can be relied on.
//
// It answers:
//
//   What components are registered, and which are trusted?
//   Which engine provides this capability, at which version?
//   What contracts does it expose? Which charter governs it?
//   Is it healthy enough to be given work?
//
// IT DOES NOT ANSWER: "may this actor invoke this capability?"
//
// That is Governance, and the separation is the whole point. The execution
// order is fixed:
//
//   authority established → GOVERNANCE permits → registry resolves → execute
//
// A registry that also authorized would make discovery and permission the same
// act, which is the leak DEC-024 closed in the coordinator. There is deliberately
// no method here taking an actor, and a test asserts none appears.
//
// WHY A SECOND REGISTRY
//
// `control-plane` already has `createEngineRegistry`, over the PRESENTATION
// manifest, serving the Hive console. This one is over the CONSTITUTIONAL
// manifest, serving Prime and hosts. Merging them would force the console to
// depend on constitutional shapes and the runtime to depend on the console's —
// the coupling avoided in Wave C for the same reason. They are joined by
// `engineId` and evolve separately.
//
// DOMAIN CONFLICT IS FATAL, NOT A WARNING
//
// Two engines claiming one source-of-truth domain is the most damaging thing a
// registry can fail to notice: both look authoritative, both answer, and the
// disagreement surfaces later as data nobody can reconcile. It is rejected at
// load. See `conflictingDomains`.
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryProblem {
  readonly engineId: string;
  readonly reason: string;
  /** Fatal problems keep the engine out of the registry entirely. */
  readonly fatal: boolean;
}

export interface CapabilityProvider {
  readonly engineId: string;
  readonly canonicalName: string;
  readonly implementationVersion: string;
  readonly lifecycleState: RuntimeEngineManifest["lifecycleState"];
  /** Lifecycle AND Governance, not lifecycle alone. */
  readonly trusted: boolean;
  /** Last reported state, or null when nothing has reported. */
  readonly health: HealthState | null;
}

export interface EngineRegistry {
  /** Everything that loaded. */
  all(): readonly RuntimeEngineManifest[];
  byEngineId(engineId: string): RuntimeEngineManifest | null;

  /**
   * Which engines provide a capability.
   *
   * Returns ALL of them, trusted or not, with the trust flag set. Filtering
   * here would hide from an operator that an untrusted engine claims the
   * capability, which is exactly what they need to see when nothing answers.
   */
  providersOf(capability: string): readonly CapabilityProvider[];

  /** The engine authoritative for a source-of-truth domain, or null. */
  ownerOfDomain(domain: string): string | null;

  /** The charter governing an engine, or null when unregistered. */
  charterFor(engineId: string): RuntimeEngineManifest["charter"] | null;

  /**
   * Records a health report.
   *
   * The registry does not measure health — it records what an engine says
   * about itself, and refuses a state that engine's manifest says it cannot
   * report. A component reporting a state it never declared is either
   * misconfigured or not the component it claims to be.
   */
  reportHealth(engineId: string, state: HealthState): { accepted: boolean; reason?: string };

  healthOf(engineId: string): HealthState | null;

  /**
   * Whether an engine may be given consequential work right now.
   *
   * Three conditions, all required: registered, trusted, and in a health state
   * that accepts work. A caller that checks only one has checked none of the
   * others.
   */
  readyForWork(engineId: string): boolean;

  problems(): readonly RegistryProblem[];
}

/** Domains claimed by more than one engine. Fatal at load. */
function conflictingDomains(
  manifests: readonly RuntimeEngineManifest[],
): Map<string, string[]> {
  const byDomain = new Map<string, string[]>();
  for (const m of manifests) {
    for (const domain of claimedDomains(m)) {
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), m.engineId]);
    }
  }
  return new Map([...byDomain].filter(([, engines]) => engines.length > 1));
}

export function createRuntimeRegistry(inputs: readonly unknown[]): EngineRegistry {
  const problems: RegistryProblem[] = [];
  const parsed: RuntimeEngineManifest[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const result = parseRuntimeManifest(input);
    if (!result.ok) {
      problems.push({ ...result.problem, fatal: true });
      continue;
    }

    if (seen.has(result.manifest.engineId)) {
      // Two manifests for one identity: whichever loaded last would silently
      // define the engine, and which one that is depends on array order.
      problems.push({
        engineId: result.manifest.engineId,
        reason: "Duplicate engineId. Two manifests cannot both define one engine.",
        fatal: true,
      });
      continue;
    }

    seen.add(result.manifest.engineId);
    parsed.push(result.manifest);
  }

  // Domain conflicts are resolved by rejecting EVERY claimant, not by keeping
  // the first. Keeping one would silently pick a winner on load order, and the
  // whole problem is that nobody agreed which should win.
  const conflicts = conflictingDomains(parsed);
  const rejected = new Set<string>();
  for (const [domain, engines] of conflicts) {
    for (const engineId of engines) {
      rejected.add(engineId);
      problems.push({
        engineId,
        reason:
          `Source-of-truth conflict on "${domain}", also claimed by ${engines
            .filter((e) => e !== engineId)
            .join(", ")}. ` +
          "Every claimant is rejected: keeping one would pick a winner by load order, and no engine agreed to that.",
        fatal: true,
      });
    }
  }

  const manifests = parsed.filter((m) => !rejected.has(m.engineId));
  const byId = new Map(manifests.map((m) => [m.engineId, m]));
  const health = new Map<string, HealthState>();

  const domainOwner = new Map<string, string>();
  for (const m of manifests) {
    for (const domain of claimedDomains(m)) domainOwner.set(domain, m.engineId);
  }

  return {
    all: () => manifests,
    byEngineId: (id) => byId.get(id) ?? null,

    providersOf(capability) {
      return manifests
        .filter((m) => m.capabilities.includes(capability))
        .map((m) => ({
          engineId: m.engineId,
          canonicalName: m.canonicalName,
          implementationVersion: m.versions.implementationVersion,
          lifecycleState: m.lifecycleState,
          trusted: isTrustedForConsequentialWork(m),
          health: health.get(m.engineId) ?? null,
        }));
    },

    ownerOfDomain: (domain) => domainOwner.get(domain) ?? null,
    charterFor: (id) => byId.get(id)?.charter ?? null,

    reportHealth(engineId, state) {
      const manifest = byId.get(engineId);
      if (!manifest) {
        return {
          accepted: false,
          reason: `${engineId} is not registered. An unregistered component cannot acquire standing by reporting health.`,
        };
      }
      if (!manifest.health.reportableStates.includes(state)) {
        return {
          accepted: false,
          reason:
            `${engineId} reported "${state}", which its manifest does not list as reportable ` +
            `(${manifest.health.reportableStates.join(", ")}). Either the manifest is wrong or this is not that engine.`,
        };
      }
      health.set(engineId, state);
      return { accepted: true };
    },

    healthOf: (id) => health.get(id) ?? null,

    readyForWork(engineId) {
      const manifest = byId.get(engineId);
      if (!manifest) return false;
      if (!isTrustedForConsequentialWork(manifest)) return false;

      const state = health.get(engineId);
      // No report is NOT healthy. An engine nobody has heard from is unknown,
      // and unknown is not a state work should be sent into.
      if (!state) return false;
      return state === "healthy" || state === "degraded";
    },

    problems: () => problems,
  };
}
