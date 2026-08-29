// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAY RUN, GIVEN WHAT IS LEFT.
//
// A different question from every other gate in this system, and the confusion
// between them is the thing this file has to prevent:
//
//   GOVERNANCE       may this happen at all?
//   ADMISSION        who is asking, and do they hold a grant?
//   CAPACITY         is there room, and is this important enough to have it?
//
// Passing the capacity gate authorizes NOTHING. A rollback that fits in the
// reserved pool is a rollback that has room, not one that has permission. And
// running out of capacity is not a denial: a refusal from Governance is
// permanent and a refusal here is "not now", which is why they must never be
// reported through the same channel — a caller that retries a Governance
// denial is hammering a wall, and a caller that gives up on a capacity defer
// has dropped work that was going to be fine.
//
// NOT `resources-core`
//
// That models the shop floor: machines, materials, the physical things a job
// consumes. This models the RUNTIME: CPU, tokens, connections, money. They
// share a word and nothing else, and merging them would put "is the laser
// free?" and "are we over our model budget?" behind one answer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What can run out.
 *
 * A closed set, because a dimension nobody declared is a dimension nobody
 * budgeted, and the first time it runs out will be in production.
 */
export const resourceDimensionSchema = z.enum([
  "cpu",
  "memory",
  "gpu",
  "db_connections",
  "event_throughput",
  "storage",
  "network_egress",
  /** A third party's rate limit. Exhausting it is not recoverable by scaling. */
  "external_api_quota",
  "ai_tokens",
  /** Money. Kept separate from tokens: cheap models make the two diverge. */
  "ai_spend",
]);
export type ResourceDimension = z.infer<typeof resourceDimensionSchema>;

/**
 * How much a class of work matters, in the order it matters.
 *
 * Ordered deliberately — the numeric suffix is the priority and the enum's
 * order matches it, so a comparison never depends on somebody remembering
 * which end is more important.
 */
export const schedulingClassSchema = z.enum([
  /**
   * Constitutional and safety work: rollbacks, containment, revocations.
   *
   * Has RESERVED capacity that nothing else may consume, and is never
   * preempted. A safety action that cannot run because a report was generating
   * is the failure this whole file exists to prevent.
   */
  "P0_CONSTITUTIONAL",
  /** Production operations a shop is waiting on. */
  "P1_CRITICAL",
  /** A person is looking at the screen. Latency matters more than throughput. */
  "P2_INTERACTIVE",
  /** Sweeps, projections, reports. Best effort. */
  "P3_BACKGROUND",
  /** Foundry missions, experiments. Explicit budget, highly preemptible. */
  "P4_EVOLUTION",
]);
export type SchedulingClass = z.infer<typeof schedulingClassSchema>;

const CLASS_ORDER: readonly SchedulingClass[] = schedulingClassSchema.options;

/** Lower number is more important. P0 is 0. */
export function priorityOf(cls: SchedulingClass): number {
  return CLASS_ORDER.indexOf(cls);
}

/**
 * Whether `preemptor` may take capacity from `victim`.
 *
 * The table, exactly: P0 may preempt P2-P4, P1 may preempt P3-P4, P2 has
 * limited preemption (P4 only), P3 and P4 preempt nothing.
 *
 * P1 may NOT be preempted by P0 — deliberately, and it is the least obvious
 * row. A safety action interrupting production mid-effect can leave the shop
 * in a state nobody chose, which is a different kind of unsafe. P0 has reserved
 * capacity precisely so it does not need to take P1's.
 */
export function mayPreempt(preemptor: SchedulingClass, victim: SchedulingClass): boolean {
  if (preemptor === "P0_CONSTITUTIONAL") return priorityOf(victim) >= priorityOf("P2_INTERACTIVE");
  if (preemptor === "P1_CRITICAL") return priorityOf(victim) >= priorityOf("P3_BACKGROUND");
  if (preemptor === "P2_INTERACTIVE") return victim === "P4_EVOLUTION";
  return false;
}

