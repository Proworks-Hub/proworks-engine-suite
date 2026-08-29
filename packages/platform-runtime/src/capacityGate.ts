// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  admissibleAt,
  degradationRung,
  mayPreempt,
  priorityOf,
  workRequestSchema,
  type CapacityVerdict,
  type DegradationLevel,
  type InstanceIdentity,
  type ResourceDimension,
  type SchedulingClass,
  type WorkRequest,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The capacity gate.
//
// Answers one question — is there room, and is this important enough to have it
// — and answers nothing else. It does not authorize; `createInstanceAdmission`
// does that, and the two are deliberately named apart because they both stand
// in front of work and mean opposite things when they say no.
//
// THE RESERVE IS THE POINT
//
// Every other mechanism here is ordinary scheduling. The reserve is the one
// that earns the file: a fraction of every dimension that only P0 may touch,
// checked before anything else and never lent out. A system under load will
// consume everything available, and "available" must therefore be smaller than
// "everything" — otherwise the moment you need to revoke a credential or roll
// back a bad release is precisely the moment there is no room to do it.
//
// PREEMPTION IS BOOKKEEPING, NOT KILLING
//
// `request` can reclaim capacity from lower classes, and what that means here
// is that their reservations are released. This gate does not stop anybody's
// process — it cannot, and pretending otherwise would be a lie in the return
// type. What it does is stop counting their capacity as spent, and report which
// reservations were reclaimed so the caller can act on its own work. A caller
// that ignores the list has overcommitted, knowingly.
//
// BUDGETS BIND AT RESERVATION, NOT AT COMPLETION
//
// Spend is charged when work is admitted and reconciled when it finishes. A
// budget checked only on completion cannot stop the runaway case it exists for
// — an agent looping on model calls never completes, so it would never be
// charged, and the cap would be a report written after the money was gone.
// ─────────────────────────────────────────────────────────────────────────────

export interface CapacityPolicy {
  /** Total of each dimension. Dimensions absent here are unlimited. */
  readonly limits: Partial<Record<ResourceDimension, number>>;
  /**
   * The share of each limit that only P0 may consume, 0..1.
   *
   * Defaults to 0.1. Not zero: a default of zero would make the reserve
   * something a host has to remember to configure, and the failure mode of
   * forgetting is invisible until an incident.
   */
  readonly constitutionalReserve?: number;
  /**
   * The share of the non-reserved pool any ONE tenant may hold, 0..1.
   *
   * Defaults to 0.5. Fair-share rather than equal-share: with two tenants an
   * equal split wastes half the capacity whenever one is idle.
   */
  readonly tenantShare?: number;
  /**
   * Burst above the fair share, and how fast it comes back.
   *
   * Tokens decay rather than refill instantly, so a tenant that bursts cannot
   * burst again immediately — which is the difference between absorbing a
   * spike and having no limit at all.
   */
  readonly burstTokens?: number;
  readonly burstRefillPerSecond?: number;
  /** Utilisation at which the ladder steps down. Default 0.85. */
  readonly degradeAbove?: number;
  /**
   * Utilisation at which it steps back up. Default 0.65.
   *
   * Deliberately BELOW `degradeAbove`. Recovering at the same threshold that
   * triggered degradation makes the system flap: it recovers, immediately
   * exceeds the threshold again, degrades, and the ladder becomes a
   * oscillator. The gap is hysteresis and it is not optional.
   */
  readonly recoverBelow?: number;
  /** Spend ceilings per tenant. */
  readonly tenantSpendCeiling?: number;
}

export interface Reservation {
  readonly reservationId: string;
  readonly workId: string;
  readonly schedulingClass: SchedulingClass;
  readonly tenantId: string | null;
  readonly demand: Partial<Record<ResourceDimension, number>>;
  readonly spendCharged: number;
  readonly reservedAt: string;
}

export interface CapacityGate {
  readonly instance: InstanceIdentity;

