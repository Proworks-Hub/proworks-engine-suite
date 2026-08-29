// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  isTrustedProduction,
  type Sandbox,
} from "./environment.js";
import type {
  FaultInjector,
  InjectableFault,
  InjectionRecord,
  MechanicalFault,
} from "./faults.js";

// ─────────────────────────────────────────────────────────────────────────────
// An in-memory mechanical fault injector.
//
// Until now `FaultInjector` was an interface with no implementation, so every
// fault-injection scenario returned INCONCLUSIVE — correctly, but uselessly.
// This makes the mechanical fault classes actually happen.
//
// IT INJECTS INTO A FAULT PLANE, NOT INTO ANYBODY'S INFRASTRUCTURE
//
// §41 forbids hard-coupling to one broker, database or provider, and §5 says
// injection should occur "through abstractions where possible". So this
// injector does not reach into a queue or a database. It maintains a FaultPlane
// that an executor consults: "am I currently supposed to be broken, and how?"
//
// That inverts the usual design and is better for the purpose. A real chaos
// tool breaks the infrastructure and hopes the application notices. Here the
// application asks, which means the fault is deterministic, reproducible, and
// works identically against an in-memory double and a live service.
//
// The cost is honest and worth stating: this proves the system's RESPONSE to a
// fault, not that the fault can occur. A consumer that handles
// DEPENDENCY_TIMEOUT correctly here might still deadlock on a real socket
// timeout. That is a different test, and this one does not pretend to be it.
// ─────────────────────────────────────────────────────────────────────────────

/** What a component should currently pretend is wrong with it. */
export interface ActiveFault {
  readonly fault: MechanicalFault;
  readonly targetComponentId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** How many times the fault has been observed by an executor. */
  observations: number;
  /** After this many observations the fault stops. Undefined means forever. */
  readonly expiresAfterObservations?: number;
}

/**
 * The plane an executor consults.
 *
 * Deliberately a query interface rather than a mutation one. An executor asks
 * what is wrong; it cannot inject, clear, or extend a fault. A test double that
 * could clear its own fault would pass every scenario.
 */
export interface FaultPlane {
  /** The fault active for a component, or null. Counts as an observation. */
  observe(componentId: string): ActiveFault | null;
  /** Whether a specific fault is active, without counting an observation. */
  peek(componentId: string, fault: MechanicalFault): boolean;
  /** Everything currently active. For assertions, not for executors. */
  active(): readonly ActiveFault[];
}

export interface MechanicalInjector extends FaultInjector {
  /** The plane an executor consults. */
  readonly plane: FaultPlane;
  /** What was injected and observed, for the run record. */
  history(): readonly { fault: MechanicalFault; componentId: string; observations: number }[];
}

/**
 * Faults this injector can produce.
 *
 * Fifteen of the directive's twenty-five. The ten absent ones need real
 * infrastructure to be meaningful — NEXUS_FAILURE and PULSE_FAILURE need Prime
 * chambers that do not exist yet, DATABASE_FAILURE and QUEUE_BACKLOG need a
 * database and a queue, BAD_DEPLOYMENT needs a deployment. Claiming them here
 * would mean an executor asking "is the database down?" of a plane that has
 * never seen a database.
 */
export const SUPPORTED_FAULTS: readonly MechanicalFault[] = Object.freeze([
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
  "CONTRACT_INCOMPATIBILITY",
  "PARTIAL_WORKFLOW_FAILURE",
]);

/**
 * Faults this injector deliberately does NOT support, and what each needs.
 *
 * Exported so the gap is queryable. A host that later gains a real queue can
 * check this list rather than rediscovering why QUEUE_BACKLOG never fired.
 */
export const UNSUPPORTED_FAULTS: Readonly<Partial<Record<MechanicalFault, string>>> = Object.freeze({
  DATABASE_FAILURE: "Needs a database. An in-memory plane cannot make one fail meaningfully.",
  QUEUE_BACKLOG: "Needs a queue with depth. Nothing here has one.",
  EXTERNAL_PROVIDER_FAILURE: "Needs an external provider to fail.",
  AI_PROVIDER_FAILURE: "Needs a model provider.",
  SECRET_REVOKED: "Needs a secret store that can revoke.",
  NEXUS_FAILURE: "Needs Prime Nexus, which does not exist yet.",
  PULSE_FAILURE: "Needs Prime Pulse, which does not exist yet.",
  SENTINEL_ISOLATION: "Needs a live Sentinel able to isolate something.",
  CONFIGURATION_DRIFT: "Needs deployed configuration to drift from declared. The drift detector's job.",
  BAD_DEPLOYMENT: "Needs a deployment pipeline.",
});