/** Work that has not started, asking whether it may. */
export const workRequestSchema = z
  .object({
    workId: identifierSchema,
    schedulingClass: schedulingClassSchema,
    /**
     * Whose work. Absent only for genuinely instance-wide work.
     *
     * Fair-share is per tenant, so work with no tenant is work outside the
     * fairness calculation — which is correct for a system sweep and wrong for
     * anything a customer triggered.
     */
    tenantId: z.string().min(1).optional(),
    /** How much of what it needs. Unlisted dimensions are not consumed. */
    demand: z.record(resourceDimensionSchema, z.number().nonnegative()).default({}),
    /**
     * The most this may spend. REQUIRED for P4.
     *
     * Evolution work is the class most able to spend without bound — an agent
     * in a loop calling a model — and the one least able to say when it is
     * done. A budget it must declare up front is the only cap that binds
     * before the money is gone.
     */
    spendCeiling: z.number().nonnegative().optional(),
    /** Why this is running, for the record when it is deferred. */
    purpose: z.string().min(1),
  })
  .strict()
  .refine((w) => w.schedulingClass !== "P4_EVOLUTION" || w.spendCeiling !== undefined, {
    message:
      "P4 evolution work must declare a spend ceiling. It is the class most able to spend without bound and least able to say when it is finished, and a cap applied afterwards is a report rather than a limit.",
    path: ["spendCeiling"],
  });
export type WorkRequest = z.infer<typeof workRequestSchema>;

/**
 * The answer.
 *
 * `deferred` and `rejected` are different and the difference is the caller's
 * next move: deferred work should be retried, rejected work never will fit and
 * retrying it is a loop.
 */
export type CapacityVerdict =
  | { readonly outcome: "admitted"; readonly reason: string; readonly reservationId: string }
  | { readonly outcome: "deferred"; readonly reason: string; readonly retryAfterMs: number }
  | { readonly outcome: "rejected"; readonly reason: string };

/**
 * How degraded the system currently is.
 *
 * A ladder rather than a boolean, because the responses are different at each
 * rung and collapsing them means doing the most drastic thing first.
 */
export const degradationLevelSchema = z.enum([
  /** Everything runs. */
  "normal",
  /** P4 deferred. */
  "defer_evolution",
  /** P4 and P3 deferred; background batched. */
  "defer_background",
  /** Serve cached knowledge; route to cheaper models. */
  "conserve",
  /** Optional analytics and enrichment suspended. */
  "shed_optional",
  /** P0 and P1 only. Continuity rules active. */
  "protect_critical",
]);
export type DegradationLevel = z.infer<typeof degradationLevelSchema>;

const LADDER: readonly DegradationLevel[] = degradationLevelSchema.options;

export function degradationRung(level: DegradationLevel): number {
  return LADDER.indexOf(level);
}

/**
 * Which classes still run at a given rung.
 *
 * P0 and P1 appear at every level including the last. A ladder whose bottom
 * rung stopped safety work would be a system that protects itself by becoming
 * unable to protect anything.
 */
export function admissibleAt(level: DegradationLevel): readonly SchedulingClass[] {
  switch (level) {
    case "normal":
      return CLASS_ORDER;
    case "defer_evolution":
      return CLASS_ORDER.filter((c) => c !== "P4_EVOLUTION");
    case "defer_background":
    case "conserve":
    case "shed_optional":
      return CLASS_ORDER.filter(
        (c) => c !== "P4_EVOLUTION" && c !== "P3_BACKGROUND",
      );
    case "protect_critical":
      return ["P0_CONSTITUTIONAL", "P1_CRITICAL"];
  }
}

/**
 * Whether reaching a capacity limit is an authorization decision.
 *
 * Always false. The seventeenth of these, and this one guards a confusion that
 * would be actively dangerous in both directions: capacity reported as denial
 * makes a transient shortage look like a policy refusal, and denial reported as
 * capacity makes a policy refusal look like something worth retrying.
 */
export function capacityLimitIsDenial(): false {
  return false;
}
