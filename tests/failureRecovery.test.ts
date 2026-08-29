// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import {
  classesRunningIn,
  collectiveMayOverwriteLocal,
  createDenyAllGovernance,
  mayWriteToCollective,
  recoveryCreatesAuthority,
  recoveryTierSchema,
  transitionIsPermitted,
  transitionNeedsHuman,
} from "@proworks-hub/contracts";
import {
  createContinuityController,
  pulseCanStartNewWork,
  type ReconciliationReport,
} from "@proworks-hub/platform-runtime";
import {
  createInMemoryWorkflowStateStore,
  createPrime,
  createPrimePulse,
} from "@proworks-hub/prime";
import { createEventIq, type EventAuthority } from "@proworks-hub/eventiq";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — failure, recovery and continuity.
//
// The seven chaos tests the directive names:
//
//   1. Kill an engine mid-workflow; verify safe resume.
//   2. Partition the instance from the collective; verify local continuity.
//   3. Deliver duplicate critical events during recovery; verify no duplicate
//      effect.
//   4. Force a bad release; verify automatic rollback.
//   5. Revoke a compromised connector during an active workflow.
//   6. Restore from backup; verify ledger and event integrity.
//   7. Prime Pulse cannot start unauthorized new work.
//
// The sentence the whole architecture is built around, and the one the last
// group defends: NEVER USE RECOVERY AS A PATH TO BYPASS AUTHORITY. Recovery is
// the moment when the usual checks feel like obstacles and somebody is under
// pressure, which is exactly when a bypass gets added and never removed.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = { globalInstanceId: "hive.instance.a", provisional: false };
const NOW = () => new Date("2026-08-29T12:00:00.000Z");

const PASSING: ReconciliationReport = {
  contributionsDrained: true,
  ledgerIntact: true,
  versionsAgree: true,
  trustReestablished: true,
};

const controller = (over: Record<string, unknown> = {}) =>
  createContinuityController({ instance: INSTANCE, now: NOW, ...over });

