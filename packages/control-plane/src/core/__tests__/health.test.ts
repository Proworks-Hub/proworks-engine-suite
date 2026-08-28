// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTH_POLICY,
  ENGINE_STATES,
  deriveEngineHealth,
  engineStateSchema,
  summariseFleet,
  type EngineHeartbeat,
} from "../health.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const fresh = new Date(NOW - 5_000).toISOString();

const beat = (over: Partial<EngineHeartbeat> = {}): EngineHeartbeat => ({
  engineId: "forgeiq",
  version: "2.1.4",
  observedAt: fresh,
  jobsProcessed: 1_000,
  jobsFailed: 0,
  openCircuits: [],
  maintenance: false,
  ...over,
});

const derive = (heartbeat: EngineHeartbeat | undefined) =>
  deriveEngineHealth("forgeiq", heartbeat, { now: NOW });

describe("silence is not health", () => {
  it("reports no telemetry as unknown, never as operational", () => {
    // The failure this whole model exists to prevent: a dashboard that renders
    // green because nothing arrived is actively reassuring during the exact
    // incident it was built for.
    const health = derive(undefined);
    expect(health.state).toBe("unknown");
    expect(health.reason).toContain("no telemetry");
  });

  it("goes unknown once a heartbeat is stale, whatever it last said", () => {
    const stale = beat({
      observedAt: new Date(NOW - DEFAULT_HEALTH_POLICY.staleAfterMs - 1_000).toISOString(),
      jobsProcessed: 5_000,
      jobsFailed: 0,
    });
    expect(derive(stale).state).toBe("unknown");
  });

  it("goes unknown on a timestamp it cannot read", () => {
    expect(derive(beat({ observedAt: "moments ago" })).state).toBe("unknown");
  });

  it("asks for attention when it does not know", () => {
    expect(ENGINE_STATES.unknown.demandsAttention).toBe(true);
  });
});

describe("turning numbers into a state", () => {
  it("stays operational with a clean run", () => {
    const health = derive(beat());
    expect(health.state).toBe("operational");
    expect(health.version).toBe("2.1.4");
  });

  it("does not colour the dashboard from two failed jobs", () => {
    // Two failures out of two is a 100% failure rate and almost certainly means
    // the engine has barely been asked to do anything.
    expect(derive(beat({ jobsProcessed: 2, jobsFailed: 2 })).state).toBe("operational");
  });

  it("warns, degrades and fails as the rate climbs on a real sample", () => {
    expect(derive(beat({ jobsProcessed: 1_000, jobsFailed: 20 })).state).toBe("warning");
    expect(derive(beat({ jobsProcessed: 1_000, jobsFailed: 80 })).state).toBe("degraded");
    expect(derive(beat({ jobsProcessed: 1_000, jobsFailed: 700 })).state).toBe("failed");
  });

  it("calls an open circuit degraded even while the failure rate looks fine", () => {
    // The rate looks healthy precisely because the engine stopped trying. A
    // console that trusts the rate here reports an engine as operational while
    // it silently serves nothing.
    const health = derive(beat({ jobsProcessed: 1_000, jobsFailed: 0, openCircuits: ["pricing-api"] }));
    expect(health.state).toBe("degraded");
    expect(health.reason).toContain("pricing-api");
  });

  it("shows a deep queue as busy rather than as a problem", () => {
    expect(derive(beat({ queueDepth: 200 })).state).toBe("busy");
  });

  it("lets maintenance win over everything, so a planned outage pages nobody", () => {
    const health = derive(
      beat({ maintenance: true, jobsProcessed: 1_000, jobsFailed: 900, openCircuits: ["db"] }),
    );
    expect(health.state).toBe("maintenance");
    expect(ENGINE_STATES.maintenance.demandsAttention).toBe(false);
  });

  it("explains itself in numbers somebody can act on", () => {
    // "Degraded" alone sends someone digging through logs to find what the
    // console already knew.
    const health = derive(beat({ jobsProcessed: 340, jobsFailed: 28 }));
    expect(health.reason).toContain("340");
    expect(health.reason).toMatch(/8\.2%/);
  });
});

describe("saying it without relying on colour", () => {
  it("gives every state a label and an icon as well as a severity", () => {
    // Roughly one man in twelve cannot separate the amber warning from the
    // green operational, and the person on call is whoever is on call.
    for (const state of engineStateSchema.options) {
      const descriptor = ENGINE_STATES[state];
      expect(descriptor.label.length, state).toBeGreaterThan(2);
      expect(descriptor.icon.length, state).toBeGreaterThan(2);
    }
    const labels = engineStateSchema.options.map((s) => ENGINE_STATES[s].label);
    expect(new Set(labels).size).toBe(labels.length);
    const icons = engineStateSchema.options.map((s) => ENGINE_STATES[s].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("slows a failing engine down instead of making it flash", () => {
    // A frantic card makes an incident harder to read. The red marker already
    // did the alarming; the operator now needs to think.
    expect(ENGINE_STATES.failed.motion).toBeLessThan(ENGINE_STATES.operational.motion);
    expect(ENGINE_STATES.degraded.motion).toBeLessThan(ENGINE_STATES.operational.motion);
    expect(ENGINE_STATES.busy.motion).toBeGreaterThan(ENGINE_STATES.operational.motion);
    expect(ENGINE_STATES.maintenance.motion).toBe(0);
  });
});

describe("the one line at the top of the dashboard", () => {
  const healthy = (id: string) => deriveEngineHealth(id, beat({ engineId: id }), { now: NOW });

  it("says all clear only when everything is", () => {
    const summary = summariseFleet([healthy("a"), healthy("b"), healthy("c")]);
    expect(summary.worst).toBe("operational");
    expect(summary.label).toBe("All systems operational");
    expect(summary.online).toBe(3);
  });

  it("reports the worst engine, never an average", () => {
    // Averaging health is how seven healthy engines hide one that is on fire,
    // and "87% healthy" is a number nobody can act on.
    const burning = deriveEngineHealth("visioniq", beat({ jobsProcessed: 1_000, jobsFailed: 900 }), { now: NOW });
    const summary = summariseFleet([healthy("a"), healthy("b"), burning]);
    expect(summary.worst).toBe("failed");
    expect(summary.needingAttention[0]?.engineId).toBe("visioniq");
  });

  it("puts the most urgent engine first", () => {
    const warn = deriveEngineHealth("a", beat({ jobsProcessed: 1_000, jobsFailed: 20 }), { now: NOW });
    const dead = deriveEngineHealth("b", undefined, { now: NOW });
    const broken = deriveEngineHealth("c", beat({ jobsProcessed: 1_000, jobsFailed: 900 }), { now: NOW });
    const summary = summariseFleet([warn, dead, broken]);
    expect(summary.needingAttention.map((h) => h.engineId)).toEqual(["c", "a", "b"]);
  });

  it("does not claim all clear when it knows nothing", () => {
    // An empty fleet is a console that has not connected, not a healthy one.
    const summary = summariseFleet([]);
    expect(summary.worst).toBe("unknown");
    expect(summary.label).not.toBe("All systems operational");
  });
});
