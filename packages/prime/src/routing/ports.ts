// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PrimeExecutionContext } from "../context.js";

// ─────────────────────────────────────────────────────────────────────────────
// How Prime reaches an engine.
//
// It does not import one. The dependency law is `prime: ["platform"]`, so
// ForgeIQ, CostIQ, WorkOrderIQ and InventoryIQ are unreachable from here at
// compile time — and that is the point rather than an obstacle. A Prime that
// imported the engines it coordinates could not be tested without them, could
// not be deployed without them, and would drag every specialist into the bundle
// of anything that touched Prime.
//
// So a host binds engines to capabilities, and Prime routes to a capability
// NAME. It never learns which package answered.
//
// DENY BY DEFAULT
//
// An unregistered capability produces a `refused` outcome. Not a throw, and
// emphatically not a skip. A throw would make an unconfigured host look like a
// crashed one; a skip would let a workflow proceed past a step nobody
// performed, which is the failure mode where an order reaches a machine having
// missed its costing.
//
// THE PORT RECEIVES NO AUTHORITY
//
// A capability is handed the execution context to READ — tenant, actor,
// correlation, the authorization reference — and returns an outcome. It has no
// way to change the context, choose the next step, or extend its own scope,
// because it is given nothing that could. The return type is data.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a routed step produced, in terms Nexus and Pulse can act on.
 *
 * A closed set, deliberately. An engine returning a shape Prime does not
 * recognise is a step whose result nobody can reason about, and the honest
 * handling of that is to treat it as a failure rather than to guess.
 */
export type EngineOutcome =
  /** The work is done. `output` is merged into the workflow context. */
  | { readonly kind: "completed"; readonly output?: Record<string, unknown> }
  /**
   * The engine declined. A decision, not a fault — the workflow stops and
   * nothing is compensated, because nothing happened.
   */
  | { readonly kind: "refused"; readonly reason: string }
  /** A prerequisite is not ready. The workflow waits; it does not fail. */
  | { readonly kind: "waiting"; readonly on: string; readonly detail?: string }
  /** A synchronous validation must run before this can be judged. */
  | { readonly kind: "validation-required"; readonly validator: string }
  /**
   * It failed, and trying again could work.
   *
   * Pulse's business. The distinction from `non-retryable` is the whole reason
   * this is a union rather than a boolean: retrying an irreversible failure is
   * how one effect happens twice.
   */
  | { readonly kind: "retryable-failure"; readonly reason: string }
  /** It failed and retrying cannot help. Compensation runs. */
  | { readonly kind: "non-retryable-failure"; readonly reason: string }
  /**
   * A best-effort notification did not go out.
   *
   * The work itself succeeded. Recorded rather than escalated, because failing
   * a manufactured order for an unsent email would be the wrong trade — but
   * recorded, because silently dropping it is how nobody finds out.
   */
  | { readonly kind: "degraded"; readonly detail: string };

/** What Prime hands a capability. Everything here is read-only. */
export interface EngineRequest {
  /** Read-only. A capability cannot alter the execution it runs inside. */
  readonly context: PrimeExecutionContext;
  /** The step being performed, by name. */
  readonly stepId: string;
  /** Accumulated workflow context. Read it; return additions via `output`. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * One capability a host has bound an engine to.
 *
 * Named for what it DOES, never for who does it: "manufacturing.plan", not
 * "forgeiq.plan". A capability named after a package is one that cannot be
 * re-bound without rewriting every workflow that used it, which defeats the
 * purpose of routing through a name at all.
 */
export interface EnginePort {
  readonly capability: string;
  perform(request: EngineRequest): Promise<EngineOutcome> | EngineOutcome;
}

export interface EngineRegistry {
  /** Routes to a capability. Refuses an unregistered one rather than throwing. */
  route(capability: string, request: EngineRequest): Promise<EngineOutcome>;
  /** Which capabilities are bound. For a host to check its own wiring. */
  capabilities(): readonly string[];
  has(capability: string): boolean;
}

export function createEngineRegistry(ports: readonly EnginePort[] = []): EngineRegistry {
  const byCapability = new Map<string, EnginePort>();

  for (const port of ports) {
    if (byCapability.has(port.capability)) {
      // Refused at construction rather than resolved by order. Two engines
      // claiming one capability is a host misconfiguration, and picking the
      // first or last silently would mean the shop's behaviour depended on
      // array order in a bootstrap file.
      throw new Error(
        `Two engines are bound to the capability "${port.capability}". ` +
          "Prime routes by name, so a duplicate name has no correct resolution.",
      );
    }
    byCapability.set(port.capability, port);
  }

  return {
    capabilities: () => [...byCapability.keys()].sort(),
    has: (capability) => byCapability.has(capability),

    async route(capability, request) {
      const port = byCapability.get(capability);
      if (!port) {
        return {
          kind: "refused",
          reason:
            `No engine is bound to the capability "${capability}". ` +
            "Prime refuses an unrouted step rather than skipping it: a workflow that continues past " +
            "a step nobody performed is how work reaches a machine having missed its costing.",
        };
      }

      try {
        return await port.perform(request);
      } catch (cause) {
        // An engine that throws has not told Prime whether retrying is safe,
        // and the safe reading of "I do not know" is the one that does not
        // repeat an effect. Non-retryable, and Pulse will not retry it.
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return {
          kind: "non-retryable-failure",
          reason:
            `The engine bound to "${capability}" threw: ${error.message}. ` +
            "A thrown error does not say whether the effect happened, so it is not retried.",
        };
      }
    },
  };
}

/**
 * Whether routing to an engine grants Prime any of that engine's authority.
 *
 * Always false. Prime asks a capability to do something it was already
 * authorized to do; the asking confers nothing. A function rather than a
 * comment for the same reason the other constitutional guarantees are.
 */
export function routingGrantsEngineAuthority(): false {
  return false;
}
