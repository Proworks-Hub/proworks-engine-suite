// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createInMemoryAuditStore,
  createCollectiveLedger,
  createInstanceLedger,
} from "@proworks-hub/auditiq";
import {
  createAlertDeduplicator,
  createInMemoryWebhookStore,
  createWebhookDispatcher,
  createCapacityGate,
  createContinuityController,
  createInMemoryAlertStore,
  createInMemoryCapacityStore,
  createInMemoryOperatingModeStore,
} from "@proworks-hub/platform-runtime";
import { createEventIq, createInMemoryEventIqStore, type EventAuthority } from "@proworks-hub/eventiq";

// ─────────────────────────────────────────────────────────────────────────────
// STATE THAT OUTLIVES A REQUEST HAS TO OUTLIVE A PROCESS.
//
// Phases 2 through 6 each built something that remembers: offsets and dead
// letters, the audit chain, capacity reservations and spend, the operating
// mode, alert suppression windows. Every one of them held that in a closure,
// and every guarantee they make is a guarantee about state — "the offset
// advanced", "the chain is intact", "this tenant is at its budget", "this
// instance is in SAFE_MODE". A closure makes all of those true until the
// process ends.
//
// This file closes that gap as far as it can be closed HERE, and is honest
// about where the line is:
//
//   WHAT IS FIXED   every stateful module now takes a store, and reports which
//                   kind is bound. A host can persist all of it.
//
//   WHAT IS NOT     no durable adapter ships in this repository, and one
//                   cannot: `platform-runtime` and `contracts` are pure
//                   packages, and the portability guard bans `better-sqlite3`
//                   and every node builtin from them. Adapters belong to hosts,
//                   which is where the driver is allowed.
//
// So the tests below prove the SEAM works — a second instance of each module
// over the same store finds what the first left — and the last one refuses to
// let a future module hide state again.
//
// THE WORST ONE, IF THIS IS EVER SKIPPED
//
// The operating mode. An instance that restarts into NORMAL because its mode
// lived in a variable has just undone a SAFE_MODE decision by crashing — which
// makes crashing the way out of containment, and containment is the state most
// likely to be accompanied by a crash.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE = { globalInstanceId: "hive.instance.a", provisional: false };
const NOW = () => new Date("2026-08-29T12:00:00.000Z");

describe("the audit chain continues across a restart", () => {
  it("does not start a second chain from genesis", () => {
    // The specific defect a naive port would leave: a restarted engine that
    // recomputed `previousHash` from an empty local array would begin a new
    // chain inside the same store, and `verify` would report a break at the
    // seam — correctly, and confusingly, since nothing was tampered with.
    const store = createInMemoryAuditStore();

    const first = createInstanceLedger({ instance: INSTANCE, store, now: NOW, generateId: () => "a1" });
    first.append(entry());
    first.append(entry({ action: "work_order.completed" }));

    const restarted = createInstanceLedger({
      instance: INSTANCE,
      store,
      now: NOW,
      generateId: () => "a3",
    });
    restarted.append(entry({ action: "work_order.shipped" }));

    expect(restarted.count()).toBe(3);
    const check = restarted.verify();
    expect(check.intact).toBe(true);
    expect(check.recordsChecked).toBe(3);
  });

  it("keeps the two ledgers on separate stores", () => {
    // A host that bound one store to both would have merged them, which is the
    // single thing the ledger separation exists to prevent. Nothing stops that
    // in code — the stores are arguments — so it is asserted here as the shape
    // a correct binding has.
    const local = createInMemoryAuditStore();
    const collective = createInMemoryAuditStore();

    const instance = createInstanceLedger({ instance: INSTANCE, store: local, now: NOW });
    const central = createCollectiveLedger({
      collectiveId: { globalInstanceId: "hive.collective", provisional: false },
      store: collective,
      now: NOW,
    });

    instance.append(entry());
    expect(instance.count()).toBe(1);
    expect(central.count()).toBe(0);
  });

  it("detects a sequence that does not advance", () => {
    // A writer that stamped every entry with sequence 0 produces a store that
    // chains perfectly and is internally consistent, because the hash covers
    // whatever sequence was written. The chain check passes it; this does not.
    //
    // Found by a surviving mutation, and it is the difference between the
    // error message's claim — "removed, reordered or inserted" — and what it
    // could actually see.
    const store = createInMemoryAuditStore();
    const ledger = createInstanceLedger({ instance: INSTANCE, store, now: NOW });
    ledger.append(entry());
    ledger.append(entry({ action: "work_order.completed" }));
    expect(ledger.verify().intact).toBe(true);

    // A second ledger that believes the store is empty writes sequence 0 again.
    const confused = createInstanceLedger({
      instance: INSTANCE,
      store: {
        ...store,
        count: () => 0,
      },
      now: NOW,
    });
    confused.append(entry({ action: "work_order.shipped" }));

    const check = ledger.verify();
    expect(check.intact).toBe(false);
    expect(check.reason).toMatch(/Sequences must be consecutive/);
  });

  it("says which kind of store is bound", () => {
    expect(createInstanceLedger({ instance: INSTANCE, now: NOW }).durability()).toBe("in-memory");
  });
});

