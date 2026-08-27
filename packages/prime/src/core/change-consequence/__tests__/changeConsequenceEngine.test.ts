// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * Copyright (c) 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine - change-order consequence engine tests.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md Sec. 3.
 *
 * Covers:
 *  - approved-status guard (refuses pending / rejected)
 *  - workOrderId validation
 *  - routing-invalidating kinds (modify_spec / add_item / remove_item / change_quantity)
 *  - non-invalidating kind (expedite) and the forceRoutingRecompute hint
 *  - tasks effect reasons: routing_invalidated / explicit_step_list / forced
 *  - ETA epsilon gating (below-epsilon no-op, above-epsilon emits)
 *  - priority escalation on expedite and via forcePriorityEscalate hint
 *  - change.applied envelope lists downstream event ids in emission order
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog.js";
import type { EventLog } from "../../logging/eventLog.js";
import type { EventActor } from "../../../models/events.js";
import type {
  ChangeOrder,
  ChangeOrderKind,
  ChangeOrderStatus,
} from "../../change/changeOrderTypes.js";
import {
  createChangeConsequenceEngine,
  type ChangeConsequenceEngine,
  type ChangeAppliedPayload,
  type ChangeConsequenceHintsExt,
  type PriorityEscalatedByChangePayload,
} from "../changeConsequenceEngine.js";
import type { RoutingRecomputedPayload } from "../effects/routingEffect.js";
import type { TasksRegeneratedPayload } from "../effects/tasksEffect.js";
import type { EtaRecalculatedPayload } from "../effects/etaEffect.js";

const SUPERVISOR: EventActor = { kind: "user", userId: "u-sup", role: "supervisor" };

