// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  admissibleAt,
  capacityLimitIsDenial,
  mayPreempt,
  workRequestSchema,
} from "@proworks-hub/contracts";
import {
  capacityAdmissionGrantsAuthority,
  createCapacityGate,
  type CapacityPolicy,
} from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — resource management and scheduling.
//
// The six acceptance tests the directive names:
//
//   1. A P0 rollback executes during artificial resource exhaustion.
//   2. P4 Foundry workloads yield to P1 production.
//   3. One tenant cannot starve another on shared services.
//   4. A budget cap prevents runaway model spend.
//   5. Backpressure does not lose critical events.
//   6. Degradation returns automatically toward normal.
//
// The organising distinction, which the last group attacks directly: CAPACITY
// IS NOT AUTHORIZATION. Running out of room is "not now"; a Governance refusal
// is "no". A caller that confuses them either hammers a wall forever or drops
// work that was going to be fine.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = { globalInstanceId: "hive.instance.a", provisional: false };

let clock = new Date("2026-08-29T12:00:00.000Z").getTime();
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
};

const gate = (policy: Partial<CapacityPolicy> = {}) =>
  createCapacityGate({
    instance: INSTANCE,
    now,
    policy: {
      // 100 units of CPU. With a 10% reserve, 90 are available to everything
      // that is not P0.
      limits: { cpu: 100, ai_spend: 1_000 },
      constitutionalReserve: 0.1,
      tenantShare: 0.5,
      ...policy,
    },
  });

