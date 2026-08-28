// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createHeartbeatCollector, heartbeatCaveat } from "../heartbeat.js";
import { deriveEngineHealth } from "../health.js";
import { activitiesFor, deriveOperationalState } from "../operationalState.js";
import { SUITE_MANIFESTS, forgeIqManifest, costIqManifest, inventoryIqManifest } from "../../manifests/index.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const event = (service: string, eventType: string, msAgo = 1_000) => ({
  eventId: `e-${service}-${eventType}-${msAgo}`,
  eventType,
  source: { service },
  occurredAt: at(msAgo),
  publishedAt: at(msAgo),
  trace: { correlationId: "c-1" },
  payload: {},
});

const collector = () =>
  createHeartbeatCollector({ manifests: SUITE_MANIFESTS, now: () => NOW });

describe("heartbeats assembled from what is actually known", () => {
  it("knows nothing about an engine that has done nothing", () => {
    expect(collector().get("forgeiq")).toBeUndefined();
  });

  it("derives liveness and throughput from published events", () => {
    // An engine publishing events is demonstrably alive and demonstrably
    // working, without needing a health endpoint inside a portable package.
    const c = collector();
    c.observe(event("forgeiq", "manufacturing.plan.generated", 5_000));
    c.observe(event("forgeiq", "manufacturing.plan.generated", 3_000));
    c.observe(event("forgeiq", "configurator.rules.evaluated", 1_000));

    const heartbeat = c.get("forgeiq")!;
    expect(heartbeat.source).toBe("derived");
    expect(heartbeat.jobsProcessed).toBe(3);
    expect(heartbeat.jobsFailed).toBe(0);
    expect(heartbeat.observedAt).toBe(at(1_000));
  });

  it("counts failures from the manifest's own alert mappings", () => {
    // Not from a naming convention. Guessing that anything ending `.failed` is
    // a failure works until an engine publishes `retry.failed.recovered`, and
    // then the dashboard reports an incident that did not happen.
    const c = collector();
    c.observe(event("forgeiq", "manufacturing.plan.generated"));
    c.observe(event("forgeiq", "configurator.rule.blocked"));

    const heartbeat = c.get("forgeiq")!;
    expect(heartbeat.jobsProcessed).toBe(2);
    expect(heartbeat.jobsFailed).toBe(1);
  });

  it("does not invent a version it cannot observe", () => {
    // Events carry no version. "unreported" reads as an absence in the versions
    // panel; a fabricated "unknown" reads like something the engine said.
    const c = collector();
    c.observe(event("costiq", "cost.calculation.completed"));
    expect(c.get("costiq")!.version).toBe("unreported");
  });

  it("uses the host's version table when the host has one", () => {
    const c = createHeartbeatCollector({
      manifests: SUITE_MANIFESTS,
      now: () => NOW,
      versions: { costiq: "1.8.2" },
    });
    c.observe(event("costiq", "cost.calculation.completed"));
    expect(c.get("costiq")!.version).toBe("1.8.2");
  });

  it("omits queue depth rather than reporting zero", () => {
    // A queue depth of 0 on an engine with a backlog is worse than none at all.
    const c = collector();
    c.observe(event("costiq", "cost.calculation.completed"));
    expect(c.get("costiq")!.queueDepth).toBeUndefined();
  });

  it("prefers what a host reports over what it inferred", () => {
    // A host that runs the engine knows its queue depth. No amount of
    // event-watching will discover it.
    const c = collector();
    c.observe(event("costiq", "cost.calculation.completed"));
    c.report({
      engineId: "costiq",
      version: "1.8.2",
      observedAt: at(500),
      jobsProcessed: 3_721,
      jobsFailed: 7,
      openCircuits: [],
      maintenance: false,
      queueDepth: 12,
    });

    const heartbeat = c.get("costiq")!;
    expect(heartbeat.source).toBe("reported");
    expect(heartbeat.jobsProcessed).toBe(3_721);
    expect(heartbeat.queueDepth).toBe(12);
    // The observed events are still counted, so the two can be compared.
    expect(heartbeat.observedEvents).toBe(1);
  });

  it("drops events that fall out of the window", () => {
    const c = createHeartbeatCollector({
      manifests: SUITE_MANIFESTS,
      now: () => NOW,
      windowMs: 10_000,
    });
    c.observe(event("costiq", "cost.calculation.completed", 60_000));
    c.observe(event("costiq", "cost.calculation.completed", 2_000));
    expect(c.get("costiq")!.jobsProcessed).toBe(1);
  });

  it("ignores anything that is not an event", () => {
    const c = collector();
    for (const junk of [null, undefined, 7, "event", [], {}, { eventType: "x.y" }]) {
      expect(() => c.observe(junk)).not.toThrow();
    }
    expect(c.snapshot()).toEqual([]);
  });

  it("says out loud what a derived heartbeat cannot tell you", () => {
    // An idle engine publishes nothing. So does a stopped one. An operator who
    // reads "No telemetry" on a healthy-but-quiet engine learns to ignore the
    // state, which is the state that matters most.
    const c = collector();
    c.observe(event("costiq", "cost.calculation.completed"));
    expect(heartbeatCaveat(c.get("costiq"))).toContain("idle engine and a stopped one");

    c.report({
      engineId: "costiq", version: "1.8.2", observedAt: at(500),
      jobsProcessed: 10, jobsFailed: 0, openCircuits: [], maintenance: false,
    });
    expect(heartbeatCaveat(c.get("costiq"))).toBeUndefined();
  });

  it("feeds straight into health derivation", () => {
    const c = collector();
    for (let i = 0; i < 40; i += 1) c.observe(event("forgeiq", "manufacturing.plan.generated", 1_000 + i));
    const health = deriveEngineHealth("forgeiq", c.get("forgeiq"), { now: NOW });
    expect(health.state).toBe("operational");
  });
});