  /**
   * Asks for room.
   *
   * Never throws, and never returns a bare boolean: `deferred` and `rejected`
   * mean different things to the caller, and a boolean would collapse them.
   */
  request(input: unknown): CapacityVerdict & { readonly preempted?: readonly string[] };

  /** Gives it back, reconciling actual spend against what was charged. */
  release(reservationId: string, actualSpend?: number): { released: boolean; reason: string };

  /** Where on the ladder the system currently is. */
  degradation(): DegradationLevel;

  /** 0..1 per dimension, against the non-reserved pool. */
  pressure(): Partial<Record<ResourceDimension, number>>;

  /** What is currently held. For an operator asking where the capacity went. */
  reservations(): readonly Reservation[];

  /** What a tenant has spent. */
  spentBy(tenantId: string): number;
}

export interface CapacityGateOptions {
  readonly instance: InstanceIdentity;
  readonly policy: CapacityPolicy;
  readonly now?: () => Date;
  /** Every verdict, so deferrals and preemptions are observable rather than silent. */
  readonly onVerdict?: (verdict: CapacityVerdict, request: WorkRequest) => void;
}

const DIMENSIONS_OF = (d: Partial<Record<ResourceDimension, number>>) =>
  Object.entries(d) as [ResourceDimension, number][];

