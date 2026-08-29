// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";
import { schedulingClassSchema, type SchedulingClass } from "./scheduling.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN INSTANCE MAY STILL DO WHEN THINGS ARE BROKEN.
//
// Designing for partial failure means naming the partial states, because the
// alternative is one boolean — up or down — and a system with one boolean does
// the most drastic available thing the moment anything goes wrong.
//
// NOT `connectivitySchema` IN sync.ts
//
// That one is `online | offline | reconnecting` and describes a SHOP CLIENT's
// link to its host: a tablet in a workshop with patchy wifi, queuing its work
// locally. This describes an INSTANCE's relationship to the collective and to
// its own dependencies. A tablet going offline is routine; an instance
// entering SAFE MODE is an incident. Merging them would put those two through
// one code path.
//
// THE ASYMMETRY THAT MATTERS
//
// Degrading is automatic. Recovering is not. Anything may push an instance
// down the modes — a failed dependency, a partition, a Sentinel finding — and
// nothing pushes it back up on its own except through RECOVERY, which has to
// reconcile first. Leaving SAFE MODE requires a named human.
//
// That is deliberately inconvenient. An automatic return to NORMAL is a system
// that resolves its own incidents, and the failure mode is a partition that
// flaps: isolate, rejoin, overwrite, isolate again, each cycle writing stale
// state over fresh.
// ─────────────────────────────────────────────────────────────────────────────

export const operatingModeSchema = z.enum([
  /** Full local and collective connectivity. Everything runs. */
  "NORMAL",
  /** Some dependencies are unavailable. Safe local work continues. */
  "DEGRADED",
  /**
   * Disconnected from the collective.
   *
   * Local work continues and contributions QUEUE rather than fail. No
   * collective writes — not because they would error, but because an isolated
   * instance cannot know what the collective has learned since, and writing
   * into that gap is how stale state gets promoted as current.
   */
  "ISOLATED",
  /**
   * Only constitutional/safety work and explicitly approved critical
   * operations continue.
   *
   * The mode an instance enters when it cannot trust itself.
   */
  "SAFE_MODE",
  /**
   * Reconciling queues, versions, trust and the ledger before returning.
   *
   * A mandatory station on the way back, never a state to linger in. An
   * instance that rejoined without reconciling would be one whose first act on
   * return is to overwrite whatever changed while it was away.
   */
  "RECOVERY",
]);
export type OperatingMode = z.infer<typeof operatingModeSchema>;

/**
 * Whether an instance in this mode may write to the collective.
 *
 * Only NORMAL. DEGRADED is excluded deliberately and it is the least obvious
 * one: a partially broken instance can still reach the collective, which makes
 * it exactly the instance most able to publish a conclusion it drew from
 * incomplete local data.
 */
export function mayWriteToCollective(mode: OperatingMode): boolean {
  return mode === "NORMAL";
}

/**
 * Which scheduling classes still run in this mode.
 *
 * Expressed in Phase 4's vocabulary rather than a second one. Two ladders —
 * one for capacity pressure, one for operating mode — that named their
 * priorities differently would eventually disagree about what "critical" means.
 */
export function classesRunningIn(mode: OperatingMode): readonly SchedulingClass[] {
  const all = schedulingClassSchema.options;
  switch (mode) {
    case "NORMAL":
      return all;
    case "DEGRADED":
      return all.filter((c) => c !== "P4_EVOLUTION");
    case "ISOLATED":
      // Evolution and background stop: both are the classes most likely to
      // want the collective, and neither is what the shop is waiting on.
      return all.filter((c) => c !== "P4_EVOLUTION" && c !== "P3_BACKGROUND");
    case "SAFE_MODE":
      return ["P0_CONSTITUTIONAL", "P1_CRITICAL"];
    case "RECOVERY":
      // Safety only. Reconciliation is happening underneath, and admitting
      // ordinary production on top of a half-reconciled state is how a
      // recovery becomes the next incident.
      return ["P0_CONSTITUTIONAL"];
  }
}

/**
 * Whether a transition may happen without a human.
 *
 * Downward — toward more restriction — always. Upward, only into RECOVERY,
 * and only RECOVERY may reach NORMAL. Leaving SAFE_MODE needs a person
 * whatever the destination.
 */
export function transitionNeedsHuman(from: OperatingMode, to: OperatingMode): boolean {
  if (from === to) return false;
  if (from === "SAFE_MODE") return true;
  return to === "NORMAL";
}

/**
 * Transitions that are structurally impossible, whoever asks.
 *
 * RECOVERY is NOT a rung on the severity ladder, and treating it as one was a
 * real defect before three tests caught it: ordering it below ISOLATED made
 * `ISOLATED -> RECOVERY` look like a further degradation, which skipped the
 * reconciliation gate entirely.
 *
 * It is a transitional state you ENTER in order to reconcile. Requiring a
 * passed reconciliation to get into it would be backwards — reconciling is
 * what happens inside. The gate belongs on the way OUT.
 */