describe("what an engine is doing", () => {
  const healthy = (id: string) =>
    deriveEngineHealth(
      id,
      {
        engineId: id, version: "1.0.0", observedAt: at(1_000),
        jobsProcessed: 500, jobsFailed: 0, openCircuits: [], maintenance: false,
      },
      { now: NOW },
    );

  it("reads the engine's own word for it", () => {
    // "Generating plan" is what an engineer wants to see. Flattening it to
    // "Processing" is how a console becomes useless exactly when someone is
    // debugging.
    const state = deriveOperationalState({
      manifest: forgeIqManifest,
      health: healthy("forgeiq"),
      lastEvent: { eventType: "manufacturing.plan.generated", at: at(2_000) },
      now: NOW,
    });
    expect(state.activity).toBe("generating_plan");
    expect(state.label).toBe("Generating plan");
    expect(state.normalized).toBe("processing");
    expect(state.fromHealth).toBe(false);
  });

  it("lets a manifest override the shared word where the default is wrong", () => {
    // CostIQ's work is calculating, not generic processing.
    const state = deriveOperationalState({
      manifest: costIqManifest,
      health: healthy("costiq"),
      lastEvent: { eventType: "cost.calculation.completed", at: at(2_000) },
      now: NOW,
    });
    expect(state.normalized).toBe("calculating");
  });

  it("decays to idle rather than freezing on the last thing that happened", () => {
    // An engine reading "generating_plan" an hour later is a console that has
    // stopped updating, and looks identical to one that has.
    const state = deriveOperationalState({
      manifest: forgeIqManifest,
      health: healthy("forgeiq"),
      lastEvent: { eventType: "manufacturing.plan.generated", at: at(10 * 60_000) },
      now: NOW,
    });
    expect(state.normalized).toBe("idle");
    expect(state.activity).toBeUndefined();
  });

  it("lets health win whenever health is bad", () => {
    // An engine that is failing is not "calculating", whatever its last event
    // said. A busy-looking activity beside a red status sends someone looking
    // in the wrong place.
    const failing = deriveEngineHealth(
      "costiq",
      {
        engineId: "costiq", version: "1.0.0", observedAt: at(1_000),
        jobsProcessed: 1_000, jobsFailed: 900, openCircuits: [], maintenance: false,
      },
      { now: NOW },
    );
    const state = deriveOperationalState({
      manifest: costIqManifest,
      health: failing,
      lastEvent: { eventType: "cost.calculation.completed", at: at(1_000) },
      now: NOW,
    });
    expect(state.normalized).toBe("failed");
    expect(state.fromHealth).toBe(true);
  });

  it("treats an unknown engine as unknown, not idle", () => {
    const silent = deriveEngineHealth("costiq", undefined, { now: NOW });
    const state = deriveOperationalState({ manifest: costIqManifest, health: silent, now: NOW });
    expect(state.normalized).toBe("unknown");
  });

  it("is idle when healthy and quiet, which is a real state", () => {
    const state = deriveOperationalState({
      manifest: costIqManifest,
      health: healthy("costiq"),
      now: NOW,
    });
    expect(state.normalized).toBe("idle");
    expect(state.fromHealth).toBe(false);
  });

  it("ignores an event mapped to no activity vocabulary", () => {
    const state = deriveOperationalState({
      manifest: forgeIqManifest,
      health: healthy("forgeiq"),
      lastEvent: { eventType: "something.nobody.mapped", at: at(1_000) },
      now: NOW,
    });
    expect(state.normalized).toBe("idle");
  });

  it("derives the filter list from the manifest, so it cannot fall behind", () => {
    // The version where the filter is a second hand-maintained list is the
    // version where it silently cannot find half the states.
    expect(activitiesFor(inventoryIqManifest)).toEqual([
      "checking", "consuming", "oversold", "reconciling", "reserving", "shortage", "updating",
    ]);
  });

  it("gives the directive's engines their own vocabularies", () => {
    const byId = Object.fromEntries(SUITE_MANIFESTS.map((m) => [m.id, m]));
    expect(activitiesFor(byId["forgeiq"]!)).toContain("manufacturability_check");
    expect(activitiesFor(byId["visioniq"]!)).toContain("learning");
    expect(activitiesFor(byId["receiptiq"]!)).toContain("awaiting_review");
    expect(activitiesFor(byId["order-ingestion"]!)).toContain("deduplicating");
    expect(activitiesFor(byId["workorderiq"]!)).toContain("quality_check");
    expect(activitiesFor(byId["prime"]!)).toContain("coordinating");
  });
});

describe("events that arrive out of order", () => {
  it("takes the newest event, not the last one delivered", () => {
    // An at-least-once bus reorders, and a host batching a minute of reports
    // may send newest-first. Taking the last inserted made a busy engine read
    // as silent for as long as its batch spanned — an invented outage.
    const c = collector();
    c.observe(event("forgeiq", "manufacturing.plan.generated", 1_000));
    c.observe(event("forgeiq", "manufacturing.plan.generated", 120_000));
    c.observe(event("forgeiq", "manufacturing.plan.generated", 60_000));

    expect(c.get("forgeiq")!.observedAt).toBe(at(1_000));
  });

  it("stays operational when a newest-first batch arrives", () => {
    const c = collector();
    for (let i = 0; i < 60; i += 1) {
      c.observe(event("forgeiq", "manufacturing.plan.generated", i * 2_000));
    }
    expect(deriveEngineHealth("forgeiq", c.get("forgeiq"), { now: NOW }).state).toBe("operational");
  });
});