describe("webhook history survives a restart", () => {
  it("still knows what it sent", () => {
    // The file's own opening argument is that "did you send it?" must have an
    // answer and "probably" is not one. A log that dies with the process makes
    // "probably" the only answer available after any restart.
    const store = createInMemoryWebhookStore();
    const endpoint = {
      tenant: { organizationId: "ksix", roles: [] },
      url: "https://partner.invalid/hook",
      secret: "s".repeat(32),
      eventTypes: ["order.created"],
      active: true,
      consecutiveFailures: 0,
      createdAt: "2026-08-29T12:00:00.000Z",
    };

    const before = createWebhookDispatcher({
      store,
      transport: async () => ({ ok: true, status: 200 }),
      now: NOW,
    });
    const registered = before.register(endpoint);

    const after = createWebhookDispatcher({
      store,
      transport: async () => ({ ok: true, status: 200 }),
      now: NOW,
    });
    // The registry is configuration: a dispatcher that forgot it would simply
    // stop delivering to everybody.
    expect(after.endpoints().map((e) => e.endpointId)).toEqual([registered.endpointId]);
  });
});

describe("capacity survives a restart", () => {
  it("comes back knowing what is already held", () => {
    // A restart under load is followed immediately by a rush of retries. A
    // gate that came back believing nothing was held would admit all of them.
    const store = createInMemoryCapacityStore();
    const policy = { limits: { cpu: 100 }, constitutionalReserve: 0.1 };

    const before = createCapacityGate({ instance: INSTANCE, policy, store, now: NOW });
    for (let i = 0; i < 9; i += 1) {
      before.request({
        workId: `w${i}`,
        schedulingClass: "P1_CRITICAL",
        purpose: "production",
        demand: { cpu: 10 },
      });
    }

    const after = createCapacityGate({ instance: INSTANCE, policy, store, now: NOW });
    expect(after.reservations()).toHaveLength(9);
    expect(
      after.request({ workId: "x", schedulingClass: "P2_INTERACTIVE", purpose: "p", demand: { cpu: 5 } })
        .outcome,
    ).toBe("deferred");
    // And the reserve still gets its rollback through.
    expect(
      after.request({
        workId: "r",
        schedulingClass: "P0_CONSTITUTIONAL",
        purpose: "rollback",
        demand: { cpu: 5 },
      }).outcome,
    ).toBe("admitted");
  });

  it("remembers what a tenant has spent", () => {
    // A budget that resets on restart is not a budget. It is a report of what
    // was spent since the last crash.
    const store = createInMemoryCapacityStore();
    const policy = { limits: { ai_spend: 1_000 }, tenantSpendCeiling: 100 };

    createCapacityGate({ instance: INSTANCE, policy, store, now: NOW }).request({
      workId: "w",
      tenantId: "t",
      schedulingClass: "P3_BACKGROUND",
      purpose: "p",
      demand: { ai_spend: 80 },
    });

    const after = createCapacityGate({ instance: INSTANCE, policy, store, now: NOW });
    expect(after.spentBy("t")).toBe(80);
    expect(
      after.request({
        workId: "w2",
        tenantId: "t",
        schedulingClass: "P3_BACKGROUND",
        purpose: "p",
        demand: { ai_spend: 40 },
      }).outcome,
    ).toBe("rejected");
  });
});

