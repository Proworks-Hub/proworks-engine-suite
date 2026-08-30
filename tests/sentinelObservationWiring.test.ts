// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";

import { telemetryContextSchema, type TelemetryContext } from "@proworks-hub/contracts";
import {
  classify,
  createAlertDeduplicator,
  fingerprintOf,
  observationAuthorizesResponse,
  pipelineMayContain,
  toSentinelObservation,
  type Baseline,
} from "@proworks-hub/platform-runtime";
import { createSentinelIq } from "@proworks-hub/sentineliq";

// ─────────────────────────────────────────────────────────────────────────────
// CLOSING THE OLDEST GAP ON THE DEBT LIST.
//
// Phase 6 built a detector. SentinelIQ has always had somewhere to put
// findings. For five phases nothing connected them, and this file's own
// header said Sentinel "might" read the classification — which is precisely
// the shape of a thing that never gets wired.
//
// A detector nobody reads is the same defect as a field nobody reads, and this
// codebase has now found that shape nine times. This is the tenth, closed.
//
// WHY THE WIRING IS A HOST'S JOB
//
// SentinelIQ and platform-runtime are both platform tier, and the dependency
// law says `platform: []` — neither may import the other. So the pipeline
// builds a value and a host calls `observe()`. This test IS that host, which
// is the same arrangement that proved the Phase 1B admission chain.
// ─────────────────────────────────────────────────────────────────────────────

const context = (over: Partial<TelemetryContext> = {}): TelemetryContext =>
  telemetryContextSchema.parse({
    timestamp: "2026-08-29T12:00:00.000Z",
    globalInstanceId: "hive.instance.a",
    tenantId: "ksix",
    engineId: "workorderiq",
    engineVersion: "0.19.0",
    trace: { correlationId: "ORDER-123" },
    releaseChannel: "stable",
    trustState: "trusted",
    sensitivity: "internal",
    ...over,
  });

const baseline: Baseline = {
  engineId: "workorderiq",
  engineVersion: "0.19.0",
  metric: "p95LatencyMs",
  mean: 100,
  stdDev: 10,
  samples: 500,
};

const sentinel = () => createSentinelIq({ now: () => new Date("2026-08-29T12:00:00.000Z") });

