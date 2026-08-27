/*
 * Copyright © 2026 Steven. All Rights Reserved.
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

import { beforeEach, describe, expect, it } from "vitest";
import type {
  AppendEventInput,
  EventActor,
} from "../../../models/events.js";
import { createInMemoryEventLog } from "../inMemoryEventLog.js";
import type { EventLog } from "../eventLog.js";

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

const SYSTEM_ROUTING: EventActor = {
  kind: "system",
  source: "prime.routing",
};

function intakeCreated(
  workOrderId: string,
  actor: EventActor = SUPERVISOR
): AppendEventInput<{ source: string }> {
  return {
    workOrderId,
    type: "work_order.intake.created",
    actor,
    payload: { source: "manual" },
  };
}

describe("inMemoryEventLog", () => {
  let log: EventLog;

  beforeEach(() => {
    log = createInMemoryEventLog();
  });

  describe("append", () => {
    it("returns the stored event with id, sequenceNumber, and timestamp assigned", async () => {
      const event = await log.append(intakeCreated("wo-1"));

      expect(event.id).toBeTruthy();
      expect(typeof event.id).toBe("string");
      expect(event.sequenceNumber).toBe(1);
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-ish
      expect(event.workOrderId).toBe("wo-1");
      expect(event.type).toBe("work_order.intake.created");
      expect(event.actor).toEqual(SUPERVISOR);
      expect(event.payload).toEqual({ source: "manual" });
    });

    it("assigns monotonically increasing sequenceNumbers", async () => {
      const e1 = await log.append(intakeCreated("wo-1"));
      const e2 = await log.append(intakeCreated("wo-2"));
      const e3 = await log.append(intakeCreated("wo-3"));

      expect(e1.sequenceNumber).toBe(1);
      expect(e2.sequenceNumber).toBe(2);
      expect(e3.sequenceNumber).toBe(3);
    });

    it("freezes the returned event so it cannot be mutated", async () => {
      const event = await log.append(intakeCreated("wo-1"));

      expect(Object.isFrozen(event)).toBe(true);
      // Attempting to overwrite a top-level field should throw in strict mode,
      // and at minimum must not change the value.
      expect(() => {
        (event as any).type = "work_order.cancelled";
      }).toThrow();
      expect(event.type).toBe("work_order.intake.created");
    });

    it("supports optional stepId for step-level events", async () => {
      const event = await log.append({
        workOrderId: "wo-1",
        stepId: "step-42",
        type: "step.started",
        actor: SUPERVISOR,
        payload: { stationId: "station-a" },
      });

      expect(event.stepId).toBe("step-42");
    });

    it("accepts system actors", async () => {
      const event = await log.append({
        workOrderId: "wo-1",
        type: "work_order.routing.assigned",
        actor: SYSTEM_ROUTING,
        payload: { stationId: "station-a" },
      });

      expect(event.actor).toEqual(SYSTEM_ROUTING);
    });

    it("throws on empty workOrderId", async () => {
      await expect(
        log.append({
          workOrderId: "",
          type: "work_order.intake.created",
          actor: SUPERVISOR,
          payload: {},
        })
      ).rejects.toThrow(/workOrderId/);
    });

    it("throws on missing actor", async () => {
      await expect(
        log.append({
          workOrderId: "wo-1",
          type: "work_order.intake.created",
          // @ts-expect-error — exercising the runtime guard
          actor: undefined,
          payload: {},
        })
      ).rejects.toThrow(/actor/);
    });
  });

  describe("listByWorkOrder", () => {
    it("returns only events for the requested work order, in append order", async () => {
      await log.append(intakeCreated("wo-1"));
      await log.append(intakeCreated("wo-2"));
      await log.append({
        workOrderId: "wo-1",
        type: "step.started",
        actor: SUPERVISOR,
        payload: {},
      });

      const wo1 = await log.listByWorkOrder("wo-1");
      const wo2 = await log.listByWorkOrder("wo-2");

      expect(wo1).toHaveLength(2);
      expect(wo1[0].type).toBe("work_order.intake.created");
      expect(wo1[1].type).toBe("step.started");
      expect(wo2).toHaveLength(1);
    });

    it("returns empty array for unknown work order", async () => {
      await log.append(intakeCreated("wo-1"));
      const events = await log.listByWorkOrder("wo-ghost");
      expect(events).toEqual([]);
    });
  });

  describe("listByType", () => {
    it("returns only events of the requested type, across all work orders", async () => {
      await log.append(intakeCreated("wo-1"));
      await log.append(intakeCreated("wo-2"));
      await log.append({
        workOrderId: "wo-1",
        type: "step.started",
        actor: SUPERVISOR,
        payload: {},
      });

      const intakeEvents = await log.listByType("work_order.intake.created");
      const stepStarts = await log.listByType("step.started");

      expect(intakeEvents).toHaveLength(2);
      expect(stepStarts).toHaveLength(1);
    });
  });

  describe("listSince", () => {
    it("returns only events with sequenceNumber greater than the cursor", async () => {
      await log.append(intakeCreated("wo-1")); // seq 1
      await log.append(intakeCreated("wo-2")); // seq 2
      await log.append(intakeCreated("wo-3")); // seq 3

      const sinceZero = await log.listSince(0);
      const sinceOne = await log.listSince(1);
      const sinceThree = await log.listSince(3);

      expect(sinceZero).toHaveLength(3);
      expect(sinceOne).toHaveLength(2);
      expect(sinceOne[0].workOrderId).toBe("wo-2");
      expect(sinceThree).toEqual([]);
    });
  });

  describe("size", () => {
    it("reports 0 for a fresh log", async () => {
      expect(await log.size()).toBe(0);
    });

    it("tracks append count", async () => {
      await log.append(intakeCreated("wo-1"));
      await log.append(intakeCreated("wo-2"));
      expect(await log.size()).toBe(2);
    });
  });

  describe("options", () => {
    it("uses a custom id generator when provided", async () => {
      let counter = 0;
      const deterministic = createInMemoryEventLog({
        idGenerator: () => `evt-${++counter}`,
      });

      const e1 = await deterministic.append(intakeCreated("wo-1"));
      const e2 = await deterministic.append(intakeCreated("wo-2"));

      expect(e1.id).toBe("evt-1");
      expect(e2.id).toBe("evt-2");
    });

    it("uses a custom clock when provided", async () => {
      const fixed = new Date("2026-01-15T10:00:00.000Z");
      const deterministic = createInMemoryEventLog({
        clock: () => fixed,
      });

      const event = await deterministic.append(intakeCreated("wo-1"));
      expect(event.timestamp).toBe("2026-01-15T10:00:00.000Z");
    });

    it("each log instance has its own independent sequence counter", async () => {
      const a = createInMemoryEventLog();
      const b = createInMemoryEventLog();

      const aEvent = await a.append(intakeCreated("wo-1"));
      const bEvent = await b.append(intakeCreated("wo-1"));

      expect(aEvent.sequenceNumber).toBe(1);
      expect(bEvent.sequenceNumber).toBe(1);
    });
  });
});