export function transitionIsPermitted(from: OperatingMode, to: OperatingMode): boolean {
  if (from === to) return true;
  // The only door into NORMAL is through RECOVERY. An instance that could go
  // straight from ISOLATED to NORMAL would rejoin without reconciling, and its
  // first act on return would be to overwrite whatever changed while it was
  // away.
  if (to === "NORMAL") return from === "RECOVERY";
  // Nothing degrades INTO recovery. Recovery is entered deliberately, by
  // something that intends to come back.
  if (from === "NORMAL" && to === "RECOVERY") return false;
  return true;
}

/**
 * Whether leaving this mode requires reconciliation to have passed.
 *
 * Only RECOVERY. Every other upward move goes THROUGH recovery, so this is the
 * single place the check has to hold.
 */
export function exitRequiresReconciliation(from: OperatingMode): boolean {
  return from === "RECOVERY";
}

/**
 * What a tenant's data costs to lose, and how long it may be gone.
 *
 * RPO is how much data a restore may lose; RTO is how long the restore may
 * take. Both are per data class, because one number for a whole system is
 * always wrong in one direction: set by the most critical data it is
 * unaffordable, set by the least it is negligent.
 */
export const recoveryTierSchema = z
  .object({
    dataClass: z.string().min(1),
    /** Maximum acceptable data loss. 0 means none is acceptable. */
    rpoSeconds: z.number().int().nonnegative(),
    /** Maximum acceptable time to restore. */
    rtoSeconds: z.number().int().nonnegative(),
    /**
     * Whether a restore has ever been TESTED for this class.
     *
     * A backup nobody has restored is a hypothesis. `false` is not a
     * configuration error — it is an honest statement, and the point of
     * recording it is that an untested tier can be reported rather than
     * assumed working on the day it matters.
     */
    restoreTested: z.boolean(),
    lastRestoreTestAt: z.string().min(1).optional(),
  })
  .strict()
  .refine((t) => !t.restoreTested || Boolean(t.lastRestoreTestAt), {
    message:
      "A tier claiming its restore is tested must say when. An untimestamped claim ages into a false one, and nobody notices because the field still says true.",
    path: ["lastRestoreTestAt"],
  });
export type RecoveryTier = z.infer<typeof recoveryTierSchema>;

/**
 * A contribution an isolated instance could not send.
 *
 * Queued, never dropped. The alternative — failing the write — would make
 * isolation lose work rather than defer it, and a shop would learn about the
 * partition by finding a gap in its history.
 */
export const queuedContributionSchema = z
  .object({
    contributionId: identifierSchema,
    globalInstanceId: identifierSchema,
    kind: z.string().min(1),
    /** A reference to what is being contributed. Never the payload. */
    reference: z.string().min(1),
    queuedAt: z.string().min(1),
  })
  .strict();
export type QueuedContribution = z.infer<typeof queuedContributionSchema>;

/**
 * Whether an incoming collective record may overwrite local state.
 *
 * The rule the directive states as "do not replay stale collective knowledge
 * over newer tenant-local authoritative state", which is the specific way a
 * rejoin destroys data: the instance was away, the collective's copy is older
 * than what the shop has been doing locally, and reconciliation cheerfully
 * writes it back.
 *
 * Local wins ties. Two records with the same timestamp are not distinguishable
 * by recency, and the tenant's own record is the one the tenant can see and
 * correct.
 */
export function collectiveMayOverwriteLocal(input: {
  collectiveUpdatedAt: string;
  localUpdatedAt: string;
}): boolean {
  const collective = Date.parse(input.collectiveUpdatedAt);
  const local = Date.parse(input.localUpdatedAt);
  // An unparseable timestamp on either side means recency cannot be
  // established, and an overwrite that cannot justify itself does not happen.
  //
  // Honest note, because a mutation showed this guard is not load-bearing:
  // every comparison against NaN is already false, so deleting it changes no
  // behaviour today. It stays as a stated rule rather than an accident of
  // IEEE-754 — a later refactor to `!(local >= collective)` would invert the
  // NaN case silently, and this line is what such a change has to argue with.
  if (Number.isNaN(collective) || Number.isNaN(local)) return false;
  return collective > local;
}

/**
 * Whether recovery may create authority that was not there before.
 *
 * Always false, and it is the sentence the whole failure architecture is built
 * around: "never use recovery as a path to bypass authority." Recovery is the
 * moment when the usual checks feel like obstacles and somebody is under
 * pressure, which is exactly when a bypass gets added and never removed.
 */
export function recoveryCreatesAuthority(): false {
  return false;
}
