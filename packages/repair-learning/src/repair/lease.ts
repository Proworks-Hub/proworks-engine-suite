// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { environmentSchema, isTrustedProduction, type Environment } from "../execution/environment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repair agent authority leases (directive §14).
//
// "Every RepairBot must receive a scoped lease... Default V1 behavior: inspect,
// diagnose, modify candidate branch/workspace, run tests, submit repair
// candidate. Default V1 must NOT include trusted production deployment."
//
// Foundry Charter §6: "Each agent receives only the authority required for its
// task. No agent inherits unrestricted Foundry authority."
// Foundry Charter §18: "Development authority does not automatically authorize
// deployment."
//
// A LEASE EXPIRES. THAT IS WHAT MAKES IT A LEASE
//
// `expiresAt` is required and must be after `startedAt`. An agent authority
// with no expiry is a permanent grant with a temporary-sounding name, and the
// Sentinel work in Wave H made the same point about restrictions: the thing
// that never lapses is the thing nobody remembers to revoke.
//
// PROHIBITIONS BEAT ALLOWANCES
//
// When an action appears in both lists, it is prohibited. Not an error — a
// resolution rule, because the alternative is a lease whose meaning depends on
// which list was read first, and because a prohibition that can be overridden
// by adding an allowance is not a prohibition.
// ─────────────────────────────────────────────────────────────────────────────