export function createMechanicalInjector(options: { now?: () => Date } = {}): MechanicalInjector {
  const now = options.now ?? (() => new Date());
  const faults = new Map<string, ActiveFault>();
  const record: { fault: MechanicalFault; componentId: string; observations: number }[] = [];

  const key = (componentId: string, fault: MechanicalFault) => `${componentId}::${fault}`;

  const plane: FaultPlane = {
    observe(componentId) {
      for (const [, active] of faults) {
        if (active.targetComponentId !== componentId) continue;

        active.observations += 1;
        const entry = record.find(
          (r) => r.componentId === componentId && r.fault === active.fault,
        );
        if (entry) entry.observations = active.observations;

        // A fault with an observation budget stops after it. This is how
        // "the third delivery is a duplicate" or "it fails once then
        // recovers" gets expressed without the executor knowing about time.
        if (
          active.expiresAfterObservations !== undefined &&
          active.observations > active.expiresAfterObservations
        ) {
          faults.delete(key(active.targetComponentId, active.fault));
          return null;
        }

        return active;
      }
      return null;
    },

    peek(componentId, fault) {
      return faults.has(key(componentId, fault));
    },

    active: () => [...faults.values()],
  };

  return {
    supports: SUPPORTED_FAULTS,
    plane,

    async inject(fault: InjectableFault, sandbox: Sandbox): Promise<InjectionRecord> {
      // Refused here as well as at the harness gate. A gate checked in exactly
      // one place is a gate until somebody adds a second caller.
      if (isTrustedProduction(sandbox.environment)) {
        return {
          fault,
          injectedAt: now().toISOString(),
          effective: false,
          ineffectiveBecause:
            "This injector refuses to act against trusted production, independently of the harness gate.",
        };
      }

      if (!SUPPORTED_FAULTS.includes(fault.fault)) {
        return {
          fault,
          injectedAt: now().toISOString(),
          effective: false,
          ineffectiveBecause:
            UNSUPPORTED_FAULTS[fault.fault] ??
            `${fault.fault} is not supported by the in-memory injector.`,
        };
      }

      const budget = fault.parameters.expiresAfterObservations;
      const active: ActiveFault = {
        fault: fault.fault,
        targetComponentId: fault.targetComponentId,
        parameters: fault.parameters,
        observations: 0,
        ...(typeof budget === "number" ? { expiresAfterObservations: budget } : {}),
      };

      faults.set(key(fault.targetComponentId, fault.fault), active);
      record.push({ fault: fault.fault, componentId: fault.targetComponentId, observations: 0 });

      return { fault, injectedAt: now().toISOString(), effective: true };
    },

    async clear() {
      faults.clear();
    },

    history: () => record.map((r) => ({ ...r })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What an executor does with a fault.
//
// These helpers exist so that every executor responds to a given fault the same
// way. An executor that invents its own interpretation of STALE_STATE produces
// evidence nobody else's executor produces, and the corpus stops being
// comparable across hosts.
// ─────────────────────────────────────────────────────────────────────────────

export interface FaultEffect {
  /** Whether the call should fail outright. */
  readonly shouldFail: boolean;
  /** The error to raise, when it should fail. */
  readonly errorCode: string | null;
  /** Evidence facts the executor should record, whatever else it does. */
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
  /** A human-readable statement of what the fault did. */
  readonly detail: string;
}

const NO_EFFECT: FaultEffect = {
  shouldFail: false,
  errorCode: null,
  facts: {},
  detail: "No fault active.",
};

/**
 * The canonical effect of each supported fault.
 *
 * The facts here are exactly the ones the extended invariant detectors read, so
 * an injected fault produces evidence a detector can act on. That coupling is
 * deliberate: a fault that produces no detectable evidence tests nothing.
 */
export function effectOf(active: ActiveFault | null): FaultEffect {
  if (active === null) return NO_EFFECT;

  switch (active.fault) {
    case "ENGINE_UNAVAILABLE":
      return {
        shouldFail: true,
        errorCode: "EUNAVAILABLE",
        facts: { componentFailed: true, operatingDegraded: true },
        detail: `${active.targetComponentId} is unavailable.`,
      };

    case "DEPENDENCY_TIMEOUT":
      return {
        shouldFail: true,
        errorCode: "ETIMEDOUT",
        facts: { componentFailed: true, failedBecauseUpstreamFailed: true },
        detail: `A call to ${active.targetComponentId} timed out.`,
      };

    case "DEPENDENCY_ERROR":
      return {
        shouldFail: true,
        errorCode: "EDEPENDENCY",
        facts: { componentFailed: true, failedBecauseUpstreamFailed: true },
        detail: `${active.targetComponentId} returned an error.`,
      };

    case "DUPLICATE_EVENT":
      // Does NOT fail. A duplicate that fails loudly is not the interesting
      // case — the interesting case is one that succeeds twice.
      return {
        shouldFail: false,
        errorCode: null,
        facts: { duplicateDelivered: true, isReplay: false },
        detail: "A duplicate delivery was made.",
      };

    case "MISSING_EVENT":
      return {
        shouldFail: false,
        errorCode: null,
        facts: { eventMissing: true },
        detail: "An expected event was never delivered.",
      };

    case "OUT_OF_ORDER_EVENT":
      return {
        shouldFail: false,
        errorCode: null,
        facts: { outOfOrder: true },
        detail: "Events arrived out of order.",
      };

    case "MALFORMED_PAYLOAD":
      return {
        shouldFail: true,
        errorCode: "EMALFORMED",
        facts: { inputValidated: false, consequential: true },
        detail: "The payload did not match its schema.",
      };

    case "SCHEMA_MISMATCH":
    case "CONTRACT_INCOMPATIBILITY":
      return {
        shouldFail: true,
        errorCode: "ESCHEMA",
        facts: {
          contractName: String(active.parameters.contractName ?? "unknown.contract"),
          contractVersion: String(active.parameters.contractVersion ?? "2.0"),
        },
        detail: "Producer and consumer disagree about the contract.",
      };

    case "INVALID_AUTHORITY":
      return {
        shouldFail: true,
        errorCode: "EAUTHORITY",
        facts: { consequential: true, permitted: false },
        detail: "The request carried no valid authority.",
      };

    case "EXPIRED_AUTHORITY":
      return {
        shouldFail: true,
        errorCode: "EEXPIRED",
        facts: { consequential: true, permitted: false, authorityExpired: true },
        detail: "The authority presented had expired.",
      };

    case "TENANT_MISMATCH":
      // Does NOT fail, deliberately. The dangerous case is the one that
      // succeeds across a tenant boundary — a mismatch that errors is the
      // system working.
      return {
        shouldFail: false,
        errorCode: null,
        facts: { tenantId: String(active.parameters.foreignTenantId ?? "other-shop") },
        detail: "A foreign tenant's context leaked into the execution.",
      };

    case "STATE_CORRUPTION":
      return {
        shouldFail: false,
        errorCode: null,
        facts: {
          onHand: Number(active.parameters.onHand ?? 100),
          available: Number(active.parameters.available ?? 90),
          reserved: Number(active.parameters.reserved ?? 4),
        },
        detail: "Stored state no longer satisfies its own arithmetic.",
      };

    case "STALE_STATE":
      return {
        shouldFail: false,
        errorCode: null,
        facts: { staleRead: true, isDerived: true },
        detail: "A read returned state older than the last write.",
      };

    case "PARTIAL_WORKFLOW_FAILURE":
      return {
        shouldFail: true,
        errorCode: "EPARTIAL",
        facts: { partialWriteOccurred: true, componentFailed: true },
        detail: "The workflow failed after some writes had committed.",
      };

    default:
      // Every supported fault has a case above. A fault reaching here is one
      // this injector claimed to support and does not, which is worth saying
      // rather than silently doing nothing.
      return {
        shouldFail: false,
        errorCode: null,
        facts: {},
        detail: `${active.fault} is listed as supported but has no defined effect. This is a bug in the injector, not a fault in the system under test.`,
      };
  }
}