const contribution = (over: Record<string, unknown> = {}) => ({
  kind: "pattern.observed",
  reference: "obs:aggregate-77",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PARTITION AND LOCAL CONTINUITY
// ─────────────────────────────────────────────────────────────────────────────

describe("an isolated instance keeps working and loses nothing", () => {
  it("continues local production work while cut off from the collective", () => {
    const c = controller();
    c.degrade("ISOLATED", "lost the link to the collective");

    expect(c.admits("P0_CONSTITUTIONAL")).toBe(true);
    expect(c.admits("P1_CRITICAL")).toBe(true);
    expect(c.admits("P2_INTERACTIVE")).toBe(true);
    // Evolution and background stop: both are the classes most likely to want
    // the collective, and neither is what the shop is waiting on.
    expect(c.admits("P3_BACKGROUND")).toBe(false);
    expect(c.admits("P4_EVOLUTION")).toBe(false);
  });

  it("queues contributions rather than failing them", () => {
    // Failing the write would make isolation LOSE work rather than defer it,
    // and a shop would learn about the partition from a gap in its history.
    const c = controller();
    c.degrade("ISOLATED", "partition");

    const result = c.contribute(contribution());
    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
    expect(c.pendingContributions()).toHaveLength(1);
  });

  it("sends directly when connected, so the queue is not the only path", () => {
    const c = controller();
    const result = c.contribute(contribution());
    expect(result.sent).toBe(true);
    expect(c.pendingContributions()).toHaveLength(0);
  });

  it("refuses collective writes in DEGRADED too", () => {
    // The least obvious rule. A partially broken instance can still REACH the
    // collective, which makes it exactly the instance most able to publish a
    // conclusion drawn from incomplete local data.
    expect(mayWriteToCollective("DEGRADED")).toBe(false);
    expect(mayWriteToCollective("NORMAL")).toBe(true);
  });

  it("stops everything but safety work in SAFE_MODE", () => {
    // The mode an instance enters when it cannot trust itself. Interactive
    // work continuing there would mean a person is still being served by a
    // system that has declared itself unreliable.
    //
    // Found by a surviving mutation: RECOVERY's class list was asserted and
    // SAFE_MODE's was not.
    const c = controller();
    c.degrade("SAFE_MODE", "cannot trust local state");
    expect(c.admits("P0_CONSTITUTIONAL")).toBe(true);
    expect(c.admits("P1_CRITICAL")).toBe(true);
    expect(c.admits("P2_INTERACTIVE")).toBe(false);
    expect(c.admits("P3_BACKGROUND")).toBe(false);
    expect(c.admits("P4_EVOLUTION")).toBe(false);
    expect(classesRunningIn("SAFE_MODE")).toEqual(["P0_CONSTITUTIONAL", "P1_CRITICAL"]);
  });

  it("will not use degrade() to move back toward NORMAL", () => {
    // `degrade` is the free path — a reason and nothing else. If it also moved
    // upward it would be a way around every check `recover` performs, which is
    // exactly the recovery-as-bypass the architecture forbids.
    //
    // Also found by a surviving mutation.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    const backwards = c.degrade("NORMAL", "looks fine now");
    expect(backwards.changed).toBe(false);
    if (backwards.changed) return;
    expect(backwards.reason).toMatch(/not more restrictive/);
    expect(c.mode()).toBe("ISOLATED");

    // And not sideways into a less restrictive mode either.
    expect(c.degrade("DEGRADED", "partial").changed).toBe(false);
    expect(c.mode()).toBe("ISOLATED");
  });

  it("refuses a malformed contribution rather than queueing it", () => {
    // A queue that accepts anything is a queue that cannot be drained.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    const bad = c.contribute({ kind: "", reference: "" });
    expect(bad.queued).toBe(false);
    expect(c.pendingContributions()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WAY BACK
// ─────────────────────────────────────────────────────────────────────────────

describe("degrading is automatic and recovering is not", () => {
  it("degrades on a reason alone", () => {
    // Under failure, restriction must never be blocked on ceremony.
    const c = controller();
    expect(c.degrade("SAFE_MODE", "sentinel found a compromised connector").changed).toBe(true);
    expect(c.mode()).toBe("SAFE_MODE");
  });

  it("will not go straight from ISOLATED to NORMAL", () => {
    // The only door into NORMAL is RECOVERY. An instance that rejoined without
    // reconciling would make its first act on return the overwriting of
    // whatever changed while it was away.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    const jump = c.recover({ to: "NORMAL", reason: "link is back", reconciliation: PASSING, authorizedBy: "user.steven" });
    expect(jump.changed).toBe(false);
    if (jump.changed) return;
    expect(jump.reason).toMatch(/only door into NORMAL is RECOVERY/);
    expect(transitionIsPermitted("ISOLATED", "NORMAL")).toBe(false);
    expect(transitionIsPermitted("RECOVERY", "NORMAL")).toBe(true);
  });

  it("requires a named human to leave SAFE_MODE", () => {
    const c = controller();
    c.degrade("SAFE_MODE", "compromise");
    const unattended = c.recover({ to: "RECOVERY", reason: "looks better" });
    expect(unattended.changed).toBe(false);
    if (unattended.changed) return;
    expect(unattended.reason).toMatch(/requires a named human/);

    expect(
      c.recover({
        to: "RECOVERY",
        reason: "investigated and cleared",
        authorizedBy: "user.steven",
      }).changed,
    ).toBe(true);
  });

  it("requires a human to reach NORMAL", () => {
    expect(transitionNeedsHuman("RECOVERY", "NORMAL")).toBe(true);
    expect(transitionNeedsHuman("NORMAL", "ISOLATED")).toBe(false);
    expect(transitionNeedsHuman("SAFE_MODE", "RECOVERY")).toBe(true);
  });

  it("enters RECOVERY without demanding the reconciliation up front", () => {
    // The correction three failing tests forced, and it is a design point
    // rather than a detail: reconciling is what happens INSIDE recovery, so
    // requiring a passed reconciliation to get in would mean an instance
    // needed the result of the work before it was allowed to start it.
    //
    // My first version ordered RECOVERY on the severity ladder, which made
    // `ISOLATED -> RECOVERY` compare as a further degradation and skipped the
    // gate entirely. The gate belongs on the way out.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    expect(c.recover({ to: "RECOVERY", reason: "link is back" }).changed).toBe(true);
    expect(c.mode()).toBe("RECOVERY");
  });

  it("refuses to leave RECOVERY on a failed reconciliation, naming which part failed", () => {
    const c = controller();
    c.degrade("ISOLATED", "partition");
    c.recover({ to: "RECOVERY", reason: "link is back" });

    const r = c.recover({
      to: "NORMAL",
      reason: "done",
      reconciliation: { ...PASSING, ledgerIntact: false, trustReestablished: false },
      authorizedBy: "user.steven",
    });
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toMatch(/ledger chain did not verify/);
    expect(r.reason).toMatch(/trust was not re-established/);
    expect(c.mode()).toBe("RECOVERY");
  });

  it("refuses to leave RECOVERY with no reconciliation at all", () => {
    const c = controller();
    c.degrade("ISOLATED", "partition");
    c.recover({ to: "RECOVERY", reason: "link is back" });
    expect(c.recover({ to: "NORMAL", reason: "seems fine", authorizedBy: "user.steven" }).changed).toBe(
      false,
    );
  });

  it("checks the queue rather than believing the report", () => {
    // A report may CLAIM the queue was drained. Taking that at its word would
    // let an instance rejoin holding unsent work and silently stop queueing.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    c.contribute(contribution());
    c.recover({ to: "RECOVERY", reason: "link is back" });

    const r = c.recover({
      to: "NORMAL",
      reason: "done",
      reconciliation: PASSING,
      authorizedBy: "user.steven",
    });
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toMatch(/claims the queue is drained and 1 contribution/);
  });

  it("completes the round trip when everything genuinely passes", () => {
    // Non-vacuity for every refusal above. A controller that never recovered
    // would pass all of them.
    const c = controller();
    c.degrade("ISOLATED", "partition");
    c.recover({ to: "RECOVERY", reason: "link is back" });
    expect(
      c.recover({
        to: "NORMAL",
        reason: "reconciled",
        reconciliation: PASSING,
        authorizedBy: "user.steven",
      }).changed,
    ).toBe(true);
    expect(c.mode()).toBe("NORMAL");
    expect(c.contribute(contribution()).sent).toBe(true);
  });

  it("does not let anything degrade INTO recovery", () => {
    const c = controller();
    expect(c.degrade("RECOVERY", "confused").changed).toBe(false);
    expect(transitionIsPermitted("NORMAL", "RECOVERY")).toBe(false);
  });

  it("admits only safety work while reconciling", () => {
    // Admitting ordinary production on top of a half-reconciled state is how a
    // recovery becomes the next incident.
    expect(classesRunningIn("RECOVERY")).toEqual(["P0_CONSTITUTIONAL"]);
  });

  it("reports every transition, including the refused ones", () => {
    const onTransition = vi.fn();
    const c = controller({ onTransition });
    c.degrade("ISOLATED", "partition");
    c.recover({ to: "NORMAL", reason: "no" });
    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(onTransition.mock.calls[1]?.[0]?.changed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STALE COLLECTIVE KNOWLEDGE
// ─────────────────────────────────────────────────────────────────────────────

describe("stale collective knowledge does not overwrite newer local state", () => {
  it("refuses an older collective record", () => {
    // The specific way a rejoin destroys data: the instance was away, the
    // collective's copy is older than what the shop has been doing locally,
    // and reconciliation cheerfully writes it back.
    const c = controller();
    const r = c.acceptFromCollective({
      collectiveUpdatedAt: "2026-08-29T10:00:00.000Z",
      localUpdatedAt: "2026-08-29T11:00:00.000Z",
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/Stale collective knowledge does not overwrite/);
  });

  it("accepts a newer one", () => {
    const c = controller();
    expect(
      c.acceptFromCollective({
        collectiveUpdatedAt: "2026-08-29T12:00:00.000Z",
        localUpdatedAt: "2026-08-29T11:00:00.000Z",
      }).accepted,
    ).toBe(true);
  });

  it("gives a tie to the local record", () => {
    // Two records with the same timestamp are not distinguishable by recency,
    // and the tenant's own is the one the tenant can see and correct.
    expect(
      collectiveMayOverwriteLocal({
        collectiveUpdatedAt: "2026-08-29T11:00:00.000Z",
        localUpdatedAt: "2026-08-29T11:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("refuses when recency cannot be established at all", () => {
    // An overwrite that cannot justify itself does not happen.
    expect(
      collectiveMayOverwriteLocal({ collectiveUpdatedAt: "not a date", localUpdatedAt: "2026-08-29T11:00:00.000Z" }),
    ).toBe(false);
  });

  it("does not take collective updates while isolated", () => {
    const c = controller();
    c.degrade("ISOLATED", "partition");
    expect(
      c.acceptFromCollective({
        collectiveUpdatedAt: "2026-08-29T13:00:00.000Z",
        localUpdatedAt: "2026-08-29T11:00:00.000Z",
      }).accepted,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 7. RESUME, AND WHAT PULSE CANNOT DO
// ─────────────────────────────────────────────────────────────────────────────

describe("Prime Pulse resumes authorized work and cannot start any", () => {
  it("exposes no way to begin a workflow", () => {
    // Structural, not promised. `health`, `checkpoint` and `resume` — none of
    // them takes a workflow definition, so there is nothing to start. Asserted
    // as a surface so a future `pulse.start()` fails a test rather than
    // passing review.
    const pulse = createPrimePulse({ store: createInMemoryWorkflowStateStore() });
    const surface = Object.keys(pulse).sort();
    expect(surface).toEqual(["chamber", "checkpoint", "health", "resume"]);
    expect(surface).not.toContain("start");
    expect(pulseCanStartNewWork()).toBe(false);
  });

  it("reports honestly that an in-memory store would not survive anything", () => {
    // A recovery chamber over volatile state is the lie this health check
    // exists to prevent.
    const pulse = createPrimePulse({ store: createInMemoryWorkflowStateStore() });
    const health = pulse.health();
    expect(health.durability).toBe("in-memory");
    expect(health.state).toBe("degraded");
  });

  it("does not resume work whose Governance will not stand behind it", () => {
    // The sentence the architecture is built around, exercised: an engine died
    // mid-workflow, the work is resumed, and Governance says no. Recovery is
    // not a path around authority.
    const performed = vi.fn();
    const prime = createPrime({
      engines: [{ capability: "work_order.create", perform: performed }],
      governance: createDenyAllGovernance("this worker may not resume intake"),
      continuity: createInMemoryWorkflowStateStore(),
      instanceId: "worker-b",
    });

    return prime
      .runner!.start({
        definition: {
          workflowType: "intake",
          steps: [{ stepId: "create", requiresAuthorization: true, routeTo: "work_order.create" }],
        },
        tenant: { organizationId: "ksix", roles: [] },
        trace: { correlationId: "ORDER-123" },
        context: { authorizationRef: "gd-from-before-the-crash" },
      })
      .then((result) => {
        expect(performed).not.toHaveBeenCalled();
        expect(result.status).not.toBe("completed");
        expect(recoveryCreatesAuthority()).toBe(false);
      });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DUPLICATE CRITICAL EVENTS DURING RECOVERY
// ─────────────────────────────────────────────────────────────────────────────

describe("duplicate critical events during recovery cause one effect", () => {
  it("suppresses a redelivered operation the consumer already accepted", () => {
    // Recovery is exactly when duplicates arrive: a producer retried across the
    // interruption, and the consumer has already done the work.
    const permits: EventAuthority = {
      mayPublish: () => ({ permitted: true, reason: "ok", decisionId: "gd-pub" }),
      mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd-replay" }),
    };
    const bus = createEventIq({ instance: INSTANCE, authority: permits, now: NOW });

    bus.subscribe({
      subscriptionId: "sub_1",
      consumerGroup: "grp_1",
      consumerId: "hive.inventoryiq",
      messageTypes: ["material.reserve"],
      tenant: "ksix",
      systemScoped: false,
      expectation: {
        guarantee: "at-least-once",
        ordering: "per-entity",
        maxAttempts: 3,
        consequenceIfLost: "critical",
      },
      idempotent: true,
      createdAt: "2026-08-29T10:00:00.000Z",
    });

    const message = (messageId: string) => ({
      messageId,
      category: "EVENT" as const,
      messageType: "material.reserve",
      schemaVersion: 1,
      producerId: "hive.forgeiq",
      tenant: { organizationId: "ksix", roles: [] },
      systemScoped: false,
      trace: { correlationId: "ORDER-123" },
      timestamp: "2026-08-29T09:00:00.000Z",
      dataClassification: "internal" as const,
      idempotencyKey: "reserve:wo-77",
      payload: { sheets: 4 },
    });

    bus.publish(message("msg_before_crash"));
    expect(bus.poll("sub_1")).toHaveLength(1);
    bus.acknowledge({
      messageId: "msg_before_crash",
      subscriptionId: "sub_1",
      by: "hive.inventoryiq",
      at: "2026-08-29T10:00:00.000Z",
      outcome: "accepted",
    });

    // The producer retried across the interruption with a NEW message id for
    // the SAME operation. Deduplicating on message id would let this through.
    bus.publish(message("msg_after_crash"));
    expect(bus.poll("sub_1")).toHaveLength(0);
  });

  it("still delivers a genuinely different critical operation", () => {
    // Non-vacuity: a consumer that received nothing would pass the test above.
    const permits: EventAuthority = {
      mayPublish: () => ({ permitted: true, reason: "ok", decisionId: "gd-pub" }),
      mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd-replay" }),
    };
    const bus = createEventIq({ instance: INSTANCE, authority: permits, now: NOW });
    bus.subscribe({
      subscriptionId: "sub_1",
      consumerGroup: "grp_1",
      consumerId: "hive.inventoryiq",
      messageTypes: ["material.reserve"],
      tenant: "ksix",
      systemScoped: false,
      expectation: {
        guarantee: "at-least-once",
        ordering: "none",
        maxAttempts: 3,
        consequenceIfLost: "critical",
      },
      idempotent: true,
      createdAt: "2026-08-29T10:00:00.000Z",
    });

    const base = {
      category: "EVENT" as const,
      messageType: "material.reserve",
      schemaVersion: 1,
      producerId: "hive.forgeiq",
      tenant: { organizationId: "ksix", roles: [] },
      systemScoped: false,
      trace: { correlationId: "ORDER-123" },
      timestamp: "2026-08-29T09:00:00.000Z",
      dataClassification: "internal" as const,
      payload: {},
    };
    bus.publish({ ...base, messageId: "m1", idempotencyKey: "reserve:wo-77" });
    bus.publish({ ...base, messageId: "m2", idempotencyKey: "reserve:wo-88" });
    expect(bus.poll("sub_1")).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. RPO / RTO
// ─────────────────────────────────────────────────────────────────────────────

describe("backups are a hypothesis until somebody restores one", () => {
  it("reports which tiers have never been restore-tested", () => {
    // `false` is not a configuration error. It is an honest statement, and the
    // point of recording it is that an untested tier can be reported rather
    // than assumed working on the day it matters.
    const c = controller({
      tiers: [
        {
          dataClass: "ledger",
          rpoSeconds: 0,
          rtoSeconds: 300,
          restoreTested: true,
          lastRestoreTestAt: "2026-08-01T00:00:00.000Z",
        },
        { dataClass: "telemetry", rpoSeconds: 3600, rtoSeconds: 86_400, restoreTested: false },
      ],
    });
    expect(c.untestedTiers().map((t) => t.dataClass)).toEqual(["telemetry"]);
  });

  it("refuses a tested claim with no date on it", () => {
    // An untimestamped claim ages into a false one, and nobody notices because
    // the field still says true.
    expect(
      recoveryTierSchema.safeParse({
        dataClass: "ledger",
        rpoSeconds: 0,
        rtoSeconds: 300,
        restoreTested: true,
      }).success,
    ).toBe(false);
  });

  it("allows different tiers per data class", () => {
    // One number for a whole system is always wrong in one direction: set by
    // the most critical data it is unaffordable, set by the least it is
    // negligent.
    const ledger = recoveryTierSchema.parse({
      dataClass: "ledger",
      rpoSeconds: 0,
      rtoSeconds: 300,
      restoreTested: false,
    });
    expect(ledger.rpoSeconds).toBe(0);
  });
});