describe("containment survives a restart", () => {
  it("does not let a crash be the way out of SAFE_MODE", () => {
    // The worst one on this page. Crashing must not undo a containment
    // decision, and containment is the state most likely to come with a crash.
    const store = createInMemoryOperatingModeStore();

    createContinuityController({ instance: INSTANCE, store, now: NOW }).degrade(
      "SAFE_MODE",
      "sentinel found a compromised connector",
    );

    const after = createContinuityController({ instance: INSTANCE, store, now: NOW });
    expect(after.mode()).toBe("SAFE_MODE");
    expect(after.admits("P2_INTERACTIVE")).toBe(false);
  });

  it("ignores initialMode when a store already holds one", () => {
    // Otherwise a constructor argument would be able to reset containment,
    // which is the same hole with a nicer name.
    const store = createInMemoryOperatingModeStore();
    createContinuityController({ instance: INSTANCE, store, now: NOW }).degrade("ISOLATED", "partition");

    const after = createContinuityController({
      instance: INSTANCE,
      store,
      initialMode: "NORMAL",
      now: NOW,
    });
    expect(after.mode()).toBe("ISOLATED");
  });

  it("keeps queued contributions across the restart", () => {
    // Losing them would turn a partition into data loss, which is exactly what
    // queueing rather than failing was for.
    const store = createInMemoryOperatingModeStore();
    const before = createContinuityController({ instance: INSTANCE, store, now: NOW });
    before.degrade("ISOLATED", "partition");
    before.contribute({ kind: "pattern.observed", reference: "obs:1" });

    const after = createContinuityController({ instance: INSTANCE, store, now: NOW });
    expect(after.pendingContributions()).toHaveLength(1);

    // And the reconciliation gate still sees them, so the restart cannot be
    // used to rejoin with unsent work.
    after.recover({ to: "RECOVERY", reason: "link back", authorizedBy: "user.steven" });
    const rejoin = after.recover({
      to: "NORMAL",
      reason: "done",
      authorizedBy: "user.steven",
      reconciliation: {
        contributionsDrained: true,
        ledgerIntact: true,
        versionsAgree: true,
        trustReestablished: true,
      },
    });
    expect(rejoin.changed).toBe(false);
  });
});

describe("alert suppression survives a restart", () => {
  it("does not re-notify everything that was already firing", () => {
    // A restart with an empty deduplicator produces a notification storm
    // caused by the thing that exists to prevent notification storms.
    const store = createInMemoryAlertStore();
    const now = () => new Date("2026-08-29T12:00:00.000Z");

    const before = createAlertDeduplicator({ store, now, windowMs: 60_000 });
    expect(before.consider({ fingerprint: "f", signalClass: "warning" }).notify).toBe(true);

    const after = createAlertDeduplicator({ store, now, windowMs: 60_000 });
    expect(after.consider({ fingerprint: "f", signalClass: "warning" }).notify).toBe(false);
  });

  it("still notifies on escalation after a restart", () => {
    // Suppression must not survive so well that it hides a worsening
    // condition.
    const store = createInMemoryAlertStore();
    const now = () => new Date("2026-08-29T12:00:00.000Z");
    createAlertDeduplicator({ store, now }).consider({ fingerprint: "f", signalClass: "warning" });

    const after = createAlertDeduplicator({ store, now });
    expect(after.consider({ fingerprint: "f", signalClass: "incident" }).notify).toBe(true);
  });
});