function mkSeq(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function mkClock(): () => Date {
  let n = 0;
  return () => new Date(Date.UTC(2026, 3, 22, 12, 0, n++));
}

function makeChangeOrder(overrides: Partial<ChangeOrder> = {}): ChangeOrder {
  return {
    id: "co-1",
    workOrderId: "wo-1",
    kind: "modify_spec" as ChangeOrderKind,
    description: "swap bracket to titanium",
    requestedBy: "u-op",
    requestedAt: new Date(Date.UTC(2026, 3, 22, 11, 0, 0)),
    status: "approved" as ChangeOrderStatus,
    reviewer: "u-sup",
    decisionAt: new Date(Date.UTC(2026, 3, 22, 11, 5, 0)),
    ...overrides,
  };
}

describe("createChangeConsequenceEngine - applyChangeOrderEffects()", () => {
  let log: EventLog;
  let engine: ChangeConsequenceEngine;

  beforeEach(() => {
    log = createInMemoryEventLog({ idGenerator: mkSeq("ev"), clock: mkClock() });
    engine = createChangeConsequenceEngine({ eventLog: log });
  });

  describe("guards", () => {
    it("refuses a pending change order", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ status: "pending" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("not_approved");
      expect(await log.size()).toBe(0);
    });

    it("refuses a rejected change order", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({
          status: "rejected",
          rejectionReason: "cost too high",
        }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("not_approved");
    });

    it("refuses a change order missing workOrderId", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ workOrderId: "" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("invalid_command");
    });
  });

  describe("routing effect", () => {
    it.each<ChangeOrderKind>([
      "modify_spec",
      "add_item",
      "remove_item",
      "change_quantity",
    ])("fires routing for kind=%s", async (kind) => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.routingEvent).toBeDefined();
      expect(res.cascade.routingEvent?.type).toBe("work_order.routing.recomputed");
      const payload = res.cascade.routingEvent?.payload as RoutingRecomputedPayload;
      expect(payload.reasonKind).toBe(kind);
      expect(payload.forced).toBe(false);
    });

    it("does NOT fire routing for kind=expedite by default", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.routingEvent).toBeUndefined();
    });

    it("fires routing for kind=expedite when forceRoutingRecompute hint is set", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
        hints: { forceRoutingRecompute: true },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.routingEvent).toBeDefined();
      const payload = res.cascade.routingEvent?.payload as RoutingRecomputedPayload;
      expect(payload.forced).toBe(true);
    });
  });

  describe("tasks effect", () => {
    it("fires with reason=routing_invalidated when routing fired", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "modify_spec" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.tasksEvent).toBeDefined();
      const payload = res.cascade.tasksEvent?.payload as TasksRegeneratedPayload;
      expect(payload.reason).toBe("routing_invalidated");
    });

    it("fires with reason=explicit_step_list when routing did NOT fire but invalidatedStepIds hint present", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
        hints: { invalidatedStepIds: ["step-7", "step-8"] },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.routingEvent).toBeUndefined();
      expect(res.cascade.tasksEvent).toBeDefined();
      const payload = res.cascade.tasksEvent?.payload as TasksRegeneratedPayload;
      expect(payload.reason).toBe("explicit_step_list");
      expect(payload.invalidatedStepIds).toEqual(["step-7", "step-8"]);
    });

    it("fires with reason=forced when forceTasksRegenerate hint is set, even with no routing", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
        hints: { forceTasksRegenerate: true },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.tasksEvent).toBeDefined();
      const payload = res.cascade.tasksEvent?.payload as TasksRegeneratedPayload;
      expect(payload.reason).toBe("forced");
    });

    it("does NOT fire tasks when kind is expedite with no regeneration hints", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.tasksEvent).toBeUndefined();
    });
  });

  describe("ETA effect", () => {
    const PREV = "2026-04-22T15:00:00.000Z";
    const NEAR = "2026-04-22T15:00:30.000Z";       // +30s - below default epsilon
    const FAR = "2026-04-22T16:30:00.000Z";        // +90 min - above epsilon

    it("does not fire when hints omit newEtaIso / previousEtaIso", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder(),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.etaEvent).toBeUndefined();
    });

    it("does not fire when |delta| is below default epsilon (60_000 ms)", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder(),
        actor: SUPERVISOR,
        hints: { previousEtaIso: PREV, newEtaIso: NEAR },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.etaEvent).toBeUndefined();
    });

    it("fires when |delta| exceeds the default epsilon", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder(),
        actor: SUPERVISOR,
        hints: { previousEtaIso: PREV, newEtaIso: FAR },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.etaEvent).toBeDefined();
      const payload = res.cascade.etaEvent?.payload as EtaRecalculatedPayload;
      expect(payload.previousEtaIso).toBe(PREV);
      expect(payload.newEtaIso).toBe(FAR);
      expect(payload.deltaMs).toBe(90 * 60_000);
    });

    it("honors a custom etaEpsilonMs", async () => {
      const hints: ChangeConsequenceHintsExt = {
        previousEtaIso: PREV,
        newEtaIso: NEAR,
        etaEpsilonMs: 10_000, // now 30s > 10s threshold -> fires
      };
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder(),
        actor: SUPERVISOR,
        hints,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.etaEvent).toBeDefined();
    });
  });

  describe("priority effect", () => {
    it("fires with reason=expedite_kind when changeOrder.kind is expedite", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.priorityEvent).toBeDefined();
      const payload = res.cascade.priorityEvent?.payload as PriorityEscalatedByChangePayload;
      expect(payload.reason).toBe("expedite_kind");
    });

    it("fires with reason=hint when forcePriorityEscalate is true for a non-expedite kind", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "modify_spec" }),
        actor: SUPERVISOR,
        hints: { forcePriorityEscalate: true },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.priorityEvent).toBeDefined();
      const payload = res.cascade.priorityEvent?.payload as PriorityEscalatedByChangePayload;
      expect(payload.reason).toBe("hint");
    });

    it("does NOT fire priority for non-expedite kinds without the hint", async () => {
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "modify_spec" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cascade.priorityEvent).toBeUndefined();
    });
  });

  describe("change.applied envelope", () => {
    it("always emits change.applied even when no downstream effects fire", async () => {
      // expedite with no hints: routing skipped, tasks skipped, eta skipped,
      // priority fires (expedite_kind). downstream list should have exactly 1 entry.
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.cascade.appliedEvent).toBeDefined();
      expect(res.cascade.appliedEvent.type).toBe("work_order.change.applied");
      const applied = res.cascade.appliedEvent.payload as ChangeAppliedPayload;
      expect(applied.changeOrderId).toBe("co-1");
      expect(applied.effectsFired).toEqual(["priority"]);
      expect(applied.downstreamEventIds).toHaveLength(1);
      expect(applied.downstreamEventIds[0]).toBe(res.cascade.priorityEvent?.id);
    });

    it("lists downstream event ids in emission order for a full cascade", async () => {
      const PREV = "2026-04-22T15:00:00.000Z";
      const FAR = "2026-04-22T16:30:00.000Z";
      const res = await engine.applyChangeOrderEffects({
        changeOrder: makeChangeOrder({ kind: "expedite" }),
        actor: SUPERVISOR,
        hints: {
          forceRoutingRecompute: true,
          invalidatedStepIds: ["step-1"],
          previousEtaIso: PREV,
          newEtaIso: FAR,
        },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const applied = res.cascade.appliedEvent.payload as ChangeAppliedPayload;
      expect(applied.effectsFired).toEqual([
        "routing",
        "tasks",
        "eta",
        "priority",
      ]);
      expect(applied.downstreamEventIds).toEqual([
        res.cascade.routingEvent?.id,
        res.cascade.tasksEvent?.id,
        res.cascade.etaEvent?.id,
        res.cascade.priorityEvent?.id,
      ]);

      // Envelope always appends last to the event log.
      const all = await log.listByWorkOrder("wo-1");
      expect(all[all.length - 1]?.type).toBe("work_order.change.applied");
      expect(all.map((e) => e.type)).toEqual([
        "work_order.routing.recomputed",
        "work_order.tasks.regenerated",
        "work_order.eta.recalculated",
        "work_order.priority.escalated",
        "work_order.change.applied",
      ]);
    });
  });
});
