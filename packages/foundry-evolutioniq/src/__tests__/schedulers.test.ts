// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { repairBotLease, type AgentLease } from "@proworks-hub/repair-learning";

import {
  createAgentRuntime,
  createManualTicker,
  createMissionControl,
  createMissionScheduler,
  createSupervisorScheduler,
  missionsConflict,
  type AgentRuntime,
  type MissionControl,
  type MissionPriority,
  type WorkspaceContainment,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The supervisor scheduler and the cross-mission scheduler.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = new Date("2026-08-29T10:00:00.000Z").getTime();

const clock = () => {
  let ms = T0;
  return {
    now: () => new Date(ms),
    advance: (d: number) => {
      ms += d;
    },
  };
};

const objective = {
  statement: "Make the consumer idempotent.",
  derivedFrom: "dx_1",
  successCriteria: ["one work order per delivery"],
};

const scopeFor = (components: string[], over: Record<string, unknown> = {}) => ({
  components,
  repository: "proworks-engine-suite",
  environment: "SIMULATION" as const,
  maxFiles: 5,
  maxComponents: components.length,
  maxDurationMs: 3_600_000,
  ...over,
});

const lease = (agentId = "bot_1"): AgentLease =>
  repairBotLease({
    agentId,
    mission: "m",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    governanceReference: "gd-1",
    sentinelSession: "sen-1",
  });

const containment: WorkspaceContainment = {
  async freeze() {},
  workspacesOf: () => [],
};

/** A mission authorized and ready to queue. */
const authorized = (
  missions: MissionControl,
  missionId: string,
  components: string[],
  over: Record<string, unknown> = {},
) => {
  missions.propose({ missionId, objective, scope: scopeFor(components, over) });
  missions.authorize(missionId, "gd-1", "governance");
  return missions.get(missionId)!;
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the supervisor scheduler drives supervise()", () => {
  const setup = (over: Partial<Parameters<typeof createSupervisorScheduler>[0]> = {}) => {
    const c = clock();
    const missions = createMissionControl({ now: c.now });
    const runtime = createAgentRuntime({ missions, containment, now: c.now });
    const ticker = createManualTicker();
    const scheduler = createSupervisorScheduler({
      runtime,
      ticker,
      intervalMs: 1000,
      now: c.now,
      ...over,
    });
    return { c, missions, runtime, ticker, scheduler };
  };

  it("imports no timer of its own", () => {
    // §41 portability. A scheduler built on setInterval runs in Node and
    // nowhere else, and the Hive is not promised to one runtime.
    const { ticker, scheduler } = setup();
    scheduler.start();
    expect(ticker.scheduledIntervalMs).toBe(1000);
  });

  it("sweeps when the ticker fires", async () => {
    const { c, missions, runtime, ticker, scheduler } = setup();
    authorized(missions, "mis_1", ["hive.specialized.workorderiq"]);
    missions.provision("mis_1", "bot_1", "foundry");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 86_400_000, maxValidationRuns: 2 },
    });

    scheduler.start();
    c.advance(5 * 60 * 60 * 1000);
    ticker.fire();
    // The ticker callback is synchronous by contract; the sweep it starts is
    // not. Await a turn so it lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.status().sweeps).toBeGreaterThan(0);
    expect(runtime.get("bot_1")!.state).toBe("TERMINATED");
  });

  it("can be driven directly by a cron or a test", async () => {
    // `start()` is a convenience over `tick()`, not the only way in.
    const { scheduler } = setup();
    const record = await scheduler.tick();
    expect(record.sweepNumber).toBe(1);
    expect(record.error).toBeNull();
  });

  it("skips an overlapping sweep rather than running two", async () => {
    // Two concurrent sweeps can both decide to terminate the same agent, and
    // the second operates on state the first is halfway through changing.
    let release: (() => void) | null = null;
    const slowRuntime = {
      running: () => [],
      supervise: () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    } as unknown as AgentRuntime;

    const scheduler = createSupervisorScheduler({
      runtime: slowRuntime,
      ticker: createManualTicker(),
      intervalMs: 10,
    });

    const first = scheduler.tick();
    const second = await scheduler.tick();

    expect(second.error).toContain("previous sweep is still running");
    expect(scheduler.status().overlapsSkipped).toBe(1);

    release!();
    await first;
  });

  it("survives a sweep that throws, and counts it", async () => {
    // Containment that breaks the first time something unexpected happens
    // breaks precisely when it is needed.
    const errors: string[] = [];
    const scheduler = createSupervisorScheduler({
      runtime: {
        running: () => [],
        supervise: async () => {
          throw new Error("store unreachable");
        },
      } as unknown as AgentRuntime,
      ticker: createManualTicker(),
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });

    const record = await scheduler.tick();
    expect(record.error).toContain("store unreachable");
    expect(errors).toHaveLength(1);

    // And it keeps going.
    await scheduler.tick();
    expect(scheduler.status().sweeps).toBe(2);
  });

  it("reports unavailable after repeated failures rather than staying quiet", async () => {
    // A scheduler that stopped sweeping and says nothing leaves every agent
    // unsupervised while the system reports itself healthy.
    const scheduler = createSupervisorScheduler({
      runtime: {
        running: () => [],
        supervise: async () => {
          throw new Error("down");
        },
      } as unknown as AgentRuntime,
      ticker: createManualTicker(),
      intervalMs: 1000,
      unhealthyAfterConsecutiveErrors: 3,
    });
    scheduler.start();

    await scheduler.tick();
    expect(scheduler.status().health).toBe("degraded");
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.status().health).toBe("unavailable");
    expect(scheduler.status().detail).toContain("effectively unsupervised despite the scheduler running");
  });

  it("recovers to healthy after a good sweep", async () => {
    let fail = true;
    const scheduler = createSupervisorScheduler({
      runtime: {
        running: () => [],
        supervise: async () => {
          if (fail) throw new Error("transient");
          return [];
        },
      } as unknown as AgentRuntime,
      ticker: createManualTicker(),
      intervalMs: 1000,
    });
    scheduler.start();

    await scheduler.tick();
    expect(scheduler.status().health).toBe("degraded");
    fail = false;
    await scheduler.tick();
    expect(scheduler.status().health).toBe("healthy");
  });

  it("says nothing is watched when it is stopped", () => {
    const { scheduler } = setup();
    expect(scheduler.status().health).toBe("stopped");
    expect(scheduler.status().detail).toContain("only call-time lease checks apply");
  });

  it("is degraded until a sweep has actually completed", () => {
    // Health derives from behaviour, not from `start()` having been called.
    const { scheduler } = setup();
    scheduler.start();
    expect(scheduler.status().health).toBe("degraded");
    expect(scheduler.status().detail).toContain("Nothing is confirmed to be watching");
  });

  it("reports degraded when a sweep is slower than its interval", async () => {
    const c = clock();
    const scheduler = createSupervisorScheduler({
      runtime: {
        running: () => [],
        supervise: async () => {
          c.advance(5000);
          return [];
        },
      } as unknown as AgentRuntime,
      ticker: createManualTicker(),
      intervalMs: 1000,
      now: c.now,
    });
    scheduler.start();
    await scheduler.tick();

    const status = scheduler.status();
    expect(status.health).toBe("degraded");
    expect(status.detail).toContain("effective supervision interval is longer than configured");
  });

  it("stops cleanly and can restart", () => {
    const { ticker, scheduler } = setup();
    scheduler.start();
    scheduler.stop();
    expect(ticker.scheduledIntervalMs).toBeNull();
    expect(scheduler.status().running).toBe(false);
    scheduler.start();
    expect(scheduler.status().running).toBe(true);
  });

  it("keeps a bounded history", async () => {
    const scheduler = createSupervisorScheduler({
      runtime: { running: () => [], supervise: async () => [] } as unknown as AgentRuntime,
      ticker: createManualTicker(),
      intervalMs: 1000,
      historyLimit: 3,
    });
    for (let i = 0; i < 6; i += 1) await scheduler.tick();
    expect(scheduler.history()).toHaveLength(3);
    expect(scheduler.history(1)[0]!.sweepNumber).toBe(6);
  });
});