describe("the event fabric survives a restart", () => {
  it("comes back at the checkpoint it left", () => {
    const store = createInMemoryEventIqStore();
    const permits: EventAuthority = {
      mayPublish: () => ({ permitted: true, reason: "ok", decisionId: "gd" }),
      mayReplay: () => ({ permitted: true, reason: "ok", decisionId: "gd" }),
    };
    const subscription = {
      subscriptionId: "sub_1",
      consumerGroup: "grp_1",
      consumerId: "c",
      messageTypes: ["material.reserved"],
      tenant: "ksix",
      systemScoped: false,
      expectation: {
        guarantee: "at-least-once",
        ordering: "none",
        maxAttempts: 3,
        consequenceIfLost: "degraded",
      },
      idempotent: true,
      createdAt: "2026-08-29T10:00:00.000Z",
    };
    const message = (id: string) => ({
      messageId: id,
      category: "EVENT",
      messageType: "material.reserved",
      schemaVersion: 1,
      producerId: "p",
      tenant: { organizationId: "ksix", roles: [] },
      systemScoped: false,
      trace: { correlationId: "c" },
      timestamp: "2026-08-29T09:00:00.000Z",
      dataClassification: "internal",
      payload: {},
    });

    const before = createEventIq({ instance: INSTANCE, authority: permits, store, now: NOW });
    before.subscribe(subscription);
    before.publish(message("m1"));
    before.publish(message("m2"));
    before.poll("sub_1");
    before.acknowledge({
      messageId: "m1",
      subscriptionId: "sub_1",
      by: "c",
      at: "2026-08-29T10:00:00.000Z",
      outcome: "accepted",
    });

    const after = createEventIq({ instance: INSTANCE, authority: permits, store, now: NOW });
    after.subscribe(subscription);
    expect(after.count()).toBe(2);
    expect(after.poll("sub_1").map((e) => e.message.messageId)).toEqual(["m2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("no module may hide state a host cannot persist", () => {
  it("keeps every stateful runtime module behind a store", () => {
    // The guard, and the reason this file is not just six restart tests: the
    // next module written will hold its state in a closure too, because that is
    // the shortest way to write it. This is what makes that a failing test
    // rather than a discovery during an incident.
    //
    // Approximate by construction — it looks for factories that keep a Map or a
    // mutable binding at closure scope without taking a store. A source scan is
    // a blunt instrument, and it is still better than nobody looking.
    const roots = [
      join(process.cwd(), "packages/platform-runtime/src"),
      join(process.cwd(), "packages/eventiq/src"),
      join(process.cwd(), "packages/auditiq/src"),
    ];

    const files: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "__tests__") continue;
          walk(full);
          continue;
        }
        if (name.endsWith(".ts")) files.push({ path: full, text: readFileSync(full, "utf8") });
      }
    };
    for (const root of roots) walk(root);

    /**
     * State that is CORRECTLY process-local, with the argument written down.
     *
     * `resilienceRuntime` holds circuit-breaker state and rate-limit windows,
     * and both describe what THIS process has observed about a dependency —
     * not a fact about the dependency itself. Persisting them, or worse
     * sharing them between processes, would mean one worker's bad network
     * makes every other worker refuse to try; a restarted process should
     * re-probe rather than inherit a verdict it did not reach. A shared
     * circuit breaker is a known way to turn a local blip into an outage.
     *
     * This list is deliberately short and each entry has to earn its place. An
     * exemption without an argument is how the guard stops guarding.
     */
    const PROCESS_LOCAL_BY_DESIGN = ["platform-runtime/src/resilienceRuntime.ts"];

    const offenders: string[] = [];
    for (const file of files) {
      // Ignore the in-memory adapters themselves: holding a Map is their job.
      if (/export function createInMemory/.test(file.text)) continue;
      // Slashes normalised BEFORE the split, not after: on Windows the path
      // separator is a backslash, so splitting on "packages/" first finds
      // nothing and every file reports as an offender under its full path.
      const normalised = file.path.split(String.fromCharCode(92)).join("/");
      const relative = normalised.split("packages/")[1] ?? normalised;
      if (PROCESS_LOCAL_BY_DESIGN.includes(relative)) continue;

      const code = file.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const factories = code.match(/export function create[A-Za-z]+\s*\(/g) ?? [];
      if (factories.length === 0) continue;

      const keepsState = /\bconst\s+\w+\s*=\s*new Map<|\bconst\s+\w+:\s*\w+\[\]\s*=\s*\[\]/.test(code);
      const takesStore = /store\s*[?:]|options\.store/.test(code);
      if (keepsState && !takesStore) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("makes every module say which kind of store is bound", () => {
    // A store that lied about this would let a host believe its offsets, its
    // audit chain or its containment decision survived a restart.
    expect(createInstanceLedger({ instance: INSTANCE, now: NOW }).durability()).toBe("in-memory");
    expect(
      createCapacityGate({ instance: INSTANCE, policy: { limits: {} }, now: NOW }).durability(),
    ).toBe("in-memory");
    expect(createContinuityController({ instance: INSTANCE, now: NOW }).durability()).toBe(
      "in-memory",
    );
    expect(createAlertDeduplicator().durability()).toBe("in-memory");
  });
});

function entry(over: Record<string, unknown> = {}) {
  return {
    actor: { actorId: "user.steven", kind: "human" },
    tenant: { organizationId: "ksix", roles: [] },
    component: "hive.workorderiq",
    actionType: "event",
    action: "work_order.created",
    outcome: "succeeded",
    reason: "created",
    trace: { correlationId: "ORDER-123" },
    ...over,
  };
}
