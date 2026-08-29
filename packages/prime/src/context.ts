// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema, traceContextSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Prime's execution context — what must travel with authorized work.
//
// One context, shared by both chambers. Nexus reads it to decide; Pulse stores
// it so a resumed execution resumes as the SAME work rather than as new work
// that happens to look similar.
//
// EVERY FIELD HERE IS A BOUNDARY SOMEBODY COULD OTHERWISE LOSE
//
// The test for inclusion was not "would this be useful" — it was "if this went
// missing, would a constitutional boundary quietly stop existing?" Convenience
// fields are absent because a context that carries everything is one nobody
// reads carefully.
//
// WHY TENANT IS NOT SIMPLY REQUIRED
//
// Some work genuinely belongs to no tenant: a maintenance sweep, a Foundry
// mission. Making `tenant` required would force those callers to invent one,
// and an invented tenant is worse than an absent one — it is an absent one
// wearing a real tenant's name.
//
// So the choice is explicit instead. Either a tenant is named, or the caller
// states `systemScoped: true` and says why. What is refused is the third case:
// silence. This is the same shape `hiveMessage` already uses and MC-01 already
// tests — "no tenant on the envelope means no write."
//
// PRIME PROPAGATES AUTHORITY. IT DOES NOT MINT IT.
//
// `authorizationRef` names the decision that permitted this work. Prime cannot
// fill it in for a caller who has not got one, because the only honest value
// for "authorized by nothing" is a refusal.
// ─────────────────────────────────────────────────────────────────────────────

export const primeExecutionContextSchema = z
  .object({
    /** This run. Stable across every step, retry and recovery of one execution. */
    executionId: z.string().min(1),
    /** Which workflow definition is being run. */
    workflowType: z.string().min(1),
    /** The step being considered. Absent before the first step is chosen. */
    stepId: z.string().min(1).optional(),

    /** Whose work this is. Absent only when `systemScoped` is true. */
    tenant: tenantContextSchema.optional(),
    /**
     * Declares that this execution belongs to no tenant.
     *
     * Required to be explicit. A caller that simply omits `tenant` is refused,
     * because "I forgot" and "this is a system sweep" must not look identical
     * at the boundary that decides who may read what.
     */
    systemScoped: z.boolean().default(false),

    /** Who or what is acting. Never inferred from the tenant. */
    actor: z
      .object({
        kind: z.enum(["human", "system", "engine", "agent"]),
        id: z.string().min(1),
      })
      .strict(),

    /**
     * The decision that authorized this work.
     *
     * Prime does not create authority (Charter §13) and cannot supply this for
     * a caller who lacks one. Optional in the type ONLY because a step may be
     * unauthorized-and-refused; `requireAuthorization` is what enforces its
     * presence at the point progression would occur.
     */
    authorizationRef: z.string().min(1).optional(),

    /** The Foundry mission this runs under, when it runs under one. */
    missionId: z.string().min(1).optional(),

    /** Correlation and causation. A wrong answer nobody can trace is a rumour. */
    trace: traceContextSchema,

    /**
     * The canonical operation identity, where the work has one.
     *
     * Propagated, never generated. MIS-E2E03 put idempotency in the engines
     * that own the effect; Prime's job is to carry the key across the hop so
     * a retry reaches the same claim rather than a fresh one.
     */
    idempotencyKey: z.string().min(1).optional(),

    /** The charter version this execution is governed by, for later audit. */
    charterVersion: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => c.systemScoped || c.tenant !== undefined, {
    message:
      "An execution must either name a tenant or declare itself systemScoped. " +
      "Omitting both is refused: a missing tenant and a deliberately absent one must not look the same.",
    path: ["tenant"],
  })
  .refine((c) => !(c.systemScoped && c.tenant !== undefined), {
    message:
      "An execution that is systemScoped must not also name a tenant. Both together means one of them is not true.",
    path: ["systemScoped"],
  });

export type PrimeExecutionContext = z.infer<typeof primeExecutionContextSchema>;

/**
 * The scope key an execution's state is filed under.
 *
 * Derived, never supplied. A caller that passed its own scope key could pass
 * another tenant's — this is the function MC-12's lesson applies to, one layer
 * down: the boundary is computed from identity, not accepted from the reader.
 */
export function scopeKeyOf(context: PrimeExecutionContext): string {
  return context.systemScoped ? "system" : `tenant:${context.tenant!.organizationId}`;
}

/**
 * Whether two contexts describe the same execution, for the same owner.
 *
 * Used before resuming: an execution id alone is not enough, because ids are
 * guessable and a resumed execution must belong to whoever started it.
 */
export function sameExecution(a: PrimeExecutionContext, b: PrimeExecutionContext): boolean {
  return a.executionId === b.executionId && scopeKeyOf(a) === scopeKeyOf(b);
}
