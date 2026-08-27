// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import { METRIC_NAMES, timed, type LogFields } from "@proworks-hub/contracts";
import { createInMemoryJobQueue } from "../inMemoryJobQueue.js";
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