describe("two missions never mutate one component at the same time", () => {
  const setup = (over: Partial<Parameters<typeof createMissionScheduler>[0]> = {}) => {
    const c = clock();
    const missions = createMissionControl({ now: c.now });
    const scheduler = createMissionScheduler({ missions, now: c.now, ...over });
    return { c, missions, scheduler };
  };

  it("holds the second mission on a component overlap", () => {
    // Both branch the same component from the same base, both validate in
    // isolation, both pass, and the second silently reverts half of the first.
    const { missions, scheduler } = setup();
    authorized(missions, "mis_a", ["hive.specialized.workorderiq"]);
    authorized(missions, "mis_b", ["hive.specialized.workorderiq"]);

    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    const first = scheduler.admit();
    expect(first.admit).toHaveLength(1);
    expect(first.hold.map((h) => h.kind)).toContain("COMPONENT_OVERLAP");
    expect(first.hold[0]!.detail).toContain("silently reverts half of the first");
  });

  it("does not admit two conflicting missions in the same round", () => {
    // The provisional reservation. Without it both would be admitted at once,
    // because neither is "running" yet when the other is considered.
    const { missions, scheduler } = setup();
    authorized(missions, "mis_a", ["hive.specialized.workorderiq"]);
    authorized(missions, "mis_b", ["hive.specialized.workorderiq"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    expect(scheduler.admit().admit).toEqual(["mis_a"]);
  });

  it("admits missions that touch different components", () => {
    const { missions, scheduler } = setup();
    authorized(missions, "mis_a", ["hive.specialized.workorderiq"]);
    authorized(missions, "mis_b", ["hive.specialized.costiq"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    expect([...scheduler.admit().admit].sort()).toEqual(["mis_a", "mis_b"]);
  });

  it("frees the component when a mission is released", () => {
    const { missions, scheduler } = setup();
    authorized(missions, "mis_a", ["hive.specialized.workorderiq"]);
    authorized(missions, "mis_b", ["hive.specialized.workorderiq"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    scheduler.admitted("mis_a");
    expect(scheduler.admit().admit).toEqual([]);

    scheduler.released("mis_a");
    expect(scheduler.admit().admit).toEqual(["mis_b"]);
  });

  it("answers what a queued mission is waiting on", () => {
    const { missions, scheduler } = setup();
    authorized(missions, "mis_a", ["hive.specialized.workorderiq"]);
    authorized(missions, "mis_b", ["hive.specialized.workorderiq"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");
    scheduler.admitted("mis_a");

    const waiting = scheduler.waitingOn("mis_b")!;
    expect(waiting[0]!.conflictsWith).toBe("mis_a");
    expect(scheduler.waitingOn("mis_nonexistent")).toBeNull();
  });

  it("reports a pairwise conflict before a mission is even proposed to the queue", () => {
    const { missions } = setup();
    const a = authorized(missions, "mis_a", ["hive.specialized.workorderiq", "hive.specialized.costiq"]);
    const b = authorized(missions, "mis_b", ["hive.specialized.costiq"]);
    const c = authorized(missions, "mis_c", ["hive.specialized.visioniq"]);

    expect(missionsConflict(a, b).conflict).toBe(true);
    expect(missionsConflict(a, b).reason).toContain("hive.specialized.costiq");
    expect(missionsConflict(a, c).conflict).toBe(false);
  });
});

describe("capacity limits are enforced separately from conflicts", () => {
  it("holds on the global concurrency limit", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions, maxConcurrentMissions: 1 });
    authorized(missions, "mis_a", ["a"]);
    authorized(missions, "mis_b", ["b"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    const decision = scheduler.admit();
    expect(decision.admit).toHaveLength(1);
    expect(decision.hold.map((h) => h.kind)).toContain("CONCURRENCY_LIMIT");
  });

  it("holds on the per-repository limit", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({
      missions,
      maxConcurrentMissions: 10,
      maxPerEnvironment: 10,
      maxPerRepository: 1,
    });
    authorized(missions, "mis_a", ["a"]);
    authorized(missions, "mis_b", ["b"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    expect(scheduler.admit().hold.map((h) => h.kind)).toContain("REPOSITORY_CONTENTION");
  });

  it("holds on the per-environment limit", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({
      missions,
      maxConcurrentMissions: 10,
      maxPerEnvironment: 1,
      maxPerRepository: 10,
    });
    authorized(missions, "mis_a", ["a"]);
    authorized(missions, "mis_b", ["b"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    expect(scheduler.admit().hold.map((h) => h.kind)).toContain("ENVIRONMENT_LIMIT");
  });
});

describe("priority, and the starvation valve", () => {
  it("runs a critical mission ahead of a low one", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions, maxConcurrentMissions: 1 });
    authorized(missions, "mis_low", ["a"]);
    authorized(missions, "mis_crit", ["b"]);
    scheduler.enqueue("mis_low", "LOW");
    scheduler.enqueue("mis_crit", "CRITICAL");

    expect(scheduler.admit().admit).toEqual(["mis_crit"]);
  });

  it("eventually runs a mission that keeps being passed over", () => {
    // A naive scheduler starves the LOW queue forever, and the LOW queue is
    // where the drift corrections live — the ones that, left undone, become the
    // reason a high-priority mission was needed.
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({
      missions,
      maxConcurrentMissions: 1,
      starvationThreshold: 3,
    });

    authorized(missions, "mis_low", ["low-component"]);
    scheduler.enqueue("mis_low", "LOW");

    // Five high-priority missions arrive and run, one at a time.
    for (let i = 0; i < 5; i += 1) {
      const id = `mis_high_${i}`;
      authorized(missions, id, [`high-component-${i}`]);
      scheduler.enqueue(id, "HIGH");

      const decision = scheduler.admit();
      const chosen = decision.admit[0]!;
      scheduler.admitted(chosen);
      scheduler.released(chosen);

      if (chosen === "mis_low") {
        // The valve opened. That is the assertion.
        expect(i).toBeGreaterThanOrEqual(2);
        return;
      }
    }

    throw new Error("mis_low was starved: it never ran across five rounds of higher-priority work.");
  });

  it("reports which missions were boosted by waiting", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({
      missions,
      maxConcurrentMissions: 1,
      starvationThreshold: 2,
    });
    authorized(missions, "mis_low", ["a"]);
    authorized(missions, "mis_h1", ["b"]);
    authorized(missions, "mis_h2", ["c"]);
    scheduler.enqueue("mis_low", "LOW");
    scheduler.enqueue("mis_h1", "HIGH");
    scheduler.enqueue("mis_h2", "HIGH");

    scheduler.admitted("mis_h1");
    scheduler.released("mis_h1");
    scheduler.admitted("mis_h2");
    scheduler.released("mis_h2");

    expect(scheduler.admit().boosted.map((b) => b.missionId)).toContain("mis_low");
  });

  it("breaks a priority tie by queue order", () => {
    const c = clock();
    const missions = createMissionControl({ now: c.now });
    const scheduler = createMissionScheduler({ missions, now: c.now, maxConcurrentMissions: 1 });
    authorized(missions, "mis_first", ["a"]);
    scheduler.enqueue("mis_first", "NORMAL");
    c.advance(1000);
    authorized(missions, "mis_second", ["b"]);
    scheduler.enqueue("mis_second", "NORMAL");

    expect(scheduler.admit().admit).toEqual(["mis_first"]);
  });
});

describe("the queue refuses work that is not ready", () => {
  it("refuses a mission that Governance has not authorized", () => {
    // Queueing earlier would schedule work Governance has not permitted.
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions });
    missions.propose({ missionId: "mis_new", objective, scope: scopeFor(["a"]) });

    const result = scheduler.enqueue("mis_new", "NORMAL");
    expect(result.queued).toBe(false);
    expect(result.reason).toContain("Governance has not permitted");
  });

  it("drops a mission that ended while queued", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions });
    authorized(missions, "mis_a", ["a"]);
    scheduler.enqueue("mis_a", "NORMAL");
    missions.terminate("mis_a", "ABORTED", "no longer needed", "operator");

    const decision = scheduler.admit();
    expect(decision.admit).toEqual([]);
    // Dropped, not reported as a conflict — that would fill the hold list with
    // noise.
    expect(decision.hold).toEqual([]);
    expect(scheduler.queue()).toEqual([]);
  });

  it("refuses to queue the same mission twice", () => {
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions });
    authorized(missions, "mis_a", ["a"]);
    expect(scheduler.enqueue("mis_a", "NORMAL").queued).toBe(true);
    expect(scheduler.enqueue("mis_a", "NORMAL").queued).toBe(false);
  });

  it("admit() does not mutate the queue", () => {
    // Pure with respect to the queue: calling it twice without starting
    // anything returns the same answer.
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions, maxConcurrentMissions: 1 });
    authorized(missions, "mis_a", ["a"]);
    authorized(missions, "mis_b", ["b"]);
    scheduler.enqueue("mis_a", "NORMAL");
    scheduler.enqueue("mis_b", "NORMAL");

    expect(scheduler.admit().admit).toEqual(scheduler.admit().admit);
    expect(scheduler.queue()).toHaveLength(2);
  });

  it("grants no authority — it only decides ordering", () => {
    // The scheduler does not run missions. Keeping the decision separate from
    // the doing means it can be inspected before anything is spawned.
    const missions = createMissionControl();
    const scheduler = createMissionScheduler({ missions });
    for (const method of Object.keys(scheduler)) {
      expect(/spawn|authorize|grant|promote|deploy/i.test(method), method).toBe(false);
    }
  });
});