let n = 0;
const work = (over: Record<string, unknown> = {}) => ({
  workId: `w_${(n += 1)}`,
  schedulingClass: "P2_INTERACTIVE",
  purpose: "test",
  demand: { cpu: 10 },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE RESERVE
// ─────────────────────────────────────────────────────────────────────────────

describe("a P0 safety action runs when everything else cannot", () => {
  it("admits a rollback while the general pool is exhausted", () => {
    // The test this whole file exists for. A system under load consumes
    // everything available, so "available" must be smaller than "everything" —
    // otherwise the moment you need to roll back a bad release is exactly the
    // moment there is no room to do it.
    const g = gate();

    // Fill the general pool: 9 × 10 = 90, which is the whole non-reserved part.
    for (let i = 0; i < 9; i += 1) {
      expect(g.request(work({ schedulingClass: "P1_CRITICAL", demand: { cpu: 10 } })).outcome).toBe(
        "admitted",
      );
    }

    // P2 cannot get in. The pool is genuinely full.
    expect(g.request(work({ demand: { cpu: 5 } })).outcome).toBe("deferred");

    // The rollback does.
    const rollback = g.request(
      work({
        schedulingClass: "P0_CONSTITUTIONAL",
        purpose: "roll back a bad release",
        demand: { cpu: 10 },
      }),
    );
    expect(rollback.outcome).toBe("admitted");
  });

  it("says WHY a non-P0 class was refused, naming the reserve", () => {
    // A deferral that cannot say the reserve is the reason sends somebody to
    // add capacity they already have.
    const g = gate();
    for (let i = 0; i < 9; i += 1) g.request(work({ schedulingClass: "P1_CRITICAL" }));
    const refused = g.request(work({ demand: { cpu: 5 } }));
    expect(refused.outcome).toBe("deferred");
    if (refused.outcome !== "deferred") return;
    expect(refused.reason).toMatch(/constitutional reserve is not available/);
  });

  it("does not let the reserve be configured away silently", () => {
    // The default is 10%, not zero. A default of zero would make the reserve
    // something a host must remember, and forgetting is invisible until an
    // incident.
    const g = createCapacityGate({
      instance: INSTANCE,
      now,
      policy: { limits: { cpu: 100 } },
    });
    for (let i = 0; i < 9; i += 1) g.request(work({ schedulingClass: "P1_CRITICAL" }));
    expect(g.request(work({ demand: { cpu: 5 } })).outcome).toBe("deferred");
    expect(
      g.request(work({ schedulingClass: "P0_CONSTITUTIONAL", demand: { cpu: 5 } })).outcome,
    ).toBe("admitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PREEMPTION
// ─────────────────────────────────────────────────────────────────────────────

describe("evolution work yields to production", () => {
  it("reclaims P4 capacity for a P1 request", () => {
    const g = gate();
    const foundry = g.request(
      work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 100, demand: { cpu: 80 } }),
    );
    expect(foundry.outcome).toBe("admitted");
    if (foundry.outcome !== "admitted") return;

    const production = g.request(work({ schedulingClass: "P1_CRITICAL", demand: { cpu: 60 } }));
    expect(production.outcome).toBe("admitted");
    // Named, not silent. This gate cannot stop anybody's process — it can only
    // stop counting their capacity — so a caller that ignores this list has
    // overcommitted knowingly.
    expect(production.preempted).toContain(foundry.reservationId);
    expect(g.reservations().map((r) => r.reservationId)).not.toContain(foundry.reservationId);
  });

  it("takes only as much as it needs", () => {
    // Evicting more than required would throw away work for nothing.
    const g = gate();
    const a = g.request(work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 1, demand: { cpu: 40 } }));
    const b = g.request(work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 1, demand: { cpu: 40 } }));
    expect(a.outcome === "admitted" && b.outcome === "admitted").toBe(true);

    const critical = g.request(work({ schedulingClass: "P1_CRITICAL", demand: { cpu: 50 } }));
    expect(critical.outcome).toBe("admitted");
    if (critical.outcome !== "admitted") return;
    expect(critical.preempted).toHaveLength(1);
  });

  it("does not let P0 preempt P1", () => {
    // The least obvious row in the table, and deliberate: interrupting
    // production mid-effect can leave a shop in a state nobody chose, which is
    // its own kind of unsafe. P0 has a reserve precisely so it need not take
    // P1's capacity.
    expect(mayPreempt("P0_CONSTITUTIONAL", "P1_CRITICAL")).toBe(false);
    expect(mayPreempt("P0_CONSTITUTIONAL", "P2_INTERACTIVE")).toBe(true);
    expect(mayPreempt("P1_CRITICAL", "P2_INTERACTIVE")).toBe(false);
    expect(mayPreempt("P1_CRITICAL", "P3_BACKGROUND")).toBe(true);
    expect(mayPreempt("P2_INTERACTIVE", "P4_EVOLUTION")).toBe(true);
    expect(mayPreempt("P2_INTERACTIVE", "P3_BACKGROUND")).toBe(false);
    expect(mayPreempt("P3_BACKGROUND", "P4_EVOLUTION")).toBe(false);
    expect(mayPreempt("P4_EVOLUTION", "P4_EVOLUTION")).toBe(false);
  });

  it("does not let background work preempt anything", () => {
    const g = gate();
    g.request(work({ schedulingClass: "P2_INTERACTIVE", demand: { cpu: 85 } }));
    const sweep = g.request(work({ schedulingClass: "P3_BACKGROUND", demand: { cpu: 20 } }));
    expect(sweep.outcome).toBe("deferred");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FAIR SHARE
// ─────────────────────────────────────────────────────────────────────────────

describe("one tenant cannot starve another", () => {
  it("holds a tenant to its share of the general pool", () => {
    // 90 general, half of it is 45.
    const g = gate();
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 40 } })).outcome).toBe("admitted");
    const over = g.request(work({ tenantId: "loud", demand: { cpu: 20 } }));
    expect(over.outcome).toBe("deferred");
    if (over.outcome !== "deferred") return;
    expect(over.reason).toMatch(/does not get to starve another/);
  });

  it("leaves the quiet tenant's capacity available", () => {
    // Non-vacuity, and the actual claim: the point is not that the loud tenant
    // is throttled, it is that the quiet one can still get in.
    const g = gate();
    g.request(work({ tenantId: "loud", demand: { cpu: 40 } }));
    g.request(work({ tenantId: "loud", demand: { cpu: 20 } }));
    expect(g.request(work({ tenantId: "quiet", demand: { cpu: 40 } })).outcome).toBe("admitted");
  });

  it("allows a burst, and does not allow it twice in a row", () => {
    // Tokens decay rather than refill instantly. Instantaneous refill would
    // make the burst a permanent extension of the share.
    const g = gate({ burstTokens: 10, burstRefillPerSecond: 1 });
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 40 } })).outcome).toBe("admitted");
    // 5 over the 45 share, covered by burst tokens.
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 10 } })).outcome).toBe("admitted");
    // Now only 5 tokens remain, and the tenant is 5 over its share. Asking for
    // 1 more needs 6 tokens and there are 5.
    //
    // The margins are deliberately tight. A larger request would be refused by
    // a gate that never spent the tokens at all, and by one that refilled them
    // instantly — two mutations that both survived a coarser version of this
    // test. Only a request that fits under a FULL allowance and not under the
    // remaining one can tell the three implementations apart.
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 1 } })).outcome).toBe("deferred");
  });

  it("refills burst tokens over time", () => {
    const g = gate({ burstTokens: 10, burstRefillPerSecond: 1 });
    g.request(work({ tenantId: "loud", demand: { cpu: 40 } }));
    g.request(work({ tenantId: "loud", demand: { cpu: 10 } }));
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 10 } })).outcome).toBe("deferred");

    advance(20_000);
    // 5, not 10. The tenant still HOLDS 50 against a 45 share, so the overage
    // is measured from where they already are — asking for 10 needs 15 tokens
    // and only 10 have refilled. My first version of this test got that wrong,
    // which is the arithmetic a caller will get wrong too: burst is credit
    // against a running position, not a per-request allowance.
    expect(g.request(work({ tenantId: "loud", demand: { cpu: 5 } })).outcome).toBe("admitted");
  });

  it("never throttles a tenant's SAFETY work to protect another's throughput", () => {
    // A tenant's safety action is the Hive's safety action. Fair-share exists
    // to stop one tenant taking another's throughput, and applying it here
    // would be protecting the wrong thing.
    const g = gate();
    g.request(work({ tenantId: "loud", demand: { cpu: 40 } }));
    expect(
      g.request(
        work({ tenantId: "loud", schedulingClass: "P0_CONSTITUTIONAL", demand: { cpu: 20 } }),
      ).outcome,
    ).toBe("admitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. BUDGETS
// ─────────────────────────────────────────────────────────────────────────────

describe("a budget cap stops runaway model spend", () => {
  it("refuses P4 work with no declared ceiling", () => {
    // Evolution work is the class most able to spend without bound and least
    // able to say when it is finished. A cap applied afterwards is a report.
    expect(
      workRequestSchema.safeParse({
        workId: "w",
        schedulingClass: "P4_EVOLUTION",
        purpose: "explore",
        demand: { ai_spend: 5 },
      }).success,
    ).toBe(false);
  });

  it("refuses work that exceeds its own ceiling", () => {
    const g = gate();
    const r = g.request(
      work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 10, demand: { ai_spend: 50 } }),
    );
    expect(r.outcome).toBe("rejected");
  });

  it("stops a tenant at its ceiling, and REJECTS rather than defers", () => {
    // Waiting does not make a budget larger. A deferral would produce a caller
    // that retries forever against a limit that will never move.
    const g = gate({ tenantSpendCeiling: 100 });
    expect(
      g.request(work({ tenantId: "t", schedulingClass: "P3_BACKGROUND", demand: { ai_spend: 80 } }))
        .outcome,
    ).toBe("admitted");

    const over = g.request(
      work({ tenantId: "t", schedulingClass: "P3_BACKGROUND", demand: { ai_spend: 40 } }),
    );
    expect(over.outcome).toBe("rejected");
    if (over.outcome !== "rejected") return;
    expect(over.reason).toMatch(/waiting does not make a budget larger/i);
  });

  it("charges at reservation, not at completion", () => {
    // The runaway case: an agent looping on model calls never completes, so a
    // ceiling checked on completion would never be checked at all.
    const g = gate({ tenantSpendCeiling: 100 });
    g.request(work({ tenantId: "t", schedulingClass: "P3_BACKGROUND", demand: { ai_spend: 60 } }));
    // Nothing has been released. The spend is already counted.
    expect(g.spentBy("t")).toBe(60);
  });

  it("reconciles actual spend on release, in both directions", () => {
    const g = gate({ tenantSpendCeiling: 100 });
    const r = g.request(
      work({ tenantId: "t", schedulingClass: "P3_BACKGROUND", demand: { ai_spend: 60 } }),
    );
    expect(r.outcome).toBe("admitted");
    if (r.outcome !== "admitted") return;

    g.release(r.reservationId, 20);
    expect(g.spentBy("t")).toBe(20);

    // Overspend is charged too. A ceiling that only holds when estimates were
    // accurate is not a ceiling.
    const r2 = g.request(
      work({ tenantId: "t", schedulingClass: "P3_BACKGROUND", demand: { ai_spend: 10 } }),
    );
    expect(r2.outcome).toBe("admitted");
    if (r2.outcome !== "admitted") return;
    g.release(r2.reservationId, 50);
    // 20 from the first piece of work plus 50 from the second. Both were
    // reconciled against what they reserved rather than against each other.
    expect(g.spentBy("t")).toBe(70);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 & 6. THE LADDER
// ─────────────────────────────────────────────────────────────────────────────

describe("degradation is a ladder, and it climbs back", () => {
  it("steps down under pressure and stops admitting the lowest class first", () => {
    const g = gate({ degradeAbove: 0.5, recoverBelow: 0.3 });
    expect(g.degradation()).toBe("normal");

    g.request(work({ schedulingClass: "P2_INTERACTIVE", demand: { cpu: 60 } }));
    expect(g.degradation()).toBe("defer_evolution");

    const foundry = g.request(
      work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 1, demand: { cpu: 1 } }),
    );
    expect(foundry.outcome).toBe("deferred");
    if (foundry.outcome !== "deferred") return;
    expect(foundry.reason).toMatch(/defer_evolution/);
  });

  it("keeps P0 and P1 admissible at every rung, including the last", () => {
    // A ladder whose bottom rung stopped safety work would be a system that
    // protects itself by becoming unable to protect anything.
    expect(admissibleAt("protect_critical")).toEqual(["P0_CONSTITUTIONAL", "P1_CRITICAL"]);
    for (const level of [
      "normal",
      "defer_evolution",
      "defer_background",
      "conserve",
      "shed_optional",
      "protect_critical",
    ] as const) {
      expect(admissibleAt(level)).toContain("P0_CONSTITUTIONAL");
      expect(admissibleAt(level)).toContain("P1_CRITICAL");
    }
  });

  it("returns automatically toward normal when capacity recovers", () => {
    const g = gate({ degradeAbove: 0.5, recoverBelow: 0.3 });
    const held = g.request(work({ schedulingClass: "P2_INTERACTIVE", demand: { cpu: 60 } }));
    expect(g.degradation()).toBe("defer_evolution");
    expect(held.outcome).toBe("admitted");
    if (held.outcome !== "admitted") return;

    g.release(held.reservationId);
    expect(g.degradation()).toBe("normal");
  });

  it("recovers one rung at a time, not all at once", () => {
    // Returning every class at once into capacity that was just exhausted is
    // how a recovery becomes the next incident.
    const g = gate({ degradeAbove: 0.5, recoverBelow: 0.3 });
    const a = g.request(work({ demand: { cpu: 60 } }));
    const b = g.request(work({ schedulingClass: "P1_CRITICAL", demand: { cpu: 20 } }));
    expect(g.degradation()).toBe("defer_background");

    expect(a.outcome === "admitted" && b.outcome === "admitted").toBe(true);
    if (a.outcome !== "admitted" || b.outcome !== "admitted") return;

    g.release(a.reservationId);
    expect(g.degradation()).toBe("defer_evolution");
    g.release(b.reservationId);
    expect(g.degradation()).toBe("normal");
  });

  it("uses hysteresis, so it does not flap", () => {
    // Recovering at the same threshold that triggered degradation makes the
    // ladder an oscillator. The gap between the two is not optional.
    const g = gate({ degradeAbove: 0.5, recoverBelow: 0.3 });
    const r = g.request(work({ demand: { cpu: 40 } }));
    expect(r.outcome).toBe("admitted");
    // 40/90 = 0.44 — above the recovery threshold, below the degrade one.
    // Neither rung moves, which is the whole point.
    expect(g.degradation()).toBe("normal");
  });

  it("uses the DEFAULT thresholds with a gap between them", () => {
    // The hysteresis test above passes its thresholds explicitly, so it says
    // nothing about the defaults — and a default `recoverBelow` equal to
    // `degradeAbove` survived that test while turning the ladder into an
    // oscillator. Found by a mutation.
    //
    // 90 general. 80 held is 0.89, past the 0.85 default and into degradation.
    // Dropping to 70 is 0.78: below the degrade threshold but still above the
    // 0.65 recovery one, so nothing moves. That gap is the whole mechanism.
    const g = createCapacityGate({ instance: INSTANCE, now, policy: { limits: { cpu: 100 } } });
    const bulk = g.request(work({ demand: { cpu: 70 } }));
    const edge = g.request(work({ demand: { cpu: 10 } }));
    expect(bulk.outcome === "admitted" && edge.outcome === "admitted").toBe(true);
    if (bulk.outcome !== "admitted" || edge.outcome !== "admitted") return;
    expect(g.degradation()).toBe("defer_evolution");

    g.release(edge.reservationId);
    expect(g.degradation()).toBe("defer_evolution");

    // And it does recover once pressure genuinely falls below the lower mark.
    g.release(bulk.reservationId);
    expect(g.degradation()).toBe("normal");
  });

  it("does not lose deferred work — it says when to come back", () => {
    // Backpressure must not be a drop. A deferral carries a retry hint, which
    // is the difference between "not now" and "never".
    const g = gate({ degradeAbove: 0.5 });
    g.request(work({ demand: { cpu: 60 } }));
    const deferred = g.request(
      work({ schedulingClass: "P4_EVOLUTION", spendCeiling: 1, demand: { cpu: 1 } }),
    );
    expect(deferred.outcome).toBe("deferred");
    if (deferred.outcome !== "deferred") return;
    expect(deferred.retryAfterMs).toBeGreaterThan(0);
  });

  it("admits critical work while degraded, which is what protects the events", () => {
    // "Backpressure does not lose critical events" — the capacity half of it.
    // P0 and P1 still get in at the bottom rung, so a critical event's handler
    // is never the thing that cannot run.
    const g = gate({ degradeAbove: 0.1, recoverBelow: 0.05 });
    for (let i = 0; i < 5; i += 1) g.request(work({ schedulingClass: "P2_INTERACTIVE", demand: { cpu: 5 } }));
    expect(g.degradation()).not.toBe("normal");
    expect(
      g.request(work({ schedulingClass: "P0_CONSTITUTIONAL", demand: { cpu: 5 } })).outcome,
    ).toBe("admitted");
    expect(g.request(work({ schedulingClass: "P1_CRITICAL", demand: { cpu: 5 } })).outcome).toBe(
      "admitted",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

describe("capacity is not authorization", () => {
  it("grants nothing by admitting", () => {
    // A gate that stands in front of work and says yes looks exactly like
    // permission. It is room.
    expect(capacityAdmissionGrantsAuthority()).toBe(false);
    expect(capacityLimitIsDenial()).toBe(false);
  });

  it("distinguishes deferred from rejected, because the caller's move differs", () => {
    // Deferred work should be retried; rejected work never will fit and
    // retrying it is a loop.
    const g = gate({ tenantSpendCeiling: 10 });
    const malformed = g.request({ workId: "", schedulingClass: "P2_INTERACTIVE" });
    expect(malformed.outcome).toBe("rejected");

    g.request(work({ schedulingClass: "P2_INTERACTIVE", demand: { cpu: 85 } }));
    const noRoom = g.request(work({ schedulingClass: "P3_BACKGROUND", demand: { cpu: 20 } }));
    expect(noRoom.outcome).toBe("deferred");
  });

  it("reports every verdict, so deferrals are not silent", () => {
    // Work quietly deferred is work nobody knows is waiting.
    const onVerdict = vi.fn();
    const g = createCapacityGate({
      instance: INSTANCE,
      now,
      policy: { limits: { cpu: 10 } },
      onVerdict,
    });
    g.request(work({ demand: { cpu: 8 } }));
    g.request(work({ demand: { cpu: 8 } }));
    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(onVerdict.mock.calls[1]?.[0]?.outcome).toBe("deferred");
  });
});
