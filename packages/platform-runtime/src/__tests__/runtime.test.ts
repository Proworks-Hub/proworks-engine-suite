// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import { METRIC_NAMES, timed, type LogFields } from "@proworks-hub/contracts";
import { createInMemoryJobQueue, type ClaimWorkPhase } from "../inMemoryJobQueue.js";
import { createInMemoryMetrics, createStructuredLogger, type StructuredLogRecord } from "../observability.js";

const trace = { correlationId: "cor_1" };
const tenant = { organizationId: "acme", roles: [] };

describe("the job queue", () => {
  it("hands work to one worker only", () => {
    const q = createInMemoryJobQueue();
    q.enqueue({ jobType: "forgeiq.nest", trace, input: { sheet: 1 } });

    expect(q.claim(["forgeiq.nest"], "worker-a", 30_000)).not.toBeNull();
    expect(q.claim(["forgeiq.nest"], "worker-b", 30_000)).toBeNull();
  });

  it("isolates work by type, so one busy engine does not block another", () => {
    const q = createInMemoryJobQueue();
    // Fifty thousand receipts arrive.
    for (let i = 0; i < 50; i += 1) q.enqueue({ jobType: "receipt.parse", trace });
    q.enqueue({ jobType: "forgeiq.nest", trace });

    // The manufacturing worker still gets its job immediately. That is the
    // bulkhead: a receipt flood is a receipt problem.
    const nest = q.claim(["forgeiq.nest"], "forge-worker", 30_000);
    expect(nest?.jobType).toBe("forgeiq.nest");
  });

  it("runs higher priority first, and is otherwise fair", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock });
    q.enqueue({ jobType: "a.one", trace, jobId: "first" });
    clock = new Date(clock.getTime() + 1000);
    q.enqueue({ jobType: "a.one", trace, jobId: "second" });
    clock = new Date(clock.getTime() + 1000);
    q.enqueue({ jobType: "a.one", trace, jobId: "urgent", priority: 10 });

    expect(q.claim(["a.one"], "w", 30_000)?.jobId).toBe("urgent");
    // Equal priority falls back to oldest, so nothing starves.
    expect(q.claim(["a.one"], "w2", 30_000)?.jobId).toBe("first");
  });

  it("returns the original job for a repeated idempotency key", () => {
    const q = createInMemoryJobQueue();
    const a = q.enqueue({ jobType: "forgeiq.nest", trace, jobId: "nest_1" });
    const b = q.enqueue({ jobType: "forgeiq.nest", trace, jobId: "nest_1" });
    expect(a.jobId).toBe(b.jobId);
    expect(q.all()).toHaveLength(1);
  });

  it("reclaims work a crashed worker was holding", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock });
    q.enqueue({ jobType: "receipt.parse", trace, jobId: "r1" });

    q.claim(["receipt.parse"], "worker-that-dies", 1_000);
    expect(q.claim(["receipt.parse"], "worker-b", 1_000)).toBeNull();

    // The lease expires; the work becomes available again rather than being
    // held forever by a process that is gone.
    clock = new Date(clock.getTime() + 5_000);
    expect(q.claim(["receipt.parse"], "worker-b", 1_000)?.jobId).toBe("r1");
  });

  it("ignores a heartbeat from a worker that no longer holds the lease", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock });
    q.enqueue({ jobType: "a.one", trace, jobId: "j1" });
    q.claim(["a.one"], "stale-worker", 1_000);

    clock = new Date(clock.getTime() + 5_000);
    q.claim(["a.one"], "new-worker", 30_000);

    // Honouring this would give two workers the same job.
    q.heartbeat("j1", "stale-worker", 0.9);
    expect(q.get("j1")?.claimedBy).toBe("new-worker");
    expect(q.get("j1")?.progress).toBe(0);
  });

  it("retries a transient failure with backoff, then gives up", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock, random: () => 0.5 });
    q.enqueue({ jobType: "a.one", trace, jobId: "j1", maxAttempts: 2 });

    q.claim(["a.one"], "w", 30_000);
    q.fail("j1", "broker down");
    expect(q.get("j1")?.status).toBe("queued");
    // Not immediately available — a failing dependency should not be hammered.
    expect(q.claim(["a.one"], "w", 30_000)).toBeNull();

    clock = new Date(clock.getTime() + 10_000);
    q.claim(["a.one"], "w", 30_000);
    q.fail("j1", "broker still down");
    expect(q.get("j1")?.status).toBe("failed");
  });

  it("does not retry a failure the worker says is permanent", () => {
    const q = createInMemoryJobQueue();
    q.enqueue({ jobType: "a.one", trace, jobId: "j1", maxAttempts: 5 });
    q.claim(["a.one"], "w", 30_000);
    q.fail("j1", "input will never parse", { retryable: false });
    expect(q.get("j1")?.status).toBe("failed");
    expect(q.get("j1")?.attempts).toBe(1);
  });

  it("reports depth and the age of the oldest queued job", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock });
    q.enqueue({ jobType: "a.one", trace });
    clock = new Date(clock.getTime() + 60_000);
    q.enqueue({ jobType: "a.one", trace });

    const stats = q.stats(["a.one"]);
    expect(stats.queued).toBe(2);
    // The number that says a queue is stuck rather than merely busy.
    expect(stats.oldestQueuedMs).toBe(60_000);
  });
});

