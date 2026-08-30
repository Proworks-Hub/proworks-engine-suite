/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fabricEnvelopeSchema, type FabricEnvelope } from "../../domain/envelope.js";
import type { CandidatePath, CandidateRoutes } from "../../nexus/topologyGraph.js";
import { defaultPathKey, type CircuitState, type PathHealth } from "../../pulse/pathHealth.js";
import { effectivePriority, routeSignal, routingMayWidenCandidates } from "../routingIQ.js";
import {
  canReplayFrom,
  commitOffset,
  consumerLag,
  partitionFor,
  repartitionImpact,
  type ConsumerPosition,
  type StreamDefinition,
} from "../streamIQ.js";

const T0 = "2026-08-30T10:00:00.000Z";

const envelope = (over: Record<string, unknown> = {}): FabricEnvelope =>
  fabricEnvelopeSchema.parse({
    fabricMessageId: "sig-1",
    schemaId: "forgeiq.plan.requested",
    schemaVersion: "1.0.0",
    lane: "COMMAND",
    source: { capability: "ordering" },
    destination: { capability: "manufacturing.plan" },
    instanceId: "ksix",
    tenantId: "acme",
    correlationId: "cor-1",
    causationId: null,
    idempotencyKey: "idem-1",
    authorizationEvidenceRef: "dec-1",
    provenance: {
      originComponent: "order-ingestion",
      originInstanceId: "ksix",
      principalKind: "ENGINE",
      transformations: [],
    },
    classification: "INTERNAL",
    priority: "NORMAL",
    contentType: "application/json",
    isTest: false,
    ...over,
  });

const path = (over: Partial<CandidatePath> = {}): CandidatePath => ({
  hops: [
    {
      adjacencyId: "a1",
      fromNodeId: "ordering",
      toNodeId: "plan-a",
      lane: "COMMAND",
      capability: "manufacturing.plan",
      authorizingDecisionRef: "dec-1",
      state: "ACTIVE",
    },
  ],
  fromNodeId: "ordering",
  toNodeId: "plan-a",
  lane: "COMMAND",
  zonePath: ["local"],
  crossesInstance: false,
  staysLocal: true,
  ...over,
});

const remote = () =>
  path({
    toNodeId: "plan-remote",
    hops: [{ ...path().hops[0]!, adjacencyId: "a2", toNodeId: "plan-remote" }],
    zonePath: ["local", "gw"],
    crossesInstance: true,
    staysLocal: false,
  });

const candidates = (over: Partial<CandidateRoutes> = {}): CandidateRoutes => ({
  capability: "manufacturing.plan",
  lane: "COMMAND",
  permitted: [path()],
  rejected: [],
  note: "one permitted route",
  ...over,
});