describe("the two schedulers work together", () => {
  it("admits, spawns, supervises and releases", async () => {
    const c = clock();
    const missions = createMissionControl({ now: c.now });
    const runtime = createAgentRuntime({ missions, containment, now: c.now });
    const ticker = createManualTicker();
    const supervisor = createSupervisorScheduler({
      runtime,
      ticker,
      intervalMs: 1000,
      now: c.now,
    });
    const missionScheduler = createMissionScheduler({ missions, now: c.now });

    authorized(missions, "mis_1", ["hive.specialized.workorderiq"]);
    missionScheduler.enqueue("mis_1", "HIGH");

    const decision = missionScheduler.admit();
    expect(decision.admit).toEqual(["mis_1"]);

    missionScheduler.admitted("mis_1");
    missions.provision("mis_1", "bot_1", "foundry");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 86_400_000, maxValidationRuns: 2 },
    });

    supervisor.start();
    expect((await supervisor.tick()).terminations).toEqual([]);

    // The lease expires while the agent is doing nothing.
    c.advance(5 * 60 * 60 * 1000);
    const sweep = await supervisor.tick();
    expect(sweep.terminations[0]!.cause).toBe("LEASE_EXPIRED");

    missionScheduler.released("mis_1");
    expect(missionScheduler.runningMissions()).toEqual([]);
    expect(missions.get("mis_1")!.state).toBe("LEASE_EXPIRED");
  });
});
