// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EnqueueJobInput, Job, JobQueue, JobQueueStats } from "@proworks-hub/contracts";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, jobSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// A job queue held in memory.
//
// Enough to develop against and to prove the rules that matter: claims are
// exclusive, leases expire so a crashed worker does not hold work forever,
// retries are bounded and backed off, and a worker claiming `receipt.parse`
// never sees `forgeiq.nest`.
//
// That last one is the bulkhead, and it is the reason job types are namespaced.
// If fifty thousand receipts arrive, the receipt workers get busy and the
// manufacturing workers do not notice.
//
// Not durable, which is the point of the port it implements.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Narrower than the JobQueue port: this implementation is synchronous, so a
 * caller gets a job back without awaiting. It still satisfies the port, so it
 * can be injected anywhere a JobQueue is expected — the same shape CostIqEngine
 * uses over CostEngine.
 *
 * The narrowing is what keeps tests readable. Awaiting a Map is noise that
 * hides the assertion.
 */
export interface InMemoryJobQueue extends JobQueue {
  enqueue(input: EnqueueJobInput): Job;
  claim(jobTypes: readonly string[], worker: string, leaseMs: number): Job | null;
  heartbeat(jobId: string, worker: string, progress?: number): void;
  complete(jobId: string, result?: unknown, resultRef?: string): void;
  fail(jobId: string, error: string, options?: { retryable?: boolean }): void;
  get(jobId: string): Job | null;
  stats(jobTypes?: readonly string[]): JobQueueStats;
  all(): Job[];
  clear(): void;
}

export interface InMemoryJobQueueOptions {
  now?: () => Date;
  generateId?: () => string;
  /** Injected so a test need not wait out a retry backoff. */
  random?: () => number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createInMemoryJobQueue(options: InMemoryJobQueueOptions = {}): InMemoryJobQueue {
  const jobs = new Map<string, Job>();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const generateId =
    options.generateId ??
    (() => {
      const g = globalThis as { crypto?: { randomUUID?: () => string } };
      return typeof g.crypto?.randomUUID === "function"
        ? `job_${g.crypto.randomUUID()}`
        : `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const available = (job: Job, at: number): boolean =>
    job.status === "queued" && (!job.availableAt || new Date(job.availableAt).getTime() <= at);

  const leaseExpired = (job: Job, at: number): boolean =>
    !job.claimedUntil || new Date(job.claimedUntil).getTime() <= at;

  return {
    enqueue(input: EnqueueJobInput): Job {
      const jobId = input.jobId ?? generateId();
      const existing = jobs.get(jobId);
      // An idempotency key already used returns the original. A flaky network
      // must not make the shop nest the same sheet twice.
      if (existing) return clone(existing);

      const job = jobSchema.parse({
        jobId,
        jobType: input.jobType,
        status: "queued",
        ...(input.tenant ? { tenant: input.tenant } : {}),
        trace: input.trace,
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.inputRef ? { inputRef: input.inputRef } : {}),
        progress: 0,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        priority: input.priority ?? 0,
        ...(input.availableAt ? { availableAt: input.availableAt } : {}),
        createdAt: now().toISOString(),
      });
      jobs.set(jobId, job);
      return clone(job);
    },

    claim(jobTypes, worker, leaseMs): Job | null {
      const at = now().getTime();

      // Reclaim anything a crashed worker was holding, before looking at new
      // work. Otherwise a queue can look busy while nothing is progressing.
      for (const job of jobs.values()) {
        if (job.status === "running" && leaseExpired(job, at)) {
          jobs.set(job.jobId, { ...job, status: "queued", claimedBy: undefined, claimedUntil: undefined });
        }
      }

      const candidates = [...jobs.values()]
        .filter((j) => jobTypes.includes(j.jobType) && available(j, at))
        // Priority first, then oldest — so an urgent job jumps the queue but
        // equal work is still fair, and nothing starves behind a busy type.
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

      const next = candidates[0];
      if (!next) return null;

      const claimed: Job = {
        ...next,
        status: "running",
        attempts: next.attempts + 1,
        claimedBy: worker,
        claimedUntil: new Date(at + leaseMs).toISOString(),
        startedAt: next.startedAt ?? now().toISOString(),
      };
      jobs.set(next.jobId, claimed);
      return clone(claimed);
    },

    heartbeat(jobId, worker, progress) {
      const job = jobs.get(jobId);
      // A heartbeat from a worker that no longer holds the lease is ignored
      // rather than honoured — it has already been reclaimed by someone else,
      // and letting it extend the lease would give two workers the same job.
      if (!job || job.claimedBy !== worker) return;
      jobs.set(jobId, {
        ...job,
        ...(progress !== undefined ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
        claimedUntil: new Date(now().getTime() + 30_000).toISOString(),
      });
    },

    complete(jobId, result, resultRef) {
      const job = jobs.get(jobId);
      if (!job) return;
      jobs.set(jobId, {
        ...job,
        status: "completed",
        progress: 1,
        ...(result !== undefined ? { result } : {}),
        ...(resultRef ? { resultRef } : {}),
        completedAt: now().toISOString(),
        claimedBy: undefined,
        claimedUntil: undefined,
      });
    },

    fail(jobId, error, failOptions) {
      const job = jobs.get(jobId);
      if (!job) return;
      const retryable = failOptions?.retryable ?? true;
      const exhausted = job.attempts >= job.maxAttempts;

      if (!retryable || exhausted) {
        jobs.set(jobId, {
          ...job,
          status: "failed",
          error,
          completedAt: now().toISOString(),
          claimedBy: undefined,
          claimedUntil: undefined,
        });
        return;
      }

      // Back off before it is eligible again, so a failing dependency is not
      // hammered by the same job returning immediately.
      const delay = backoffDelayMs(job.attempts, DEFAULT_RETRY_POLICY, random);
      jobs.set(jobId, {
        ...job,
        status: "queued",
        error,
        availableAt: new Date(now().getTime() + delay).toISOString(),
        claimedBy: undefined,
        claimedUntil: undefined,
      });
    },

    get: (jobId) => {
      const job = jobs.get(jobId);
      return job ? clone(job) : null;
    },

    stats(jobTypes): JobQueueStats {
      const at = now().getTime();
      const scope = [...jobs.values()].filter((j) => !jobTypes || jobTypes.includes(j.jobType));
      const queued = scope.filter((j) => j.status === "queued");
      const oldest = queued
        .map((j) => at - new Date(j.createdAt).getTime())
        .sort((a, b) => b - a)[0];
      return {
        queued: queued.length,
        running: scope.filter((j) => j.status === "running").length,
        completed: scope.filter((j) => j.status === "completed").length,
        failed: scope.filter((j) => j.status === "failed").length,
        oldestQueuedMs: oldest ?? null,
      };
    },

    all: () => [...jobs.values()].map(clone),
    clear: () => jobs.clear(),
  };
}
