// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  engineReadinessSchema,
  errorBudgetSchema,
  exportToCollective,
  observationGrantsAuthority,
  telemetryContextSchema,
  telemetryFailureStopsWork,
  type TelemetryContext,
} from "@proworks-hub/contracts";
import {
  classify,
  compareCohorts,
  createAlertDeduplicator,
  fingerprintOf,
  pipelineMayContain,
  type Baseline,
} from "@proworks-hub/platform-runtime";
// The heartbeat is the console's contract for what an engine reports, and it
// was EXTENDED rather than duplicated — a second health shape would be two
// answers to one question.
import { engineHeartbeatSchema } from "@proworks-hub/control-plane";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — observability and Sentinel telemetry.
//
// The six acceptance tests the directive names:
//
//   1. A trace crosses sync and async boundaries.
//   2. Sensitive fields are redacted before collective export.
//   3. Sentinel detects an injected anomaly and changes oversight state.
//   4. Alert deduplication prevents notification storms.
//   5. Beta telemetry can be compared to a stable baseline.
//   6. A telemetry outage does not stop critical business execution.
//
// The organising worry: observability is the one subsystem whose job is to copy
// information out of everywhere else, which makes it the likeliest thing here
// to become an accidental data-sharing pipeline. Every other boundary gets
// crossed by somebody deciding to cross it. This one gets crossed by somebody
// adding a label to a metric.
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

const policy = { allowedLabels: ["engineId", "engineVersion", "outcome", "releaseChannel"] };

// ─────────────────────────────────────────────────────────────────────────────
// 2 & PRIVACY
// ─────────────────────────────────────────────────────────────────────────────