describe("structured logging", () => {
  it("emits fields rather than a sentence", () => {
    const lines: StructuredLogRecord[] = [];
    const log = createStructuredLogger({ sink: (r) => lines.push(r) });
    log.log("info", "cost.calculated", { engine: "costiq", durationMs: 12, status: "success" });

    expect(lines[0]).toMatchObject({
      level: "info",
      message: "cost.calculated",
      fields: { engine: "costiq", durationMs: 12, status: "success" },
    });
  });

  it("carries the correlation on every line beneath a child", () => {
    const lines: StructuredLogRecord[] = [];
    const root = createStructuredLogger({ sink: (r) => lines.push(r) });
    // Attached once at the boundary rather than remembered at each call site,
    // which is exactly where it gets forgotten.
    const scoped = root.child({ trace, tenant });
    scoped.log("info", "step.one");
    scoped.log("warn", "step.two");

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => (l.fields as LogFields).trace === trace)).toBe(true);
  });

  it("drops lines below the configured level without formatting them", () => {
    const sink = vi.fn();
    createStructuredLogger({ sink, minLevel: "warn" }).log("debug", "noisy");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("metrics", () => {
  it("counts, and narrows by label", () => {
    const m = createInMemoryMetrics();
    m.increment(METRIC_NAMES.jobCompleted, { engine: "forgeiq" });
    m.increment(METRIC_NAMES.jobCompleted, { engine: "forgeiq" });
    m.increment(METRIC_NAMES.jobCompleted, { engine: "costiq" });

    expect(m.counterTotal(METRIC_NAMES.jobCompleted)).toBe(3);
    expect(m.counterTotal(METRIC_NAMES.jobCompleted, { engine: "forgeiq" })).toBe(2);
  });

  it("reports percentiles, because an average hides the slow one", () => {
    const m = createInMemoryMetrics();
    for (const ms of [10, 10, 10, 10, 10, 10, 10, 10, 10, 9000]) {
      m.observe(METRIC_NAMES.jobDurationMs, ms, { engine: "receiptiq" });
    }
    expect(m.percentile(METRIC_NAMES.jobDurationMs, 50)).toBe(10);
    // The request somebody is complaining about.
    expect(m.percentile(METRIC_NAMES.jobDurationMs, 100)).toBe(9000);
  });

  it("returns null for a series with no samples, rather than zero", () => {
    // Zero would read as "instant", which is a different claim from "unknown".
    expect(createInMemoryMetrics().percentile("nothing.here", 95)).toBeNull();
  });
});

describe("timed()", () => {
  it("reports one line and one observation on success", async () => {
    const lines: StructuredLogRecord[] = [];
    const metrics = createInMemoryMetrics();
    let clock = 1000;

    const result = await timed(() => "done", {
      logger: createStructuredLogger({ sink: (r) => lines.push(r) }),
      metrics,
      engine: "costiq",
      operation: "calculate",
      now: () => (clock += 25),
    });

    expect(result).toBe("done");
    expect(lines[0]!.fields).toMatchObject({ engine: "costiq", status: "success", durationMs: 25 });
    expect(metrics.observations()).toHaveLength(1);
  });

  it("still reports when the work throws, and rethrows", async () => {
    const lines: StructuredLogRecord[] = [];
    const metrics = createInMemoryMetrics();

    await expect(
      timed(
        () => {
          throw new TypeError("bad input");
        },
        {
          logger: createStructuredLogger({ sink: (r) => lines.push(r), minLevel: "debug" }),
          metrics,
          engine: "forgeiq",
          operation: "nest",
        },
      ),
    ).rejects.toThrow("bad input");

    // The missing line is always the failure case, so this is the one that matters.
    expect(lines[0]!.fields).toMatchObject({ status: "failure", errorName: "TypeError" });
    expect(metrics.observations()[0]!.labels).toMatchObject({ status: "failure" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIS-SCALE-QD — the claim-work observation seam.
//
// The seam exists so a scale gate can count claim work instead of timing it.
// That is only worth anything if observing the queue does not change it, so
// these tests compare an observed queue against an unobserved one rather than
// asserting the observer's good intentions.
// ─────────────────────────────────────────────────────────────────────────────

describe("the claim-work observation seam", () => {
  /** The same queue contents every time, so two runs are comparable. */
  const seed = (q: ReturnType<typeof createInMemoryJobQueue>) => {
    q.enqueue({ jobType: "receipt.parse", trace, jobId: "r1" });
    q.enqueue({ jobType: "receipt.parse", trace, jobId: "r2" });
    q.enqueue({ jobType: "forgeiq.nest", trace, tenant, jobId: "n1", priority: 1, input: { sheet: 1 } });
    q.enqueue({ jobType: "forgeiq.nest", trace, jobId: "n2", priority: 5, input: { sheet: 2 } });
  };

  it("counts one unit per job visited, in both passes", () => {
    const phases: ClaimWorkPhase[] = [];
    const q = createInMemoryJobQueue({ observeClaimWork: (p) => phases.push(p) });
    seed(q);

    q.claim(["forgeiq.nest"], "forge", 30_000);

    // Four jobs, and BOTH passes visit every one of them regardless of type —
    // which is the fact the scale gate is built on.
    expect(phases.filter((p) => p === "lease-sweep")).toHaveLength(4);
    expect(phases.filter((p) => p === "candidate-scan")).toHaveLength(4);
    // Two nest jobs survive the filter, so the sort makes one comparison.
    expect(phases.filter((p) => p === "candidate-compare")).toHaveLength(1);
  });

  it("gives the observer nothing to leak", () => {
    // The seam is handed a phase string and nothing else. A test cannot prove
    // the absence of a leak by inspecting what arrived, so this asserts the
    // shape of what CAN arrive: one string argument drawn from a closed set.
    const received: unknown[][] = [];
    const q = createInMemoryJobQueue({
      observeClaimWork: (...args: unknown[]) => received.push(args),
    });
    q.enqueue({
      jobType: "forgeiq.nest",
      trace,
      tenant,
      jobId: "secret",
      input: { customerName: "Brighton Signs", apiKey: "sk-do-not-leak" },
    });
    q.claim(["forgeiq.nest"], "forge", 30_000);

    expect(received.length).toBeGreaterThan(0);
    for (const args of received) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("string");
      expect(["lease-sweep", "candidate-scan", "candidate-compare"]).toContain(args[0]);
    }
    // Nothing the job carried appears anywhere in what the observer saw.
    const seen = JSON.stringify(received);
    expect(seen).not.toContain("secret");
    expect(seen).not.toContain("Brighton");
    expect(seen).not.toContain("sk-do-not-leak");
    expect(seen).not.toContain("acme");
    expect(seen).not.toContain("cor_1");
  });

  // Both queues get the SAME fixed clock. Left on the wall clock these two
  // differed by a millisecond in createdAt -- a real comparison defeated by
  // exactly the kind of timing noise this mission exists to take out of tests.
  const FIXED = new Date("2026-08-29T10:00:00.000Z");
  const pinned = (observe?: () => void) =>
    createInMemoryJobQueue({ now: () => FIXED, ...(observe ? { observeClaimWork: observe } : {}) });

  it("returns the identical job with and without an observer", () => {
    const observed = pinned(() => {});
    const plain = pinned();
    seed(observed);
    seed(plain);

    const a = observed.claim(["forgeiq.nest"], "forge", 30_000);
    const b = plain.claim(["forgeiq.nest"], "forge", 30_000);

    // Priority 5 beats priority 1 in both. Same job, same fields.
    expect(a?.jobId).toBe("n2");
    expect(a).toEqual(b);
  });

  it("leaves identical queue state behind", () => {
    const observed = pinned(() => {});
    const plain = pinned();
    seed(observed);
    seed(plain);

    observed.claim(["forgeiq.nest"], "forge", 30_000);
    plain.claim(["forgeiq.nest"], "forge", 30_000);

    expect(observed.all()).toEqual(plain.all());
    expect(observed.stats()).toEqual(plain.stats());
  });

  it("an observer that throws cannot be used to steer the queue", () => {
    // Not a supported way to use the seam — but if it were swallowed, the
    // observer would gain a way to abort a claim it dislikes, which is exactly
    // the authority it must not have. It propagates instead of silently
    // altering selection.
    const q = createInMemoryJobQueue({
      observeClaimWork: () => {
        throw new Error("observer");
      },
    });
    seed(q);
    expect(() => q.claim(["forgeiq.nest"], "forge", 30_000)).toThrow("observer");

    // And it changed nothing on the way out: no job is running.
    expect(q.all().every((j) => j.status === "queued")).toBe(true);
  });

  it("counts identically across repeated identical runs", () => {
    const run = () => {
      let n = 0;
      const q = createInMemoryJobQueue({ observeClaimWork: () => (n += 1) });
      seed(q);
      q.claim(["forgeiq.nest"], "forge", 30_000);
      return n;
    };
    expect(run()).toBe(run());
    expect(run()).toBe(9);
  });

  it("does not disturb lease reclaim, retries, or type isolation", () => {
    // The behaviours the seam sits inside. Observed queue, ordinary assertions.
    let clock = new Date("2026-08-29T10:00:00.000Z");
    const q = createInMemoryJobQueue({
      now: () => clock,
      observeClaimWork: () => {},
      random: () => 0,
    });
    q.enqueue({ jobType: "forgeiq.nest", trace, jobId: "n1" });

    const first = q.claim(["forgeiq.nest"], "worker-a", 1_000);
    expect(first?.claimedBy).toBe("worker-a");
    // Nobody else gets it while the lease holds.
    expect(q.claim(["forgeiq.nest"], "worker-b", 1_000)).toBeNull();

    // After the lease expires it is reclaimed for someone else.
    clock = new Date("2026-08-29T10:00:05.000Z");
    const second = q.claim(["forgeiq.nest"], "worker-b", 1_000);
    expect(second?.claimedBy).toBe("worker-b");
    expect(second?.attempts).toBe(2);

    // A receipt worker still never sees nest work.
    expect(q.claim(["receipt.parse"], "receipts", 1_000)).toBeNull();
  });
});
