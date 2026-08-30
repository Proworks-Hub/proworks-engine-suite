/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { CandidatePath } from "../../nexus/topologyGraph.js";
import {
  admits,
  assessPath,
  defaultPathKey,
  markProbeInFlight,
  newCircuit,
  recordOutcome,
  selectPath,
  type Circuit,
  type CircuitPolicy,
  type HealthPolicy,
  type PathHealth,
  type PathObservation,
} from "../pathHealth.js";
import {
  admit,
  budgetPressure,
  deadLetter,
  decideRetry,
  laneMayBeShed,
  type AdmissionPolicy,
  type RetryPolicy,
} from "../flowControl.js";
import {
  MODE_DEFINITIONS,
  degradationMayRelaxRules,
  detectPartition,
  localWorkContinues,
  modeForUnreachableZone,
} from "../degradedMode.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pulse's whole job: keep permitted flow healthy, refuse early rather than
// collapse late, and never become more permissive because something broke.
// ─────────────────────────────────────────────────────────────────────────────

const circuitPolicy: CircuitPolicy = {
  failureThreshold: 3,
  successThreshold: 2,
  openDurationMs: 30_000,
};

const T0 = "2026-08-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const failNTimes = (n: number): Circuit => {
  let c = newCircuit("p1");
  for (let i = 0; i < n; i += 1) c = recordOutcome(c, circuitPolicy, "FAILURE", T0);
  return c;
};