describe("tenant content does not leave the instance as telemetry", () => {
  it("refuses to export a tenant-confidential signal at all", () => {
    // REFUSED, not redacted. A pipeline that sanitizes on the way out is one
    // that held the raw values — in its buffers, its retry queue and very
    // likely its own debug logs — which is the leak happening slightly later
    // and less visibly.
    const r = exportToCollective({
      context: context({ sensitivity: "tenant-confidential" }),
      labels: { engineId: "workorderiq" },
      policy,
    });
    expect(r.exportable).toBe(false);
    if (r.exportable) return;
    expect(r.reason).toMatch(/stays in the instance that produced it/);
  });

  it("refuses restricted and secret too", () => {
    for (const sensitivity of ["restricted", "secret"] as const) {
      expect(exportToCollective({ context: context({ sensitivity }), labels: {}, policy }).exportable).toBe(
        false,
      );
    }
  });

  it("exports an internal signal, so the refusals above are not vacuous", () => {
    const r = exportToCollective({
      context: context(),
      labels: { engineId: "workorderiq", outcome: "succeeded" },
      policy,
    });
    expect(r.exportable).toBe(true);
    if (!r.exportable) return;
    expect(r.labels).toEqual({ engineId: "workorderiq", outcome: "succeeded" });
  });

  it("refuses a label that names somebody's data", () => {
    // The specific mistake that keeps happening: a well-meaning label added to
    // a counter. A metric labelled by customer is a customer list.
    for (const key of ["customerName", "email", "userId", "payload", "apiKey"]) {
      const r = exportToCollective({
        context: context(),
        labels: { [key]: "whatever" },
        policy: { allowedLabels: [key] },
      });
      expect(r.exportable).toBe(false);
    }
  });

  it("drops labels that are not on the allowlist rather than passing them", () => {
    // An ALLOWLIST, not a denylist. A denylist admits every label somebody adds
    // after it was written, and the whole failure mode is somebody adding one.
    const r = exportToCollective({
      context: context(),
      labels: { engineId: "workorderiq", somethingNew: "value" },
      policy,
    });
    expect(r.exportable).toBe(true);
    if (!r.exportable) return;
    expect(Object.keys(r.labels)).toEqual(["engineId"]);
  });

  it("refuses a label whose cardinality has run away", () => {
    // Not only a cost problem. A label with fifty thousand distinct values is
    // a record of individuals arriving in the metrics store looking like
    // operations data.
    const r = exportToCollective({
      context: context(),
      labels: { outcome: "x" },
      policy: { ...policy, maxLabelValues: 100 },
      observedCardinality: { outcome: 50_000 },
    });
    expect(r.exportable).toBe(false);
    if (r.exportable) return;
    expect(r.reason).toMatch(/record of individuals/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. TRACE ACROSS BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

describe("one workflow is followable across sync and async hops", () => {
  it("carries correlation and causation on every signal", () => {
    // The synchronous hop keeps the correlation; the asynchronous one adds the
    // causation naming what produced it. Both are on the same context shape,
    // so a trace does not change vocabulary when it crosses the bus.
    const sync = context({ trace: { correlationId: "ORDER-123" } });
    const async_ = context({
      engineId: "costiq",
      trace: { correlationId: "ORDER-123", causationId: "msg_plan_generated" },
    });

    expect(sync.trace.correlationId).toBe(async_.trace.correlationId);
    expect(async_.trace.causationId).toBe("msg_plan_generated");
  });

  it("binds the instance on every signal, so a trace says where it ran", () => {
    expect(context().globalInstanceId).toBe("hive.instance.a");
  });

  it("keeps the principal as a reference, never as an object", () => {
    // A telemetry record carrying a principal would carry its roles, its trust
    // score and its tenant — a copy of the identity plane inside the metrics
    // store.
    const c = context({ principalId: "user.steven" });
    expect(typeof c.principalId).toBe("string");
    expect(telemetryContextSchema.safeParse({ ...c, principal: { roles: ["owner"] } }).success).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  engineId: "workorderiq",
  engineVersion: "0.19.0",
  metric: "p95LatencyMs",
  mean: 100,
  stdDev: 10,
  samples: 500,
  ...over,
});

describe("an injected anomaly is detected and classified", () => {
  it("climbs the classes as the deviation grows", () => {
    expect(classify({ baseline: baseline(), observed: 105 }).signalClass).toBe("observation");
    expect(classify({ baseline: baseline(), observed: 125 }).signalClass).toBe("warning");
    expect(classify({ baseline: baseline(), observed: 140 }).signalClass).toBe("incident");
    expect(classify({ baseline: baseline(), observed: 200 }).signalClass).toBe(
      "containment_candidate",
    );
  });

  it("refuses to classify from a baseline that is too thin", () => {
    // A baseline from six requests will call the seventh an incident, and the
    // first thing anyone learns from a noisy detector is to ignore it.
    const thin = classify({ baseline: baseline({ samples: 6 }), observed: 10_000 });
    expect(thin.signalClass).toBe("observation");
    expect(thin.sigma).toBeNull();
    expect(thin.reason).toMatch(/cries wolf early/);
  });

  it("treats zero variance as unknowable rather than as certainty", () => {
    // Every sample so far being identical says more about the sample than
    // about the metric.
    const flat = classify({ baseline: baseline({ stdDev: 0 }), observed: 10_000 });
    expect(flat.signalClass).toBe("observation");
    expect(flat.sigma).toBeNull();
  });

  it("does not raise an incident because something got faster", () => {
    // A two-sided test here would page somebody for an improvement.
    expect(classify({ baseline: baseline(), observed: 10 }).signalClass).toBe("observation");
  });

  it("classifies, and does not contain", () => {
    // Sentinel owns the defensive ladder; Governance authorizes its use. This
    // is the most tempting place in the system to forget that, because it is
    // where the alarming thing first becomes visible.
    const worst = classify({ baseline: baseline(), observed: 1_000 });
    expect(worst.signalClass).toBe("containment_candidate");
    expect(pipelineMayContain()).toBe(false);
    expect(observationGrantsAuthority()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────

describe("repeated conditions do not become a notification storm", () => {
  it("notifies once and counts the rest", () => {
    // A person who receives four hundred identical pages mutes the channel,
    // and a muted channel looks exactly like a quiet one on the day something
    // new happens.
    const d = createAlertDeduplicator({ windowMs: 60_000, now: () => new Date("2026-08-29T12:00:00Z") });
    const fp = "engine:workorderiq:latency";

    expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(true);
    for (let i = 0; i < 399; i += 1) {
      expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(false);
    }
    expect(d.pending()[fp]).toBe(400);
  });

  it("notifies again when the same condition gets WORSE", () => {
    // The setting that keeps deduplication from becoming suppression. A window
    // that swallowed an escalation would hide the thing everyone needed.
    const d = createAlertDeduplicator({ windowMs: 60_000, now: () => new Date("2026-08-29T12:00:00Z") });
    const fp = "engine:workorderiq:latency";

    d.consider({ fingerprint: fp, signalClass: "warning" });
    d.consider({ fingerprint: fp, signalClass: "warning" });
    const escalated = d.consider({ fingerprint: fp, signalClass: "incident" });
    expect(escalated.notify).toBe(true);
    expect(escalated.reason).toMatch(/getting worse is new information/);
  });

  it("does not notify again when it gets better", () => {
    const d = createAlertDeduplicator({ windowMs: 60_000, now: () => new Date("2026-08-29T12:00:00Z") });
    const fp = "f";
    d.consider({ fingerprint: fp, signalClass: "incident" });
    expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(false);
  });

  it("notifies again in a new window", () => {
    let ms = Date.parse("2026-08-29T12:00:00Z");
    const d = createAlertDeduplicator({ windowMs: 60_000, now: () => new Date(ms) });
    const fp = "f";
    expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(true);
    expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(false);
    ms += 120_000;
    expect(d.consider({ fingerprint: fp, signalClass: "warning" }).notify).toBe(true);
  });

  it("does not let one tenant's incident hide another's", () => {
    // The same condition in two tenants is two problems. A fingerprint that
    // omitted the tenant would merge them, and the second shop would never be
    // told.
    const a = fingerprintOf(context({ tenantId: "ksix" }), "latency");
    const b = fingerprintOf(context({ tenantId: "brighton" }), "latency");
    expect(a).not.toBe(b);

    const d = createAlertDeduplicator({ now: () => new Date("2026-08-29T12:00:00Z") });
    expect(d.consider({ fingerprint: a, signalClass: "incident" }).notify).toBe(true);
    expect(d.consider({ fingerprint: b, signalClass: "incident" }).notify).toBe(true);
  });

  it("separates versions, so a regression is not hidden by the old release", () => {
    expect(fingerprintOf(context({ engineVersion: "0.19.0" }), "latency")).not.toBe(
      fingerprintOf(context({ engineVersion: "0.20.0" }), "latency"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. COHORTS
// ─────────────────────────────────────────────────────────────────────────────

describe("a beta cohort is compared against stable with evidence", () => {
  const stable = {
    channel: "stable" as const,
    version: "0.19.0",
    requests: 10_000,
    failures: 100,
    p95LatencyMs: 200,
  };

  it("calls a worse candidate worse, and says why", () => {
    const r = compareCohorts({
      baseline: stable,
      candidate: { channel: "beta", version: "0.20.0", requests: 2_000, failures: 200, p95LatencyMs: 210 },
    });
    expect(r.verdict).toBe("worse");
    expect(r.evidence.join(" ")).toMatch(/Failure rate/);
    expect(r.evidence.join(" ")).toMatch(/p95 latency/);
  });

  it("returns INCONCLUSIVE rather than comparable on a thin candidate", () => {
    // Calling forty requests "comparable" would let a release through on the
    // strength of nobody having used it yet.
    const r = compareCohorts({
      baseline: stable,
      candidate: { channel: "beta", version: "0.20.0", requests: 40, failures: 0, p95LatencyMs: 190 },
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.confidence).toBe("low");
  });

  it("never returns a bare pass or fail", () => {
    // A promotion decision made from a binary is one nobody can argue with,
    // and the cases that matter are the ones somebody should have argued with.
    const r = compareCohorts({
      baseline: stable,
      candidate: { channel: "beta", version: "0.20.0", requests: 5_000, failures: 50, p95LatencyMs: 205 },
    });
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(["low", "moderate", "high"]).toContain(r.confidence);
  });

  it("raises confidence with sample size", () => {
    const small = compareCohorts({
      baseline: stable,
      candidate: { channel: "beta", version: "0.20.0", requests: 150, failures: 1, p95LatencyMs: 200 },
    });
    const large = compareCohorts({
      baseline: stable,
      candidate: { channel: "beta", version: "0.20.0", requests: 50_000, failures: 500, p95LatencyMs: 200 },
    });
    expect(small.confidence).toBe("low");
    expect(large.confidence).toBe("high");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 (HEALTH CONTRACT) AND 6
// ─────────────────────────────────────────────────────────────────────────────

describe("the health contract distinguishes alive from able to work", () => {
  it("separates liveness from readiness", () => {
    // A draining engine is live and not ready. One boolean forces those into
    // an answer that is wrong half the time, and the wrong half is picked
    // under load.
    const draining = engineReadinessSchema.parse({
      live: true,
      ready: false,
      reason: "draining before a migration",
    });
    expect(draining.live).toBe(true);
    expect(draining.ready).toBe(false);
  });

  it("refuses an unexplained negative", () => {
    // Half the value of splitting the two is losing the ambiguity, and an
    // unexplained "not ready" puts it straight back.
    expect(engineReadinessSchema.safeParse({ live: true, ready: false }).success).toBe(false);
    expect(engineReadinessSchema.safeParse({ live: true, ready: true }).success).toBe(true);
  });

  it("accepts a heartbeat with the new fields and one without", () => {
    // Absent means NOT REPORTED, not healthy. Every reporter written before
    // these fields existed keeps working, and says nothing rather than
    // claiming something.
    const bare = engineHeartbeatSchema.parse({
      engineId: "workorderiq",
      version: "0.19.0",
      observedAt: "2026-08-29T12:00:00.000Z",
    });
    expect(bare.dependencies).toBeUndefined();
    expect(bare.trustPosture).toBeUndefined();

    const full = engineHeartbeatSchema.parse({
      engineId: "workorderiq",
      version: "0.19.0",
      observedAt: "2026-08-29T12:00:00.000Z",
      readiness: { live: true, ready: true },
      dependencies: [
        { dependencyId: "postgres", state: "reachable", latencyMs: 3, checkedAt: "2026-08-29T12:00:00.000Z" },
        { dependencyId: "model-gateway", state: "unknown", checkedAt: "2026-08-29T12:00:00.000Z" },
      ],
      saturation: { cpu: 0.4, dbPool: 0.9 },
      errorBudget: { windowSeconds: 2_592_000, consumed: 0.62, target: 0.99 },
      trustPosture: "watched",
    });
    expect(full.dependencies?.[1]?.state).toBe("unknown");
    expect(full.trustPosture).toBe("watched");
  });

  it("keeps `unknown` as a dependency state distinct from reachable", () => {
    // The doctrine this repository keeps having to restate. A dependency
    // nobody could check is not one that answered.
    const full = engineHeartbeatSchema.parse({
      engineId: "e",
      version: "1",
      observedAt: "2026-08-29T12:00:00.000Z",
      dependencies: [{ dependencyId: "d", state: "unknown", checkedAt: "2026-08-29T12:00:00.000Z" }],
    });
    expect(full.dependencies?.[0]?.state).not.toBe("reachable");
  });

  it("expresses an error budget as consumed, not as pass or fail", () => {
    // The useful operational question is how much of the period's allowance is
    // gone — the number that says whether to ship on Friday.
    const budget = errorBudgetSchema.parse({ windowSeconds: 86_400, consumed: 0.8, target: 0.99 });
    expect(budget.consumed).toBe(0.8);
  });

  it("holds that a telemetry outage does not stop the shop", () => {
    // An observability pipeline that can halt production has made watching
    // more important than working, and it proves that during the first outage
    // — when the thing that breaks is the thing meant to tell you what broke.
    expect(telemetryFailureStopsWork()).toBe(false);
  });
});
