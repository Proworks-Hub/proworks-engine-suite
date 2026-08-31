// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { hiveClassificationSchema } from "@proworks-hub/contracts";
import { z } from "zod";

import {
  dataClassificationSchema,
  dependencyClassSchema,
  determinismSchema,
  maturityLevelSchema,
  runtimeStateSchema,
  sideEffectSchema,
} from "./semantics.js";

// ─────────────────────────────────────────────────────────────────────────────
// What every canonical Hive participant declares about itself.
//
// Manifesto §4. The runtime is a SPECIFICATION plus kits and conformance
// tests, not a base class — a Python engine and a TypeScript engine satisfy
// the same contract without inheriting from the same code. So everything here
// is data. There is no lifecycle daemon, nothing to start, and nothing an
// engine must call in order to be conformant.
//
// The reason that matters constitutionally: a shared runtime object every
// engine must hold is a shared runtime object that can be given authority
// later. Declaring in data means the Architecture Engine can evaluate a
// participant it has never loaded, in a language it does not run.
// ─────────────────────────────────────────────────────────────────────────────

/** A stable identifier that outlives implementations, renames and rewrites. */
export const stableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/, "stable id is dotted lowercase, e.g. hive.forgeiq");

/**
 * Who this participant is.
 *
 * `instanceId` is separate from `stableId` because the same engine runs in
 * many Hive Instances and they are not the same thing. Evidence that does not
 * say which Instance produced it cannot be acted on.
 */
export const participantIdentitySchema = z
  .object({
    stableId: stableIdSchema,
    instanceId: z.string().min(1),
    version: z.string().min(1),
    /** Build/commit identity. Optional only because not every host records one. */
    buildId: z.string().min(1).optional(),
    environment: z.enum(["development", "test", "staging", "production"]),
  })
  .strict();
export type ParticipantIdentity = z.infer<typeof participantIdentitySchema>;

/**
 * What this participant is for, and — as importantly — what it is not for.
 *
 * `doesNotOwn` is required and must be non-empty. A charter that lists only
 * what a component owns has no edges, and a component with no edges acquires
 * responsibilities by drift: each one individually reasonable, and nobody
 * able to point at the moment it stopped being what it was chartered as.
 */
export const charterMetadataSchema = z
  .object({
    mission: z.string().min(1),
    classification: hiveClassificationSchema,
    owner: z.string().min(1),
    owns: z.array(z.string().min(1)).min(1),
    doesNotOwn: z.array(z.string().min(1)).min(1),
    /** Where the authoritative charter text lives. A reference, never a copy. */
    charterRef: z.string().min(1).optional(),
  })
  .strict();
export type CharterMetadata = z.infer<typeof charterMetadataSchema>;

/**
 * One thing this participant can be asked to do.
 *
 * `requiresAuthorization` has NO DEFAULT. A default of `false` would make
 * "nobody thought about it" indistinguishable from "this is genuinely open",
 * and the failure is silent and in the dangerous direction. DEC-024 requires
 * authorization to be decided BEFORE a protected capability is resolved, and
 * that decision cannot be made from a field nobody filled in.
 */
export const capabilityDeclarationSchema = z
  .object({
    capabilityId: stableIdSchema,
    version: z.string().min(1),
    purpose: z.string().min(1),
    requiresAuthorization: z.boolean(),
    dataClasses: z.array(dataClassificationSchema).min(1),
    determinism: determinismSchema,
    sideEffect: sideEffectSchema,
    /** Whether re-running with the same key is safe. Required for retry decisions. */
    idempotent: z.boolean(),
  })
  .strict();
export type CapabilityDeclaration = z.infer<typeof capabilityDeclarationSchema>;

/** One thing this participant needs from somewhere else. */
export const declaredDependencySchema = z
  .object({
    dependencyId: z.string().min(1),
    dependencyClass: dependencyClassSchema,
    /**
     * What happens when it is unavailable.
     *
     * Required for every class except DEVELOPMENT, enforced below. "It
     * degrades gracefully" is not a behaviour; naming the reduced function is.
     */
    whenUnavailable: z.string().min(1).optional(),
  })
  .strict();
export type DeclaredDependency = z.infer<typeof declaredDependencySchema>;

/**
 * How this participant cooperates. Manifesto §38.
 *
 * Explicit so that cooperation is degradable. An undeclared dependency is
 * still a dependency; it is simply one nobody can plan around.
 */
export const collaborationContractSchema = z
  .object({
    offers: z.array(capabilityDeclarationSchema).default([]),
    requires: z.array(declaredDependencySchema).default([]),
    /** Event types published. Empty is a real answer, not a missing one. */
    publishes: z.array(z.string().min(1)).default([]),
    subscribes: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    c.requires.forEach((dep, i) => {
      if (dep.dependencyClass !== "DEVELOPMENT" && !dep.whenUnavailable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires", i, "whenUnavailable"],
          message: `dependency "${dep.dependencyId}" is ${dep.dependencyClass} at runtime and must say what happens when it is unavailable`,
        });
      }
    });
  });
export type CollaborationContract = z.infer<typeof collaborationContractSchema>;

/**
 * The full declaration. This is what a conformance evaluator reads.
 *
 * `maturity` and `runtimeState` are both required and neither is derived from
 * the other: maturity is what a component has proven, runtime state is what it
 * is doing now, and a CERTIFIED engine can be STOPPED.
 */
export const participantRuntimeSchema = z
  .object({
    identity: participantIdentitySchema,
    charter: charterMetadataSchema,
    maturity: maturityLevelSchema,
    runtimeState: runtimeStateSchema,
    collaboration: collaborationContractSchema,
    /** Where evidence for this participant's claims can be found. */
    evidenceRefs: z.array(z.string().min(1)).default([]),
    knowledgePackageRef: z.string().min(1).optional(),
  })
  .strict();
export type ParticipantRuntime = z.infer<typeof participantRuntimeSchema>;

// ── Reference kit ────────────────────────────────────────────────────────────
//
// Thin on purpose. These construct and validate; they do not run anything, own
// anything or connect to anything. A kit that opened a connection would make
// the specification unimplementable in a language the kit is not written in,
// which is the one thing §4 forbids.

/** Validates an identity, throwing with the field that is wrong. */
export function createParticipantIdentity(input: unknown): ParticipantIdentity {
  return participantIdentitySchema.parse(input);
}

/** Validates a full participant declaration. */
export function createParticipantRuntime(input: unknown): ParticipantRuntime {
  return participantRuntimeSchema.parse(input);
}

/**
 * A capability lookup that refuses to answer before authorization. DEC-024.
 *
 * Returns the capability only when `authorized` is true. The order is the
 * whole point: resolving first and checking second leaks WHICH capabilities
 * exist, and a caller learning that `finance.ledger.post` exists has learned
 * something from a system that refused them.
 *
 * A protected capability and one that is simply absent are therefore
 * indistinguishable from outside, which is the intended behaviour and not an
 * ergonomics problem to be fixed later.
 */
export function resolveCapability(
  runtime: ParticipantRuntime,
  capabilityId: string,
  authorized: boolean,
): CapabilityDeclaration | undefined {
  const found = runtime.collaboration.offers.find((c) => c.capabilityId === capabilityId);
  if (!found) return undefined;
  if (found.requiresAuthorization && !authorized) return undefined;
  return found;
}