describe("a circuit breaker is a promise not to keep asking", () => {
  it("admits freely while closed", () => {
    expect(admits(newCircuit("p1"), circuitPolicy, T0).admitted).toBe(true);
  });

  it("does NOT open on a single failure", () => {
    // A breaker that trips on one timeout trips constantly under ordinary
    // jitter, and then somebody raises the threshold until it never trips.
    const c = failNTimes(1);
    expect(c.state).toBe("CLOSED");
    expect(c.lastTransitionReason).toContain("gets disabled");
  });

  it("opens once the consecutive threshold is reached", () => {
    const c = failNTimes(3);
    expect(c.state).toBe("OPEN");
    expect(c.lastTransitionReason).toContain("rediscovering the same fault");
  });

  it("resets the failure count on any success", () => {
    // Consecutive means consecutive. Two failures and a success is a system
    // that is working, not one two-thirds of the way to broken. Without the
    // reset, the very next failure would be the third and would open a circuit
    // on a path that had just succeeded.
    let c = failNTimes(2);
    c = recordOutcome(c, circuitPolicy, "SUCCESS", T0);
    expect(c.consecutiveFailures).toBe(0);
    const afterOneMoreFailure = recordOutcome(c, circuitPolicy, "FAILURE", T0);
    expect(afterOneMoreFailure.state).toBe("CLOSED");
    expect(afterOneMoreFailure.consecutiveFailures).toBe(1);
  });

  it("refuses traffic while open, and says why failing fast is the point", () => {
    const open = failNTimes(3);
    const decision = admits(open, circuitPolicy, at(10));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("would add load to something already unwell");
  });

  it("lets exactly one probe through once the window has passed", () => {
    const open = failNTimes(3);
    const decision = admits(open, circuitPolicy, at(30));
    expect(decision.admitted).toBe(true);
    expect(decision.asProbe).toBe(true);
  });

  it("treats the open window boundary as inclusive", () => {
    const open = failNTimes(3);
    expect(admits(open, circuitPolicy, at(29)).admitted).toBe(false);
    expect(admits(open, circuitPolicy, at(30)).admitted).toBe(true);
  });

  it("REFUSES a second probe while one is outstanding", () => {
    // Otherwise the recovering dependency is tested with exactly the burst the
    // breaker exists to prevent.
    let c = failNTimes(3);
    c = recordOutcome(c, circuitPolicy, "SUCCESS", at(30));
    expect(c.state).toBe("HALF_OPEN");
    const withProbe = markProbeInFlight(c);
    const decision = admits(withProbe, circuitPolicy, at(31));
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("the burst the breaker exists to prevent");
  });

  it("does not close on one success — one success is not recovery", () => {
    let c = failNTimes(3);
    c = recordOutcome(c, circuitPolicy, "SUCCESS", at(30));
    expect(c.state).toBe("HALF_OPEN");
    expect(c.lastTransitionReason).toContain("one success is not recovery");
  });

  it("closes once the success threshold is met", () => {
    let c = failNTimes(3);
    c = recordOutcome(c, circuitPolicy, "SUCCESS", at(30));
    c = recordOutcome(c, circuitPolicy, "SUCCESS", at(31));
    expect(c.state).toBe("CLOSED");
    expect(c.openedAt).toBeNull();
  });

  it("REOPENS on a failed probe without waiting for the threshold again", () => {
    // The breaker already had its evidence. The probe was the test.
    let c = failNTimes(3);
    c = recordOutcome(c, circuitPolicy, "SUCCESS", at(30));
    expect(c.state).toBe("HALF_OPEN");
    c = recordOutcome(c, circuitPolicy, "FAILURE", at(31));
    expect(c.state).toBe("OPEN");
    expect(c.lastTransitionReason).toContain("the probe WAS the test");
    expect(c.openedAt).toBe(at(31));
  });

  it("takes `now` as an argument so a rejection can be explained later", () => {
    const open = failNTimes(3);
    expect(admits(open, circuitPolicy, at(10))).toEqual(admits(open, circuitPolicy, at(10)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const healthPolicy: HealthPolicy = {
  latencyMsP95Budget: 250,
  saturationDegraded: 0.7,
  retryRateDegraded: 0.1,
  heartbeatTimeoutMs: 15_000,
};

const observation = (over: Partial<PathObservation> = {}): PathObservation => ({
  pathKey: "p1",
  latencyMsP95: 40,
  queueSaturation: 0.1,
  retryRate: 0,
  duplicateRate: 0,
  deadLettered: 0,
  lastHeartbeatAt: T0,
  ...over,
});

describe("silence is not health", () => {
  it("reports UNKNOWN when there is no observation at all", () => {
    // The failure this prevents: a dead consumer keeps receiving traffic
    // because nothing said it was unwell.
    const a = assessPath(null, healthPolicy, T0);
    expect(a.health).toBe("UNKNOWN");
    expect(a.assessedOnNoEvidence).toBe(true);
    expect(a.reasons.join()).toContain("treating silence as health");
  });

  it("reports UNKNOWN when a path has never sent a heartbeat", () => {
    const a = assessPath(observation({ lastHeartbeatAt: null }), healthPolicy, T0);
    expect(a.health).toBe("UNKNOWN");
    expect(a.reasons.join()).toContain("may be healthy and it has not said so");
  });

  it("reports UNREACHABLE past the heartbeat timeout, not merely slow", () => {
    const a = assessPath(observation(), healthPolicy, at(15));
    expect(a.health).toBe("UNREACHABLE");
  });

  it("treats the heartbeat timeout as inclusive", () => {
    expect(assessPath(observation(), healthPolicy, at(14)).health).not.toBe("UNREACHABLE");
    expect(assessPath(observation(), healthPolicy, at(15)).health).toBe("UNREACHABLE");
  });

  it("reports HEALTHY within every budget", () => {
    expect(assessPath(observation(), healthPolicy, at(1)).health).toBe("HEALTHY");
  });

  it("reports EVERY reason for degradation, not the first", () => {
    const a = assessPath(
      observation({ latencyMsP95: 900, queueSaturation: 0.95, retryRate: 0.4, deadLettered: 3 }),
      healthPolicy,
      at(1),
    );
    expect(a.health).toBe("DEGRADED");
    expect(a.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("says dead letters are neither lost nor delivered", () => {
    const a = assessPath(observation({ deadLettered: 2 }), healthPolicy, at(1));
    expect(a.reasons.join()).toContain("not lost, and they are not delivered either");
  });

  it("treats the saturation and latency budgets as exclusive at the boundary", () => {
    expect(assessPath(observation({ latencyMsP95: 250 }), healthPolicy, at(1)).health).toBe("HEALTHY");
    expect(assessPath(observation({ latencyMsP95: 251 }), healthPolicy, at(1)).health).toBe("DEGRADED");
    expect(assessPath(observation({ queueSaturation: 0.7 }), healthPolicy, at(1)).health).toBe("HEALTHY");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

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

const remotePath = () =>
  path({
    toNodeId: "plan-remote",
    hops: [
      { ...path().hops[0]!, adjacencyId: "a2", toNodeId: "plan-remote" },
      { ...path().hops[0]!, adjacencyId: "a3", fromNodeId: "plan-remote", toNodeId: "far" },
    ],
    zonePath: ["local", "gw"],
    crossesInstance: true,
    staysLocal: false,
  });

describe("Pulse chooses among permitted paths and cannot invent one", () => {
  it("returns a path that was handed in", () => {
    const local = path();
    const r = selectPath([local], new Map([[defaultPathKey(local), "HEALTHY" as PathHealth]]), new Map(), defaultPathKey);
    expect(r.chosen).toBe(local);
  });

  it("says an empty candidate set is a topology answer, not a health one", () => {
    const r = selectPath([], new Map(), new Map(), defaultPathKey);
    expect(r.chosen).toBeNull();
    expect(r.note).toContain("Pulse cannot create a route that Nexus did not permit");
  });

  it("prefers a local path over one that crosses an instance", () => {
    const local = path();
    const remote = remotePath();
    const health = new Map<string, PathHealth>([
      [defaultPathKey(local), "HEALTHY"],
      [defaultPathKey(remote), "HEALTHY"],
    ]);
    expect(selectPath([remote, local], health, new Map(), defaultPathKey).chosen).toBe(local);
  });

  it("prefers a degraded path over an unreachable one", () => {
    const a = path();
    const b = path({ toNodeId: "plan-b", hops: [{ ...path().hops[0]!, adjacencyId: "a9" }] });
    const health = new Map<string, PathHealth>([
      [defaultPathKey(a), "UNREACHABLE"],
      [defaultPathKey(b), "DEGRADED"],
    ]);
    expect(selectPath([a, b], health, new Map(), defaultPathKey).chosen).toBe(b);
  });

  it("ranks a path nothing has been heard from BELOW a degraded one", () => {
    // A path that has reported problems at least proves something is
    // listening. One that has never reported proves nothing.
    const known = path();
    const silent = path({ toNodeId: "plan-b", hops: [{ ...path().hops[0]!, adjacencyId: "a9" }] });
    const health = new Map<string, PathHealth>([
      [defaultPathKey(known), "DEGRADED"],
      [defaultPathKey(silent), "UNKNOWN"],
    ]);
    expect(selectPath([silent, known], health, new Map(), defaultPathKey).chosen).toBe(known);
  });

  it("REFUSES to use a path whose circuit is open, even as the only option", () => {
    // Returning it anyway would make the breaker decorative.
    const only = path();
    const r = selectPath(
      [only],
      new Map([[defaultPathKey(only), "HEALTHY" as PathHealth]]),
      new Map([[defaultPathKey(only), "OPEN" as const]]),
      defaultPathKey,
    );
    expect(r.chosen).toBeNull();
    expect(r.note).toContain("would make them decorative");
  });

  it("prefers a closed circuit over a half-open one", () => {
    const a = path();
    const b = path({ toNodeId: "plan-b", hops: [{ ...path().hops[0]!, adjacencyId: "a9" }] });
    const health = new Map<string, PathHealth>([
      [defaultPathKey(a), "HEALTHY"],
      [defaultPathKey(b), "HEALTHY"],
    ]);
    const circuits = new Map([[defaultPathKey(a), "HALF_OPEN" as const]]);
    expect(selectPath([a, b], health, circuits, defaultPathKey).chosen).toBe(b);
  });

  // Each of the next three isolates ONE preference. The earlier tests varied
  // several at once — locality AND hop count AND instance crossing — so a
  // mutation removing any single factor left the others deciding, and the test
  // still passed. `byName` makes the tie-break predictable, so removing a
  // preference flips the answer rather than merely narrowing it.
  const byName = (p: CandidatePath) => p.toNodeId;
  const healthy = (...names: string[]) =>
    new Map<string, PathHealth>(names.map((n) => [n, "HEALTHY" as PathHealth]));

  it("prefers LOCALITY when nothing else differs", () => {
    // Same health, same hop count, neither crosses an instance. Only staysLocal
    // separates them, and the non-local one is named to win the tie-break — so
    // if locality stopped counting, it would be chosen.
    const local = path({ toNodeId: "z-local", staysLocal: true });
    const nonLocal = path({ toNodeId: "a-regional", staysLocal: false, zonePath: ["local", "region"] });
    const r = selectPath([nonLocal, local], healthy("z-local", "a-regional"), new Map(), byName);
    expect(r.chosen).toBe(local);
  });

  it("PENALISES crossing an instance when nothing else differs", () => {
    // Neither is local, both healthy, both one hop. Only the crossing differs,
    // and the crossing one wins the tie-break if the penalty is removed.
    const staying = path({ toNodeId: "z-staying", staysLocal: false, zonePath: ["local", "region"] });
    const crossing = path({
      toNodeId: "a-crossing",
      staysLocal: false,
      crossesInstance: true,
      zonePath: ["local", "gw"],
    });
    const r = selectPath([crossing, staying], healthy("z-staying", "a-crossing"), new Map(), byName);
    expect(r.chosen).toBe(staying);
  });

  it("ranks an UNREACHABLE path below one nothing has been heard from", () => {
    // The unreachable path is otherwise the better bet — local, one hop. The
    // silent one is remote and two hops. Unreachable still loses, because a
    // path known to be down is worse than a path that has said nothing.
    const down = path({ toNodeId: "a-down", staysLocal: true });
    const silent = path({
      toNodeId: "z-silent",
      staysLocal: false,
      crossesInstance: true,
      zonePath: ["local", "gw"],
      hops: [path().hops[0]!, { ...path().hops[0]!, adjacencyId: "a2" }],
    });
    const health = new Map<string, PathHealth>([
      ["a-down", "UNREACHABLE"],
      ["z-silent", "UNKNOWN"],
    ]);
    const r = selectPath([down, silent], health, new Map(), byName);
    expect(r.chosen).toBe(silent);
  });

  it("explains the choice, including what it did not choose", () => {
    const local = path();
    const remote = remotePath();
    const health = new Map<string, PathHealth>([
      [defaultPathKey(local), "HEALTHY"],
      [defaultPathKey(remote), "HEALTHY"],
    ]);
    const r = selectPath([remote, local], health, new Map(), defaultPathKey);
    expect(r.considered).toHaveLength(2);
    expect(r.note).toContain("stays inside the local zone");
  });

  it("breaks ties deterministically, so one question has one answer", () => {
    const a = path({ toNodeId: "zulu", hops: [{ ...path().hops[0]!, adjacencyId: "z" }] });
    const b = path({ toNodeId: "alpha", hops: [{ ...path().hops[0]!, adjacencyId: "a" }] });
    const health = new Map<string, PathHealth>([
      [defaultPathKey(a), "HEALTHY"],
      [defaultPathKey(b), "HEALTHY"],
    ]);
    expect(selectPath([a, b], health, new Map(), defaultPathKey).chosen).toBe(b);
    expect(selectPath([b, a], health, new Map(), defaultPathKey).chosen).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const admissionPolicy: AdmissionPolicy = { shedAboveSaturation: 0.8, slowAboveSaturation: 0.6 };

describe("refusing early beats collapsing late", () => {
  it("admits into an empty queue with no backpressure", () => {
    const d = admit({ queueKey: "q", depth: 0, capacity: 100 }, "COMMAND", admissionPolicy);
    expect(d.admitted).toBe(true);
    if (d.admitted) expect(d.backpressure).toBe("NONE");
  });

  it("signals SLOW_DOWN before it starts shedding", () => {
    // The warning exists so there is one.
    const d = admit({ queueKey: "q", depth: 65, capacity: 100 }, "COMMAND", admissionPolicy);
    expect(d.admitted).toBe(true);
    if (d.admitted) {
      expect(d.backpressure).toBe("SLOW_DOWN");
      expect(d.reason).toContain("the warning before shedding starts");
    }
  });

  it("SHEDS a sheddable lane under pressure", () => {
    const d = admit({ queueKey: "q", depth: 85, capacity: 100 }, "HEALTH", admissionPolicy);
    expect(d.admitted).toBe(false);
    if (!d.admitted) expect(d.reason).toContain("a superseded heartbeat costs nothing to lose");
  });

  it("NEVER sheds evidence or commands under the same pressure", () => {
    // The load spike and the incident are the same event. Shedding evidence
    // deletes the record of the thing causing the problem.
    for (const lane of ["EVIDENCE", "COMMAND", "WORKFLOW"] as const) {
      const d = admit({ queueKey: "q", depth: 85, capacity: 100 }, lane, admissionPolicy);
      expect(d.admitted).toBe(true);
    }
  });

  it("refuses everything when the queue is genuinely full, evidence included", () => {
    // At that point there is nowhere to put it, and accepting a message that
    // will be silently dropped later is the dishonest failure.
    const d = admit({ queueKey: "q", depth: 100, capacity: 100 }, "EVIDENCE", admissionPolicy);
    expect(d.admitted).toBe(false);
    if (!d.admitted) {
      expect(d.retryable).toBe(true);
      expect(d.reason).toContain("accepted and dropped silently later");
    }
  });

  it("refuses a queue with no configured bound", () => {
    const d = admit({ queueKey: "q", depth: 0, capacity: 0 }, "COMMAND", admissionPolicy);
    expect(d.admitted).toBe(false);
    if (!d.admitted) expect(d.reason).toContain("a memory leak with a name");
  });

  it("delegates shedding eligibility to the lane table", () => {
    // A decision made under load must not override one made deliberately.
    expect(laneMayBeShed("HEALTH")).toBe(true);
    expect(laneMayBeShed("EVIDENCE")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const retryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  retryBudgetFraction: 0.1,
};

describe("retries are load, so they are budgeted", () => {
  it("retries with a jittered delay", () => {
    const d = decideRetry(0, retryPolicy, { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 0 }, () => 0.5);
    expect(d.retry).toBe(true);
    if (d.retry) expect(d.delayMs).toBe(50);
  });

  it("backs off exponentially and caps", () => {
    const budget = { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 0 };
    const full = () => 1;
    const a = decideRetry(0, retryPolicy, budget, full);
    const b = decideRetry(3, retryPolicy, budget, full);
    if (a.retry && b.retry) expect(b.delayMs).toBeGreaterThan(a.delayMs);
    const capped = decideRetry(20, { ...retryPolicy, maxAttempts: 99 }, budget, full);
    if (capped.retry) expect(capped.delayMs).toBeLessThanOrEqual(retryPolicy.maxDelayMs);
  });

  it("jitters across the FULL window, not a narrow band", () => {
    // Jittering by a tenth of a shared delay leaves every caller inside the
    // same tenth of a second.
    const budget = { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 0 };
    const low = decideRetry(3, retryPolicy, budget, () => 0);
    const high = decideRetry(3, retryPolicy, budget, () => 0.999);
    if (low.retry && high.retry) {
      expect(low.delayMs).toBe(0);
      expect(high.delayMs).toBeGreaterThan(700);
    }
  });

  it("dead-letters once attempts are exhausted", () => {
    const d = decideRetry(4, retryPolicy, { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 0 }, () => 0.5);
    expect(d.retry).toBe(false);
    if (!d.retry) {
      expect(d.deadLetter).toBe(true);
      expect(d.reason).toContain("it is not lost");
    }
  });

  it("REFUSES to retry once the window's budget is spent", () => {
    // Per-message limits do not bound total load. Ten thousand messages each
    // retrying three times is thirty thousand extra requests.
    const d = decideRetry(0, retryPolicy, { windowKey: "w", sendsInWindow: 100, retriesInWindow: 10 }, () => 0.5);
    expect(d.retry).toBe(false);
    if (!d.retry) expect(d.reason).toContain("a brief fault becomes a sustained overload that outlives it");
  });

  it("reports budget pressure before anything is refused", () => {
    const p = budgetPressure(retryPolicy, { windowKey: "w", sendsInWindow: 100, retriesInWindow: 5 });
    expect(p.spent).toBeCloseTo(0.5, 5);
    expect(p.note).toContain("50%");
  });

  it("does not report an empty window as healthy", () => {
    const p = budgetPressure(retryPolicy, { windowKey: "w", sendsInWindow: 0, retriesInWindow: 0 });
    expect(p.note).toContain("nothing has been tried");
  });
});

describe("a dead letter distinguishes poison from bad luck", () => {
  const base = {
    fabricMessageId: "m1",
    lane: "COMMAND" as const,
    attempts: 4,
    firstFailedAt: T0,
    lastFailedAt: at(60),
    reason: "downstream refused",
  };

  it("marks a message that failed identically every time as POISON", () => {
    const d = deadLetter({ ...base, identicalFailures: true, laneReplayable: true });
    expect(d.replayable).toBe(false);
    expect(d.note).toContain("spends the same capacity to get the same failure");
  });

  it("marks a message whose failures differed as worth replaying", () => {
    const d = deadLetter({ ...base, identicalFailures: false, laneReplayable: true });
    expect(d.replayable).toBe(true);
    expect(d.note).toContain("may be a transient fault");
  });

  it("refuses to replay on a lane that is not replayable", () => {
    // Whoever was waiting for a query has already stopped waiting.
    const d = deadLetter({ ...base, lane: "QUERY", identicalFailures: false, laneReplayable: false });
    expect(d.replayable).toBe(false);
    expect(d.note).toContain("already stopped waiting");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("local first, Collective second", () => {
  it("keeps local work running when the Collective is unreachable", () => {
    const r = localWorkContinues(["COLLECTIVE"]);
    expect(r.continues).toBe(true);
    expect(r.reason).toContain('"local first, Collective second"');
  });

  it("keeps local work running when regions and gateways are all gone", () => {
    expect(localWorkContinues(["COLLECTIVE", "REGIONAL", "GATEWAY"]).continues).toBe(true);
  });

  it("says losing the local zone is an outage, not a degraded mode", () => {
    const r = localWorkContinues(["LOCAL"]);
    expect(r.continues).toBe(false);
    expect(r.reason).toContain("no degraded mode that recovers local work when local is what is gone");
  });

  it("maps each unreachable zone kind to a declared mode", () => {
    expect(modeForUnreachableZone("COLLECTIVE")).toEqual({ declared: true, definition: MODE_DEFINITIONS.LOCAL_ONLY });
    expect(modeForUnreachableZone("GATEWAY")).toEqual({ declared: true, definition: MODE_DEFINITIONS.GATEWAY_DOWN });
    expect(modeForUnreachableZone("LOCAL")).toEqual({ declared: true, definition: MODE_DEFINITIONS.LOCAL_IMPAIRED });
  });

  it("declines to invent a mode for a lost sandbox", () => {
    // A sandbox has no production effect to lose, and defining a mode would
    // imply otherwise.
    const r = modeForUnreachableZone("SANDBOX");
    expect(r.declared).toBe(false);
    if (!r.declared) expect(r.reason).toContain("no production effect to lose");
  });

  it("keeps evidence and health alive even when local is impaired", () => {
    // Losing the ability to see the failure is worse than the failure.
    const m = MODE_DEFINITIONS.LOCAL_IMPAIRED;
    expect(m.lanesAvailable).toEqual(["EVIDENCE", "HEALTH"]);
    expect(m.localWorkContinues).toBe(false);
    expect(m.operatorNote).toContain("losing the ability to see the failure is worse");
  });

  it("says a local path that breaks in LOCAL_ONLY was never local", () => {
    expect(MODE_DEFINITIONS.LOCAL_ONLY.operatorNote).toContain("was never local");
  });

  it("does not reroute around a downed gateway", () => {
    expect(MODE_DEFINITIONS.GATEWAY_DOWN.operatorNote).toContain(
      "going around the boundary that exists to be gone through",
    );
  });
});

describe("a partition is not one sick node", () => {
  const policy = { missedHeartbeatThreshold: 3 };

  it("does not declare a partition below the threshold", () => {
    const v = detectPartition(
      { zoneId: "z", zoneKind: "COLLECTIVE", missedHeartbeats: 2, othersInZoneReachable: false },
      policy,
    );
    expect(v.partitioned).toBe(false);
    if (!v.partitioned) expect(v.reason).toContain("would declare a partition on ordinary jitter");
  });

  it("does NOT declare a partition while others in the zone still answer", () => {
    // Changing the instance's mode for one bad path is an expensive, visible
    // response to a local fault.
    const v = detectPartition(
      { zoneId: "z", zoneKind: "COLLECTIVE", missedHeartbeats: 9, othersInZoneReachable: true },
      policy,
    );
    expect(v.partitioned).toBe(false);
    if (!v.partitioned) expect(v.reason).toContain("a sick node, not a partition");
  });

  it("declares a partition when nothing in the zone answers", () => {
    const v = detectPartition(
      { zoneId: "z", zoneKind: "COLLECTIVE", missedHeartbeats: 3, othersInZoneReachable: false },
      policy,
    );
    expect(v.partitioned).toBe(true);
    if (v.partitioned) expect(v.mode).toEqual({ declared: true, definition: MODE_DEFINITIONS.LOCAL_ONLY });
  });

  it("NEVER becomes more permissive while degraded", () => {
    // "We could not reach the authorizer so we proceeded" is the shape of the
    // worst outage this system could have.
    expect(degradationMayRelaxRules()).toBe(false);
  });
});