export function createCapacityGate(options: CapacityGateOptions): CapacityGate {
  const now = options.now ?? (() => new Date());
  const p = options.policy;
  const reservePart = p.constitutionalReserve ?? 0.1;
  const tenantShare = p.tenantShare ?? 0.5;
  const burstMax = p.burstTokens ?? 0;
  const refillPerSecond = p.burstRefillPerSecond ?? 0;
  const degradeAbove = p.degradeAbove ?? 0.85;
  const recoverBelow = p.recoverBelow ?? 0.65;

  const held = new Map<string, Reservation>();
  const spendByTenant = new Map<string, number>();
  const burst = new Map<string, { tokens: number; at: number }>();
  let level: DegradationLevel = "normal";
  let counter = 0;

  const limitOf = (d: ResourceDimension): number => p.limits[d] ?? Number.POSITIVE_INFINITY;

  /** What is available to everything EXCEPT P0. The reserve is carved out here. */
  const generalLimit = (d: ResourceDimension): number => {
    const total = limitOf(d);
    return total === Number.POSITIVE_INFINITY ? total : total * (1 - reservePart);
  };

  const usedIn = (d: ResourceDimension, filter?: (r: Reservation) => boolean): number => {
    let sum = 0;
    for (const r of held.values()) {
      if (filter && !filter(r)) continue;
      sum += r.demand[d] ?? 0;
    }
    return sum;
  };

  const burstTokensFor = (tenantId: string): number => {
    const at = now().getTime();
    const entry = burst.get(tenantId);
    if (!entry) {
      burst.set(tenantId, { tokens: burstMax, at });
      return burstMax;
    }
    // Decay back toward full over time. Instantaneous refill would make the
    // burst allowance a permanent extension of the share rather than a way to
    // absorb one spike.
    const elapsedSeconds = Math.max(0, (at - entry.at) / 1000);
    const tokens = Math.min(burstMax, entry.tokens + elapsedSeconds * refillPerSecond);
    burst.set(tenantId, { tokens, at });
    return tokens;
  };

  const recomputeLevel = (): void => {
    const worst = Math.max(
      0,
      ...DIMENSIONS_OF(p.limits).map(([d]) => {
        const general = generalLimit(d);
        if (general === Number.POSITIVE_INFINITY || general === 0) return 0;
        return usedIn(d, (r) => r.schedulingClass !== "P0_CONSTITUTIONAL") / general;
      }),
    );

    const rung = degradationRung(level);
    if (worst > degradeAbove && rung < degradationRung("protect_critical")) {
      level = (["normal", "defer_evolution", "defer_background", "conserve", "shed_optional", "protect_critical"] as const)[
        rung + 1
      ]!;
    } else if (worst < recoverBelow && rung > 0) {
      // Automatic recovery, one rung at a time. Jumping straight to normal
      // would return every class at once into capacity that had just been
      // exhausted, which is how a recovery becomes the next incident.
      level = (["normal", "defer_evolution", "defer_background", "conserve", "shed_optional", "protect_critical"] as const)[
        rung - 1
      ]!;
    }
  };

  const report = (v: CapacityVerdict, w: WorkRequest): CapacityVerdict => {
    options.onVerdict?.(v, w);
    return v;
  };

  return {
    instance: options.instance,

    request(input) {
      const parsed = workRequestSchema.safeParse(input);
      if (!parsed.success) {
        // Malformed work is rejected, not deferred: retrying it will never
        // make it parse.
        return {
          outcome: "rejected",
          reason: `Not a valid work request: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }
      const work = parsed.data;
      const cls = work.schedulingClass;
      const tenantId = work.tenantId ?? null;

      // ── The ladder ────────────────────────────────────────────────────
      //
      // Checked before capacity arithmetic, because a class the current rung
      // has stopped admitting should be told that rather than being told there
      // is no room — the fix for one is to wait and the fix for the other may
      // be to ask for less.
      if (!admissibleAt(level).includes(cls)) {
        return report(
          {
            outcome: "deferred",
            reason: `The system is at "${level}" and ${cls} work is not admitted at that rung.`,
            retryAfterMs: 5_000 * (degradationRung(level) + 1),
          },
          work,
        );
      }

      // ── Budgets ───────────────────────────────────────────────────────
      //
      // Charged at reservation. A ceiling checked on completion cannot stop
      // the case it exists for: an agent looping on model calls never
      // completes, so it would never be charged.
      const spend = work.demand["ai_spend"] ?? 0;
      if (work.spendCeiling !== undefined && spend > work.spendCeiling) {
        return report(
          {
            outcome: "rejected",
            reason: `This work asks to spend ${spend} against its own declared ceiling of ${work.spendCeiling}.`,
          },
          work,
        );
      }
      if (tenantId && p.tenantSpendCeiling !== undefined) {
        const already = spendByTenant.get(tenantId) ?? 0;
        if (already + spend > p.tenantSpendCeiling) {
          return report(
            {
              outcome: "rejected",
              reason:
                `Tenant ${tenantId} has spent ${already} of a ${p.tenantSpendCeiling} ceiling and this asks ` +
                `for ${spend} more. Rejected rather than deferred: waiting does not make a budget larger.`,
            },
            work,
          );
        }
      }

      // ── The constitutional reserve ────────────────────────────────────
      //
      // P0 measures against the FULL limit; everything else measures against
      // the limit minus the reserve. That single difference is what keeps a
      // rollback runnable while the system is otherwise full.
      const isP0 = cls === "P0_CONSTITUTIONAL";
      const preempted: string[] = [];

      for (const [dim, want] of DIMENSIONS_OF(work.demand)) {
        if (dim === "ai_spend") continue;
        const ceiling = isP0 ? limitOf(dim) : generalLimit(dim);
        if (ceiling === Number.POSITIVE_INFINITY) continue;

        let used = isP0 ? usedIn(dim) : usedIn(dim, (r) => r.schedulingClass !== "P0_CONSTITUTIONAL");

        if (used + want > ceiling) {
          // ── Preemption ─────────────────────────────────────────────────
          //
          // Reclaim from classes this one outranks, lowest priority first, and
          // only as much as is needed. Taking more than required would evict
          // work for nothing.
          const victims = [...held.values()]
            .filter((r) => mayPreempt(cls, r.schedulingClass) && (r.demand[dim] ?? 0) > 0)
            .sort((a, b) => priorityOf(b.schedulingClass) - priorityOf(a.schedulingClass));

          for (const victim of victims) {
            if (used + want <= ceiling) break;
            held.delete(victim.reservationId);
            preempted.push(victim.reservationId);
            used -= victim.demand[dim] ?? 0;
          }

          if (used + want > ceiling) {
            return report(
              {
                outcome: "deferred",
                reason:
                  `Not enough ${dim}: ${used} of ${ceiling} is held and this needs ${want}.` +
                  (isP0 ? "" : " The constitutional reserve is not available to this class."),
                retryAfterMs: 1_000,
              },
              work,
            );
          }
        }

        // ── Fair share and burst ───────────────────────────────────────
        //
        // Applied only to tenant work, and never to P0: a tenant's safety
        // action is the Hive's safety action, and throttling it to protect
        // another tenant's throughput would be protecting the wrong thing.
        if (tenantId && !isP0) {
          const share = generalLimit(dim) * tenantShare;
          if (share !== Number.POSITIVE_INFINITY) {
            const mine = usedIn(dim, (r) => r.tenantId === tenantId);
            if (mine + want > share) {
              const over = mine + want - share;
              const tokens = burstTokensFor(tenantId);
              if (tokens < over) {
                return report(
                  {
                    outcome: "deferred",
                    reason:
                      `Tenant ${tenantId} holds ${mine} of a ${share} fair share for ${dim} and has ` +
                      `${tokens.toFixed(1)} burst tokens against ${over.toFixed(1)} needed. One tenant does not ` +
                      "get to starve another.",
                    retryAfterMs: 2_000,
                  },
                  work,
                );
              }
              burst.set(tenantId, { tokens: tokens - over, at: now().getTime() });
            }
          }
        }
      }

      counter += 1;
      const reservationId = `res_${counter}`;
      held.set(reservationId, {
        reservationId,
        workId: work.workId,
        schedulingClass: cls,
        tenantId,
        demand: work.demand,
        spendCharged: spend,
        reservedAt: now().toISOString(),
      });
      if (tenantId && spend > 0) {
        spendByTenant.set(tenantId, (spendByTenant.get(tenantId) ?? 0) + spend);
      }

      recomputeLevel();
      const verdict = report(
        { outcome: "admitted", reason: `${cls} work admitted.`, reservationId },
        work,
      );
      return preempted.length > 0 ? { ...verdict, preempted } : verdict;
    },

    release(reservationId, actualSpend) {
      const reservation = held.get(reservationId);
      if (!reservation) return { released: false, reason: `No reservation ${reservationId}.` };

      held.delete(reservationId);

      // Reconcile. Work that spent less than reserved gives the difference
      // back; work that spent MORE is charged the difference, because the
      // alternative is a ceiling that only holds when estimates were accurate.
      if (actualSpend !== undefined && reservation.tenantId) {
        const delta = actualSpend - reservation.spendCharged;
        const current = spendByTenant.get(reservation.tenantId) ?? 0;
        spendByTenant.set(reservation.tenantId, Math.max(0, current + delta));
      }

      recomputeLevel();
      return { released: true, reason: `Released ${reservationId}.` };
    },

    degradation: () => level,

    pressure() {
      const out: Partial<Record<ResourceDimension, number>> = {};
      for (const [dim] of DIMENSIONS_OF(p.limits)) {
        const general = generalLimit(dim);
        out[dim] =
          general === Number.POSITIVE_INFINITY || general === 0
            ? 0
            : usedIn(dim, (r) => r.schedulingClass !== "P0_CONSTITUTIONAL") / general;
      }
      return out;
    },

    reservations: () => [...held.values()],
    spentBy: (tenantId) => spendByTenant.get(tenantId) ?? 0,
  };
}

/**
 * Whether admitting work through the capacity gate authorizes it.
 *
 * Always false. The eighteenth, and the one most likely to be assumed rather
 * than argued: a gate that stands in front of work and says yes looks exactly
 * like permission. It is room.
 */
export function capacityAdmissionGrantsAuthority(): false {
  return false;
}