export const agentTypeSchema = z.enum([
  "DIAGNOSTIC_BOT",
  "REPAIR_BOT",
  "TEST_BOT",
  "CONTRACT_BOT",
  "DRIFT_BOT",
]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const agentActionSchema = z.enum([
  // V1 default set.
  "inspect",
  "diagnose",
  "modify_candidate_workspace",
  "run_tests",
  "submit_repair_candidate",
  // Beyond V1. Grantable, but never by default.
  "apply_in_sandbox",
  "apply_in_validation",
  "deploy_to_staging",
  "deploy_to_production",
  "modify_trusted_baseline",
  "grant_authority",
  "modify_governance_policy",
  "modify_sentinel",
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

/**
 * Directive §14's V1 default.
 *
 * Everything an agent needs to prepare a repair and nothing that applies one
 * anywhere real. Foundry Charter §13: "Foundry may prepare the work without
 * possessing authority to approve it."
 */
export const V1_DEFAULT_ACTIONS: readonly AgentAction[] = Object.freeze([
  "inspect",
  "diagnose",
  "modify_candidate_workspace",
  "run_tests",
  "submit_repair_candidate",
]);

/**
 * Actions no lease may ever grant, whatever it says.
 *
 * These are not "requires more approval" — they are outside what a repair agent
 * can be given at all. An agent that can grant authority or edit Governance
 * policy has become the thing that decides what it may do, which Foundry
 * Charter §18 forbids in one sentence: "Foundry may design authority but may
 * not grant it to itself."
 */
export const NEVER_LEASABLE: readonly AgentAction[] = Object.freeze([
  "grant_authority",
  "modify_governance_policy",
  "modify_sentinel",
]);

export const agentLeaseSchema = z
  .object({
    agentId: z.string().min(1),
    agentType: agentTypeSchema,
    /** What this agent was created to do. One mission, not a standing role. */
    mission: z.string().min(1),

    targetComponents: z.array(z.string().min(1)).min(1),
    targetRepository: z.string().min(1),
    targetEnvironment: environmentSchema,

    allowedActions: z.array(agentActionSchema).min(1),
    prohibitedActions: z.array(agentActionSchema).default([]),

    /** Which tools the agent may invoke. */
    toolScope: z.array(z.string().min(1)).default([]),
    /** Which data it may read. Tenants, datasets. */
    dataScope: z.array(z.string().min(1)).default([]),

    startedAt: z.string().min(1),
    /** REQUIRED. A lease that never expires is a permanent grant. */
    expiresAt: z.string().min(1),

    /** How much may change. Guards a "small fix" that rewrites a subsystem. */
    maxChangeScope: z
      .object({
        maxFiles: z.number().int().positive(),
        maxComponents: z.number().int().positive(),
      })
      .strict(),

    /** Explicit, and false by default. §14. */
    deploymentAuthority: z.boolean(),

    /** The decision that authorized this lease. */
    governanceReference: z.string().min(1),
    /** The Sentinel session observing this agent (§37). */
    sentinelSession: z.string().min(1),

    requiredValidators: z.array(z.string().min(1)).min(1),
    /** What ends the lease early. */
    terminationConditions: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((l) => new Date(l.expiresAt) > new Date(l.startedAt), {
    message: "A lease must expire after it starts. An agent authority with no lifespan is a permanent grant.",
    path: ["expiresAt"],
  })
  .refine((l) => !l.allowedActions.some((a) => NEVER_LEASABLE.includes(a)), {
    message:
      "A lease may never grant authority-granting, Governance-policy or Sentinel modification. An agent that can widen its own authority has become the thing that decides what it may do (Foundry Charter §18).",
    path: ["allowedActions"],
  })
  .refine(
    (l) => !l.deploymentAuthority || !isTrustedProduction(l.targetEnvironment) || l.requiredValidators.length >= 2,
    {
      message:
        "Deployment authority in trusted production requires at least two validators. Foundry Charter §18: development authority does not automatically authorize deployment.",
      path: ["requiredValidators"],
    },
  )
  .refine((l) => l.deploymentAuthority || !l.allowedActions.includes("deploy_to_production"), {
    message:
      "A lease cannot allow production deployment while declaring no deployment authority. One of the two fields is wrong, and guessing which would be the wrong way to resolve it.",
    path: ["deploymentAuthority"],
  });
export type AgentLease = z.infer<typeof agentLeaseSchema>;

export type LeaseVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

/**
 * Whether the lease permits an action, here, now.
 *
 * Every check is a separate refusal with its own sentence. "Denied" tells an
 * operator nothing; "your lease expired forty minutes ago" tells them what to
 * do next.
 */
export function leasePermits(
  lease: AgentLease,
  request: { action: AgentAction; environment: Environment; now: Date },
): LeaseVerdict {
  if (request.now >= new Date(lease.expiresAt)) {
    return {
      permitted: false,
      reason: `Lease ${lease.agentId} expired at ${lease.expiresAt}. Expired authority is absent authority, not stale authority.`,
    };
  }

  if (request.now < new Date(lease.startedAt)) {
    return { permitted: false, reason: `Lease ${lease.agentId} does not begin until ${lease.startedAt}.` };
  }

  // Prohibitions first and unconditionally. A prohibition that an allowance can
  // override is not a prohibition.
  if (lease.prohibitedActions.includes(request.action)) {
    return {
      permitted: false,
      reason: `${request.action} is explicitly prohibited by this lease, which outranks any allowance listing it.`,
    };
  }

  if (NEVER_LEASABLE.includes(request.action)) {
    return {
      permitted: false,
      reason: `${request.action} is outside what any repair lease can grant (Foundry Charter §18).`,
    };
  }

  if (!lease.allowedActions.includes(request.action)) {
    return {
      permitted: false,
      reason: `${request.action} is not among this lease's allowed actions. An agent receives only the authority required for its task (Foundry Charter §6).`,
    };
  }

  if (request.environment !== lease.targetEnvironment) {
    return {
      permitted: false,
      reason: `This lease is scoped to ${lease.targetEnvironment} and the action targets ${request.environment}. Authority does not travel between environments.`,
    };
  }

  if (isTrustedProduction(request.environment) && !lease.deploymentAuthority) {
    return {
      permitted: false,
      reason:
        "Acting in trusted production requires explicit deployment authority, which this lease does not carry. Development authority does not automatically authorize deployment.",
    };
  }

  return { permitted: true };
}

/**
 * Whether a change has outgrown its lease.
 *
 * §14's `max_change_scope`. The failure this catches is a repair that starts as
 * a one-line fix and ends as a refactor — each step individually reasonable,
 * the whole thing far outside what was authorized.
 */
export function changeWithinScope(
  lease: AgentLease,
  change: { filesChanged: number; componentsTouched: number },
): LeaseVerdict {
  if (change.filesChanged > lease.maxChangeScope.maxFiles) {
    return {
      permitted: false,
      reason: `This change touches ${change.filesChanged} files; the lease allows ${lease.maxChangeScope.maxFiles}. A repair that outgrew its authorization needs a new one, not a bigger diff.`,
    };
  }
  if (change.componentsTouched > lease.maxChangeScope.maxComponents) {
    return {
      permitted: false,
      reason: `This change touches ${change.componentsTouched} components; the lease allows ${lease.maxChangeScope.maxComponents}.`,
    };
  }
  return { permitted: true };
}

/**
 * A lease with the V1 defaults, which is the safe shape.
 *
 * A helper because the safe configuration should be the easy one to write. The
 * dangerous fields — deployment authority, production, extra actions — all
 * require the caller to say so deliberately.
 */
export function v1RepairLease(input: {
  agentId: string;
  mission: string;
  targetComponents: readonly string[];
  targetRepository: string;
  startedAt: string;
  expiresAt: string;
  governanceReference: string;
  sentinelSession: string;
  requiredValidators: readonly string[];
  dataScope?: readonly string[];
  maxFiles?: number;
  maxComponents?: number;
}): AgentLease {
  return agentLeaseSchema.parse({
    agentId: input.agentId,
    agentType: "REPAIR_BOT",
    mission: input.mission,
    targetComponents: input.targetComponents,
    targetRepository: input.targetRepository,
    targetEnvironment: "SIMULATION",
    allowedActions: V1_DEFAULT_ACTIONS,
    // Named explicitly rather than left implicit. A reader of this lease should
    // see that production deployment was refused, not have to infer it from an
    // absence.
    prohibitedActions: ["deploy_to_production", "modify_trusted_baseline"],
    toolScope: [],
    dataScope: input.dataScope ?? [],
    startedAt: input.startedAt,
    expiresAt: input.expiresAt,
    maxChangeScope: { maxFiles: input.maxFiles ?? 10, maxComponents: input.maxComponents ?? 2 },
    deploymentAuthority: false,
    governanceReference: input.governanceReference,
    sentinelSession: input.sentinelSession,
    requiredValidators: input.requiredValidators,
    terminationConditions: [
      "lease expiry",
      "Sentinel finding against this agent",
      "change scope exceeded",
      "validator rejection",
    ],
  });
}