const route = (over: Partial<Parameters<typeof routeSignal>[0]> = {}) =>
  routeSignal({
    envelope: envelope(),
    candidates: candidates(),
    health: new Map<string, PathHealth>([[defaultPathKey(path()), "HEALTHY"]]),
    circuits: new Map<string, CircuitState>(),
    pathKey: defaultPathKey,
    now: T0,
    expired: false,
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────────
// The order of the checks is the design: authority before health, because
// checking health first lets an unhealthy path make a permission question moot.
// ─────────────────────────────────────────────────────────────────────────────

describe("routing records why, not just where", () => {
  it("chooses a permitted, healthy route", () => {
    const d = route();
    expect(d.chosen?.toNodeId).toBe("plan-a");
    expect(d.refusedAt).toBeNull();
  });

  it("records the checks in order, with health LAST", () => {
    const d = route();
    expect(d.checks.map((c) => c.stage)).toEqual(["expiry", "permitted-routes", "classification", "health"]);
    expect(d.explanation).toContain("must not be made moot by an unhealthy path");
  });

  it("refuses an expired signal before doing any other work", () => {
    const d = route({ expired: true });
    expect(d.refusedAt).toBe("EXPIRED");
    expect(d.checks.map((c) => c.stage)).toEqual(["expiry"]);
    expect(d.explanation).toContain("has stopped waiting");
  });

  it("distinguishes NO PERMITTED ROUTE from NO HEALTHY ROUTE", () => {
    // The two send an operator to completely different places.
    const noRoute = route({ candidates: candidates({ permitted: [], rejected: [{ toNodeId: "x", reason: "no adjacency" }] }) });
    expect(noRoute.refusedAt).toBe("NO_PERMITTED_ROUTE");
    expect(noRoute.explanation).toContain("no amount of waiting will change it");

    const unhealthy = route({ circuits: new Map([[defaultPathKey(path()), "OPEN" as CircuitState]]) });
    expect(unhealthy.refusedAt).toBe("NO_HEALTHY_ROUTE");
    expect(unhealthy.explanation).toContain("an incident rather than a permission question");
  });

  it("carries the topology's rejection reasons through to the decision", () => {
    const d = route({
      candidates: candidates({ rejected: [{ toNodeId: "plan-b", reason: "Default-deny: no adjacency." }] }),
    });
    expect(d.rejected).toEqual([{ toNodeId: "plan-b", why: "Default-deny: no adjacency." }]);
  });

  it("records the alternatives it did not choose", () => {
    const d = route({
      candidates: candidates({ permitted: [path(), remote()] }),
      health: new Map<string, PathHealth>([
        [defaultPathKey(path()), "HEALTHY"],
        [defaultPathKey(remote()), "HEALTHY"],
      ]),
    });
    expect(d.chosen?.toNodeId).toBe("plan-a");
    expect(d.alternatives.map((a) => a.toNodeId)).toEqual(["plan-remote"]);
  });

  it("REFUSES to export tenant-private data, however healthy the remote path", () => {
    // A rule, not a preference. Filtering rather than penalising is the
    // difference.
    const d = route({
      envelope: envelope({ classification: "TENANT_PRIVATE" }),
      candidates: candidates({ permitted: [remote()] }),
      health: new Map<string, PathHealth>([[defaultPathKey(remote()), "HEALTHY"]]),
    });
    expect(d.refusedAt).toBe("CLASSIFICATION_FORBIDS_EXPORT");
    expect(d.explanation).toContain("no route health, latency benefit or urgency changes it");
  });

  it("keeps a local route when a private signal also has a remote option", () => {
    const d = route({
      envelope: envelope({ classification: "PERSONAL" }),
      candidates: candidates({ permitted: [remote(), path()] }),
      health: new Map<string, PathHealth>([
        [defaultPathKey(path()), "DEGRADED"],
        [defaultPathKey(remote()), "HEALTHY"],
      ]),
    });
    // The remote path is healthier and is removed by classification anyway.
    expect(d.chosen?.toNodeId).toBe("plan-a");
    expect(d.checks.find((c) => c.stage === "classification")!.conclusion).toContain("a rule, not a preference");
  });

  it("NEVER widens the candidate set", () => {
    // The pressure to relax this arrives disguised as a latency improvement.
    expect(routingMayWidenCandidates()).toBe(false);
    const d = route({ candidates: candidates({ permitted: [path()] }) });
    expect(d.chosen).toBe(d.chosen === null ? null : d.chosen);
    expect([d.chosen?.toNodeId]).toEqual(["plan-a"]);
  });

  it("carries the correlation id into the decision record", () => {
    // §19's questions are asked after the fact, so the answer is recorded now.
    expect(route().correlationId).toBe("cor-1");
    expect(route().decidedAt).toBe(T0);
  });
});

describe("priority is a fabric class, not a business one", () => {
  it("passes a priority within the ceiling", () => {
    const r = effectivePriority("NORMAL", "HIGH");
    expect(r.priority).toBe("NORMAL");
    expect(r.clamped).toBe(false);
  });

  it("CLAMPS a caller that asks for more than policy permits", () => {
    // A caller that could raise its own priority by asking would raise it
    // always, and EMERGENCY would mean nothing within a week.
    const r = effectivePriority("EMERGENCY", "NORMAL");
    expect(r.priority).toBe("NORMAL");
    expect(r.clamped).toBe(true);
    expect(r.note).toContain("would mean nothing within a week");
  });

  it("permits the ceiling itself", () => {
    expect(effectivePriority("HIGH", "HIGH").clamped).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const stream = (over: Partial<StreamDefinition> = {}): StreamDefinition => ({
  streamId: "machine.telemetry",
  partitionCount: 8,
  partitionKeyField: "machineId",
  retentionMs: 604_800_000,
  compacted: false,
  ...over,
});

describe("a partition is an ordering boundary", () => {
  it("places the same key in the same partition every time", () => {
    // The property the ordering guarantee is built on.
    expect(partitionFor("machine-7", 8)).toBe(partitionFor("machine-7", 8));
  });

  it("spreads different keys across partitions", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => partitionFor(`m-${i}`, 8)));
    expect(seen.size).toBeGreaterThan(4);
  });

  it("stays within the partition count", () => {
    for (let i = 0; i < 100; i += 1) {
      const p = partitionFor(`k-${i}`, 8);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(8);
    }
  });

  it("refuses a stream with no partitions", () => {
    expect(() => partitionFor("k", 0)).toThrow(/nowhere to put anything/);
  });
});

describe("repartitioning breaks ordering, permanently", () => {
  const keys = Array.from({ length: 200 }, (_, i) => `machine-${i}`);

  it("reports which keys move and what that costs", () => {
    // "Some keys will move" is ignorable. "63% of your keys move and their
    // history splits across two partitions" is not.
    const impact = repartitionImpact(keys, 8, 16);
    expect(impact.orderingBroken).toBe(true);
    expect(impact.movedFraction).toBeGreaterThan(0);
    expect(impact.note).toContain("permanent");
    expect(impact.note).toContain("repartitioning back does not reunite the history");
  });

  it("names the individual keys, not just a count", () => {
    const impact = repartitionImpact(keys, 8, 16);
    expect(impact.keysThatMove[0]!.from).not.toBe(impact.keysThatMove[0]!.to);
  });

  it("reports nothing moving as suspicious rather than reassuring", () => {
    const impact = repartitionImpact(keys, 8, 8);
    expect(impact.orderingBroken).toBe(false);
    expect(impact.note).toContain("worth checking the sample");
  });

  it("lists moved keys in a stable order", () => {
    expect(repartitionImpact(keys, 8, 16)).toEqual(repartitionImpact([...keys].reverse(), 8, 16));
  });
});

describe("retention is not a replay window", () => {
  const offsetAt = (at: string) => (at >= "2026-08-25T00:00:00.000Z" ? 5000 : null);

  it("replays from a point inside the window", () => {
    const v = canReplayFrom(stream(), "2026-08-24T00:00:00.000Z", "2026-08-26T00:00:00.000Z", offsetAt);
    expect(v.canReplay).toBe(true);
    if (v.canReplay) expect(v.note).toContain("order within each partition and no order between them");
  });

  it("REFUSES a replay from before the retention window", () => {
    // "Replay from the start of the incident" fails when the incident began
    // before retention did.
    const v = canReplayFrom(stream(), "2026-08-24T00:00:00.000Z", "2026-08-01T00:00:00.000Z", offsetAt);
    expect(v.canReplay).toBe(false);
    if (!v.canReplay) {
      expect(v.reason).toContain("a different and shorter thing");
      expect(v.remedy).toContain("before the next incident rather than during one");
    }
  });

  it("REFUSES to replay a compacted stream", () => {
    // The history is exactly what compaction removed.
    const v = canReplayFrom(stream({ compacted: true }), "2026-08-24T00:00:00.000Z", "2026-08-26T00:00:00.000Z", offsetAt);
    expect(v.canReplay).toBe(false);
    if (!v.canReplay) expect(v.reason).toContain("exactly what compaction removed");
  });

  it("refuses a timestamp inside the window with no entry at it", () => {
    const v = canReplayFrom(stream(), "2026-08-24T00:00:00.000Z", "2026-08-24T12:00:00.000Z", () => null);
    expect(v.canReplay).toBe(false);
    if (!v.canReplay) expect(v.reason).toContain("no entry sits at it");
  });
});

describe("a consumer position moves forward unless somebody means it", () => {
  const position = (over: Partial<ConsumerPosition> = {}): ConsumerPosition => ({
    consumerId: "c1",
    streamId: "machine.telemetry",
    partition: 0,
    offset: 100,
    committedAt: T0,
    ...over,
  });

  it("accepts a first position", () => {
    const v = commitOffset(null, { offset: 10, at: T0 }, "c1", "s", 0);
    expect(v.committed).toBe(true);
  });

  it("advances forward", () => {
    const v = commitOffset(position(), { offset: 150, at: T0 }, "c1", "machine.telemetry", 0);
    expect(v.committed).toBe(true);
    if (v.committed) expect(v.position.offset).toBe(150);
  });

  it("REFUSES a backwards commit by default", () => {
    // Almost always two workers on one partition, or a restart with stale
    // state. Honouring it silently reprocesses everything in between.
    const v = commitOffset(position(), { offset: 50, at: T0 }, "c1", "machine.telemetry", 0);
    expect(v.committed).toBe(false);
    if (!v.committed) expect(v.reason).toContain("two workers on one partition");
  });

  it("permits a deliberate rewind and says what it costs", () => {
    const v = commitOffset(position(), { offset: 50, at: T0 }, "c1", "machine.telemetry", 0, { allowRewind: true });
    expect(v.committed).toBe(true);
    if (v.committed) expect(v.note).toContain("must be idempotent for that to be safe");
  });

  it("treats an unchanged offset as a harmless heartbeat", () => {
    const v = commitOffset(position(), { offset: 100, at: T0 }, "c1", "machine.telemetry", 0);
    expect(v.committed).toBe(true);
    if (v.committed) expect(v.note).toContain("harmless and common");
  });
});

describe("lag is reported per partition, because a total hides a stuck one", () => {
  it("reports zero lag as caught up", () => {
    const lag = consumerLag(
      [{ consumerId: "c1", streamId: "s", partition: 0, offset: 100, committedAt: T0 }],
      new Map([[0, 100]]),
    );
    expect(lag[0]!.lag).toBe(0);
  });

  it("exposes one stuck partition behind nine healthy ones", () => {
    // The case a total average hides.
    const positions = Array.from({ length: 10 }, (_, i) => ({
      consumerId: "c1",
      streamId: "s",
      partition: i,
      offset: i === 3 ? 0 : 1000,
      committedAt: T0,
    }));
    const heads = new Map(Array.from({ length: 10 }, (_, i) => [i, 1000]));
    const lag = consumerLag(positions, heads);
    expect(lag.find((l) => l.partition === 3)!.lag).toBe(1000);
    expect(lag.filter((l) => l.lag === 0)).toHaveLength(9);
    expect(lag.find((l) => l.partition === 3)!.note).toContain("hides one stuck partition behind nine healthy ones");
  });

  it("never reports negative lag", () => {
    const lag = consumerLag(
      [{ consumerId: "c1", streamId: "s", partition: 0, offset: 200, committedAt: T0 }],
      new Map([[0, 100]]),
    );
    expect(lag[0]!.lag).toBe(0);
  });

  it("reports partitions in order", () => {
    const positions = [2, 0, 1].map((p) => ({
      consumerId: "c1",
      streamId: "s",
      partition: p,
      offset: 0,
      committedAt: T0,
    }));
    const heads = new Map([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(consumerLag(positions, heads).map((l) => l.partition)).toEqual([0, 1, 2]);
  });

  it("reports an unknown head as UNKNOWN lag, not as caught up", () => {
    // Found by a surviving mutation. Both `?? position.offset` and `?? 0`
    // produced a lag of zero, which is indistinguishable from healthy — the
    // same silence-reads-as-health failure Pulse refuses elsewhere. A
    // partition nobody is measuring is exactly the one that goes green while
    // it falls behind.
    const lag = consumerLag(
      [{ consumerId: "c1", streamId: "s", partition: 4, offset: 900, committedAt: T0 }],
      new Map(),
    );
    expect(lag[0]!.lag).toBeNull();
    expect(lag[0]!.note).toContain("Not the same as caught up");
  });
});
