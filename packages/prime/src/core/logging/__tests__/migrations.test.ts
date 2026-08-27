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

/**
 * PRIME Engine — event migrations registry tests
 *
 * Covers identity pass-through, single-hop, multi-hop chaining, rejection of
 * non-step migrations, and duplicate-registration guard.
 */

import { describe, it, expect } from "vitest";
import {
  EventMigrationRegistry,
  createEventMigrationRegistry,
  type EventMigration,
} from "../migrations.js";
import type { WorkOrderEvent } from "../../../models/events.js";

/** Build a synthetic event for a given type + payload, with fixed metadata. */
function makeEvent(
  type: WorkOrderEvent["type"],
  payload: unknown,
  sequenceNumber = 1
): WorkOrderEvent {
  return {
    id: `evt-${sequenceNumber}`,
    sequenceNumber,
    workOrderId: "wo-test",
    type,
    actor: { kind: "system", source: "test" },
    timestamp: "2026-04-22T00:00:00.000Z",
    payload,
  };
}

describe("EventMigrationRegistry", () => {
  it("returns the event unchanged when no migrations are registered", () => {
    const registry = new EventMigrationRegistry();
    const original = makeEvent("work_order.intake.created", { source: "portal" });
    const out = registry.apply(original);
    expect(out).toBe(original);
  });

  it("applies a single-hop migration (v1 -> v2)", () => {
    const migration: EventMigration<{ source: string }, { source: string; channel: string }> = {
      eventType: "work_order.intake.created",
      fromVersion: 1,
      toVersion: 2,
      migrate: (p) => ({ ...p, channel: "legacy" }),
    };
    const registry = createEventMigrationRegistry([migration]);

    const original = makeEvent("work_order.intake.created", { source: "portal" });
    const out = registry.apply(original);

    expect(out).not.toBe(original);
    const payload = out.payload as { source: string; channel: string; schemaVersion: number };
    expect(payload.source).toBe("portal");
    expect(payload.channel).toBe("legacy");
    expect(payload.schemaVersion).toBe(2);
  });

  it("chains multiple migrations (v1 -> v2 -> v3)", () => {
    const registry = createEventMigrationRegistry([
      {
        eventType: "work_order.intake.created",
        fromVersion: 1,
        toVersion: 2,
        migrate: (p) => ({ ...(p as object), channel: "legacy" }),
      },
      {
        eventType: "work_order.intake.created",
        fromVersion: 2,
        toVersion: 3,
        migrate: (p) => ({ ...(p as object), tenantId: "tenant-a" }),
      },
    ]);

    const original = makeEvent("work_order.intake.created", { source: "portal" });
    const out = registry.apply(original);

    const payload = out.payload as {
      source: string;
      channel: string;
      tenantId: string;
      schemaVersion: number;
    };
    expect(payload.source).toBe("portal");
    expect(payload.channel).toBe("legacy");
    expect(payload.tenantId).toBe("tenant-a");
    expect(payload.schemaVersion).toBe(3);
  });

  it("resumes from the payload's existing schemaVersion", () => {
    const registry = createEventMigrationRegistry([
      {
        eventType: "work_order.intake.created",
        fromVersion: 1,
        toVersion: 2,
        migrate: () => {
          throw new Error("v1 migration should not run — payload is already v2");
        },
      },
      {
        eventType: "work_order.intake.created",
        fromVersion: 2,
        toVersion: 3,
        migrate: (p) => ({ ...(p as object), tenantId: "tenant-a" }),
      },
    ]);

    const original = makeEvent("work_order.intake.created", {
      source: "portal",
      schemaVersion: 2,
    });
    const out = registry.apply(original);

    const payload = out.payload as { tenantId: string; schemaVersion: number };
    expect(payload.tenantId).toBe("tenant-a");
    expect(payload.schemaVersion).toBe(3);
  });

  it("reports the latest version reachable for an event type", () => {
    const registry = createEventMigrationRegistry([
      {
        eventType: "step.completed",
        fromVersion: 1,
        toVersion: 2,
        migrate: (p) => p,
      },
      {
        eventType: "step.completed",
        fromVersion: 2,
        toVersion: 3,
        migrate: (p) => p,
      },
    ]);

    expect(registry.latestVersion("step.completed")).toBe(3);
    expect(registry.latestVersion("work_order.completed")).toBe(1);
  });

  it("rejects non-single-step migrations", () => {
    const registry = new EventMigrationRegistry();
    expect(() =>
      registry.register({
        eventType: "step.completed",
        fromVersion: 1,
        toVersion: 3,
        migrate: (p) => p,
      })
    ).toThrow(/single-step/);
  });

  it("rejects duplicate (eventType, fromVersion) registration", () => {
    const registry = new EventMigrationRegistry();
    registry.register({
      eventType: "step.completed",
      fromVersion: 1,
      toVersion: 2,
      migrate: (p) => p,
    });
    expect(() =>
      registry.register({
        eventType: "step.completed",
        fromVersion: 1,
        toVersion: 2,
        migrate: (p) => p,
      })
    ).toThrow(/duplicate migration/);
  });

  it("passes through events of unregistered types", () => {
    const registry = createEventMigrationRegistry([
      {
        eventType: "work_order.intake.created",
        fromVersion: 1,
        toVersion: 2,
        migrate: (p) => ({ ...(p as object), channel: "x" }),
      },
    ]);

    const original = makeEvent("step.completed", { durationMs: 1234 });
    const out = registry.apply(original);
    expect(out).toBe(original);
  });
});
