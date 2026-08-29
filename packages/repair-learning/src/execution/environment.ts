// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Where a run happens, and what that permits.
//
// Directive §4: "Repair-learning scenarios must not default to trusted
// production execution... Sandbox authority must not automatically work in
// Production."
//
// Constitution, Common Overwatch Protections — Production and Sandbox
// Separation: "Authority existing within a simulation, sandbox, validation
// environment, digital twin, or development environment shall not automatically
// exist in trusted production operation. Foundry and authorized AI may receive
// broad experimental freedom within appropriately isolated environments without
// that authority crossing into production."
//
// That is one rule with two halves, and the second half is the interesting one:
// the point of a sandbox is that authority inside it can be BROAD. Making
// simulation as restrictive as production would defeat the purpose. What must
// never happen is the authority travelling.
// ─────────────────────────────────────────────────────────────────────────────

export const environmentSchema = z.enum([
  "SIMULATION",
  "DEVELOPMENT",
  "VALIDATION",
  "STAGING",
  "PRODUCTION",
]);
export type Environment = z.infer<typeof environmentSchema>;

/** V1 default. Directive §4: "V1 Repair Learning should default to SIMULATION." */
export const DEFAULT_ENVIRONMENT: Environment = "SIMULATION";

/** The only environment where activity affects real tenants and real data. */
export const TRUSTED_PRODUCTION: Environment = "PRODUCTION";

export type AuthorityCrossing =
  | { readonly crosses: true }
  | { readonly crosses: false; readonly reason: string };

/**
 * Whether authority held in one environment also holds in another.
 *
 * Only ever true when the environments are the same. Not a gradient, not a
 * hierarchy, and specifically NOT "higher environments include lower ones" —
 * the seductive wrong answer here is that STAGING authority obviously covers
 * SIMULATION, which is true right up until somebody inverts the comparison and
 * a simulation lease reaches production.
 *
 * Authority is granted per environment. Wanting it somewhere else means asking
 * for it there.
 */
export function authorityCrossesTo(from: Environment, to: Environment): AuthorityCrossing {
  if (from === to) return { crosses: true };
  return {
    crosses: false,
    reason:
      `Authority established in ${from} does not exist in ${to}. ` +
      "Authority within a simulation, sandbox, validation environment, digital twin or development environment " +
      "shall not automatically exist in trusted production operation (Constitution, Production and Sandbox Separation). " +
      `A separate grant scoped to ${to} is required.`,
  };
}

/** True when activity here can affect real tenants. */
export function isTrustedProduction(environment: Environment): boolean {
  return environment === TRUSTED_PRODUCTION;
}

/**
 * What the sandbox must be able to do (directive §4).
 *
 * An interface rather than an implementation because the directive's
 * portability rule (§41) forbids hard-coupling to one database, broker or CI
 * vendor. A host binds this to whatever it actually runs; the harness only
 * knows the shape.
 */
export interface Sandbox {
  readonly environment: Environment;
  /** Deterministic fixtures. Same inputs, same run. */
  seed(fixtures: Readonly<Record<string, unknown>>): Promise<void>;
  /** Back to a known state between runs. */
  reset(): Promise<void>;
  /**
   * The run's clock.
   *
   * Injected rather than read from the system, because a scenario about an
   * expired authority or a decayed emergency cannot be written against a clock
   * that only moves forward at one second per second.
   */
  now(): Date;
  advanceClock(ms: number): void;
  /** Synthetic tenant. Never a real one, in SIMULATION. */
  readonly tenantId: string;
}

export type SandboxCheck =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: string };

/**
 * Whether this sandbox may be used for this scenario.
 *
 * The gate that stops a destructive fault-injection scenario running against
 * trusted production because somebody passed the wrong environment. Chaos and
 * fault injection are exactly what a sandbox is for and exactly what production
 * is not.
 */
export function sandboxUsableFor(
  sandbox: Sandbox,
  scenario: { scenarioType: string; faultClass: string },
): SandboxCheck {
  if (!isTrustedProduction(sandbox.environment)) return { usable: true };

  if (scenario.scenarioType === "FAULT_INJECTION" || scenario.scenarioType === "CHAOS_FUZZ") {
    return {
      usable: false,
      reason:
        `A ${scenario.scenarioType} scenario (${scenario.faultClass}) must not run against trusted production. ` +
        "Deliberately breaking a system that real tenants depend on is not a simulation, whatever it is called.",
    };
  }

  if (scenario.scenarioType === "EXPERIMENTAL") {
    return {
      usable: false,
      reason:
        "An EXPERIMENTAL scenario must not run against trusted production. Experimental means the outcome is unknown, and an unknown outcome in production is an incident.",
    };
  }

  return { usable: true };
}