function observe(observedValue: number, over: Partial<TelemetryContext> = {}) {
  const classification = classify({ baseline, observed: observedValue });
  return toSentinelObservation({
    classification,
    context: context(over),
    metric: "p95LatencyMs",
    findingId: `f_${observedValue}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("what the pipeline classifies, Sentinel can actually record", () => {
  it("produces a finding SentinelIQ accepts", () => {
    // The whole point. Not "could be adapted to accept" — accepts, parsed by
    // its own schema, with every required field present.
    const s = sentinel();
    const observation = observe(140); // 4σ — an incident
    expect(observation).not.toBeNull();

    const result = s.observe(observation);
    expect(result.recorded).toBe(true);
    if (!result.recorded) return;
    expect(result.finding.finding.kind).toBe("engine_health");
    expect(s.count()).toBe(1);
  });

  it("carries the required uncertainty, so the finding parses at all", () => {
    // SentinelIQ refuses anything short of `confirmed` that does not state
    // what is unknown. The bridge cannot produce `confirmed`, so this field is
    // not optional in practice — and it says the true thing rather than a
    // placeholder.
    const observation = observe(140);
    expect(observation?.uncertainty).toMatch(/deviation from baseline is not a cause/);
    expect(sentinel().observe(observation).recorded).toBe(true);
  });

  it("raises nothing for an ordinary observation", () => {
    // The lowest rung exists to make baselines possible, not to be reported. A
    // finding per observation would bury the ones that matter under the ones
    // that did not.
    expect(observe(102)).toBeNull();
    expect(observe(105)).toBeNull();
  });

  it("climbs severity with the deviation, and stops short of catastrophic", () => {
    // Catastrophic is reserved for threats to users, protected data,
    // constitutional integrity or Hive survival. A latency five sigma out is
    // none of those, and inflating it would put a slow afternoon in the same
    // bucket as a breach — after which nobody reads the bucket.
    expect(observe(125)?.severity).toBe("moderate");
    expect(observe(140)?.severity).toBe("high");
    expect(observe(1_000)?.severity).toBe("high");
    expect(observe(1_000)?.severity).not.toBe("catastrophic");
  });

  it("never claims to have confirmed anything", () => {
    // The detector observed a number further from the mean than usual. It did
    // not establish a cause, and it cannot.
    expect(observe(125)?.confidence).toBe("suspected");
    expect(observe(1_000)?.confidence).toBe("probable");
    for (const value of [125, 140, 1_000]) {
      expect(observe(value)?.confidence).not.toBe("confirmed");
    }
  });

  it("classifies a slow engine as engine_health, not as a security event", () => {
    // A statistical deviation is not evidence of an intrusion. Classifying it
    // as one would let a slow database open a security investigation.
    expect(observe(1_000)?.kind).toBe("engine_health");
  });

  it("names the engine as the subject and the tenant when there is one", () => {
    const observation = observe(140);
    expect(observation?.subject.kind).toBe("engine");
    expect(observation?.subject.id).toBe("workorderiq");
    expect(observation?.subject.tenant?.organizationId).toBe("ksix");
  });

  it("leaves the tenant off an instance-wide signal", () => {
    // Absent means Hive-wide in SentinelIQ's own vocabulary. Filling it with a
    // placeholder would make every instance-wide finding look like one shop's.
    const observation = observe(140, { tenantId: undefined });
    expect(observation?.subject.tenant).toBeUndefined();
  });

  it("carries a reference rather than the telemetry itself", () => {
    // Evidence is a locator. A finding that embedded the observations would
    // put operational data inside the security record.
    const observation = observe(140);
    expect(observation?.evidence[0]?.sourceKind).toBe("telemetry");
    expect(observation?.evidence[0]?.locator).toBe(
      fingerprintOf(context(), "p95LatencyMs"),
    );
  });

  it("keeps the correlation, so a finding joins the workflow it came from", () => {
    const observation = observe(140);
    expect(observation?.trace?.correlationId).toBe("ORDER-123");
  });
});

describe("the connection did not hand Sentinel any new authority", () => {
  it("observes without containing", () => {
    // Sentinel now receives what the pipeline classifies. What it may DO about
    // that is governed exactly as it was before — the ladder is SentinelIQ's
    // and Governance authorizes its use.
    expect(observationAuthorizesResponse()).toBe(false);
    expect(pipelineMayContain()).toBe(false);
  });

  it("still refuses to suppress a finding once recorded", () => {
    // SentinelIQ's own rule, re-asserted because this phase increased how much
    // reaches it. More findings arriving is a reason to check that none of
    // them can quietly leave.
    const s = sentinel();
    s.observe(observe(140));
    expect(Object.keys(s)).not.toContain("suppress");
    expect(Object.keys(s)).not.toContain("delete");
    expect(s.count()).toBe(1);
  });
});

describe("the deduplicator and the bridge work on the same fingerprint", () => {
  it("does not send Sentinel four hundred copies of one condition", () => {
    // The two halves of Phase 6, now joined. Without this the connection would
    // have made the notification storm worse rather than better: every
    // classification would become a finding.
    const dedup = createAlertDeduplicator({
      windowMs: 60_000,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    const s = sentinel();
    const fingerprint = fingerprintOf(context(), "p95LatencyMs");

    let recorded = 0;
    for (let i = 0; i < 400; i += 1) {
      const classification = classify({ baseline, observed: 140 });
      const decision = dedup.consider({ fingerprint, signalClass: classification.signalClass });
      if (!decision.notify) continue;

      const observation = toSentinelObservation({
        classification,
        context: context(),
        metric: "p95LatencyMs",
        findingId: `f_${i}`,
      });
      if (observation && s.observe(observation).recorded) recorded += 1;
    }

    expect(recorded).toBe(1);
    expect(dedup.pending()[fingerprint]).toBe(400);
  });

  it("lets an escalation through", () => {
    // The condition getting worse is new information, and it must reach
    // Sentinel even inside the suppression window.
    const dedup = createAlertDeduplicator({
      windowMs: 60_000,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    const s = sentinel();
    const fingerprint = fingerprintOf(context(), "p95LatencyMs");
    const record = (value: number, id: string): void => {
      const classification = classify({ baseline, observed: value });
      if (!dedup.consider({ fingerprint, signalClass: classification.signalClass }).notify) return;
      const observation = toSentinelObservation({
        classification,
        context: context(),
        metric: "p95LatencyMs",
        findingId: id,
      });
      if (observation) s.observe(observation);
    };

    record(125, "f1"); // warning — notified
    record(125, "f2"); // suppressed
    record(1_000, "f3"); // escalation — notified again
    expect(s.count()).toBe(2);
  });
});

describe("Sentinel's own health reflects what it now sees", () => {
  it("counts the open findings the pipeline produced", () => {
    // The end of the chain: a detector fires, a finding is recorded, and
    // Sentinel's own health report changes. Before this the first two happened
    // in different halves of the system and the third never moved.
    const s = sentinel();
    const onEvent = vi.fn();
    void onEvent;

    s.observe(observe(140, { engineId: "workorderiq" }));
    s.observe(observe(1_000, { engineId: "costiq" }));

    const health = s.health();
    expect(health.openFindings).toBe(2);
    expect(health.unresolvedCatastrophic).toBe(0);
  });
});
