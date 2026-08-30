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

/**
 * Where a unit of claim work was spent.
 *
 * `claim` does two full passes over the queue and then sorts what survives.
 * Naming the phases separately is what lets a test say WHICH traversal grew,
 * rather than only that something did.
 */
export type ClaimWorkPhase = "lease-sweep" | "candidate-scan" | "candidate-compare";

/**
 * An observation seam for the work `claim` performs. Counting only.
 *
 * Deliberately the narrowest thing that answers "how much work did selecting
 * this job take": one call per job visited, and one per comparison made while
 * ordering the survivors. It receives the PHASE and nothing else -- no job, no
 * id, no payload, no tenant, no trace. It cannot select, reject, reorder,
 * claim, modify or delete anything, because it is handed nothing to act on and
 * its return value is discarded.
 *
 * It exists because the old queue-depth gate measured elapsed time, and elapsed
 * time on a shared machine is not a property of the algorithm.
 */
export type ClaimWorkObserver = (phase: ClaimWorkPhase) => void;

export interface InMemoryJobQueueOptions {
  now?: () => Date;
  generateId?: () => string;
  /** Injected so a test need not wait out a retry backoff. */
  random?: () => number;
  /**
   * Counts the work `claim` does. Optional, absent in every production path,
   * and observational only -- see {@link ClaimWorkObserver}.
   */
  observeClaimWork?: ClaimWorkObserver;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createInMemoryJobQueue(options: InMemoryJobQueueOptions = {}): InMemoryJobQueue {
  const jobs = new Map<string, Job>();

  // ── Indexes, and why they exist ────────────────────────────────────────────
  //
  // `claim` used to make two full passes over every job in the queue: one to
  // reclaim lapsed leases, one to find candidates of the requested types. Both
  // grew with TOTAL queue depth, which made the bulkhead this file documents
  // ("a worker claiming `receipt.parse` never sees `forgeiq.nest`") true about
  // what a worker RECEIVES and false about what it costs to receive it. Fifty
  // thousand receipts did slow the manufacturing workers down — just invisibly,
  // through the scan rather than through the selection.
  //
  //   queuedByType  the queued job ids of one type. The candidate scan reads
  //                 only the requested types, so an unrelated backlog costs
  //                 nothing at all.
  //   running       the job ids currently held by a worker. The lease sweep
  //                 reads only these, so it is bounded by how much work is in
  //                 flight rather than by how much is waiting.
  //
  // Both are derived state, and derived state that drifts is worse than no
  // index at all. So NOTHING below writes to `jobs` directly — every mutation
  // goes through `write`, which is the only place the three can fall out of
  // step, and therefore the only place to look if they ever do.
  const queuedByType = new Map<string, Set<string>>();
  const running = new Set<string>();

  /** The single write path. Keeps `jobs` and both indexes in step by construction. */
  const write = (job: Job): void => {
    const previous = jobs.get(job.jobId);
    if (previous) {
      if (previous.status === "queued") queuedByType.get(previous.jobType)?.delete(previous.jobId);
      if (previous.status === "running") running.delete(previous.jobId);
    }
    if (job.status === "queued") {
      let set = queuedByType.get(job.jobType);
      if (!set) {
        set = new Set<string>();
        queuedByType.set(job.jobType, set);
      }
      set.add(job.jobId);
    }
    if (job.status === "running") running.add(job.jobId);
    jobs.set(job.jobId, job);
  };
  const now = options.now ?? (() => new Date());
  // Read once into a local. Nothing reassigns it, so the observer cannot be
  // swapped for something with authority after construction.
  const observeClaimWork = options.observeClaimWork;
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
      write(job);
      return clone(job);
    },

    claim(jobTypes, worker, leaseMs): Job | null {
      const at = now().getTime();

      // Reclaim anything a crashed worker was holding, before looking at new
      // work. Otherwise a queue can look busy while nothing is progressing.
      //
      // Visits only the RUNNING jobs, so this costs what the shop is currently
      // working on rather than everything it has ever been asked to do.
      // Snapshotted first, because reclaiming mutates the set being read.
      for (const jobId of [...running]) {
        observeClaimWork?.("lease-sweep");
        const job = jobs.get(jobId);
        if (job && leaseExpired(job, at)) {
          write({ ...job, status: "queued", claimedBy: undefined, claimedUntil: undefined });
        }
      }

      // Priority first, then oldest — so an urgent job jumps the queue but
      // equal work is still fair, and nothing starves behind a busy type.
      //
      // Selected in ONE pass rather than by sorting. The old code sorted every
      // candidate and then read `[0]`, paying k log k to answer a question that
      // costs k. Sorting also made fairness depend on the sort being stable;
      // choosing explicitly says what "best" means instead of inheriting it
      // from the engine.
      let next: Job | undefined;
      // De-duplicated: a caller passing the same type twice must not visit its
      // jobs twice, or the work counts stop meaning what they say.
      for (const jobType of new Set(jobTypes)) {
        for (const jobId of queuedByType.get(jobType) ?? []) {
          observeClaimWork?.("candidate-scan");
          const job = jobs.get(jobId);
          if (!job || !available(job, at)) continue;
          if (!next) {
            next = job;
            continue;
          }
          observeClaimWork?.("candidate-compare");
          const better =
            job.priority !== next.priority
              ? job.priority > next.priority
              : job.createdAt.localeCompare(next.createdAt) < 0;
          if (better) next = job;
        }
      }

      if (!next) return null;

      const claimed: Job = {
        ...next,
        status: "running",
        attempts: next.attempts + 1,
        claimedBy: worker,
        claimedUntil: new Date(at + leaseMs).toISOString(),
        startedAt: next.startedAt ?? now().toISOString(),
      };
      write(claimed);
      return clone(claimed);
    },

    heartbeat(jobId, worker, progress) {
      const job = jobs.get(jobId);
      // A heartbeat from a worker that no longer holds the lease is ignored
      // rather than honoured — it has already been reclaimed by someone else,
      // and letting it extend the lease would give two workers the same job.
      if (!job || job.claimedBy !== worker) return;
      write({
        ...job,
        ...(progress !== undefined ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
        claimedUntil: new Date(now().getTime() + 30_000).toISOString(),
      });
    },

    complete(jobId, result, resultRef) {
      const job = jobs.get(jobId);
      if (!job) return;
      write({
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
        write({
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
      write({
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
    clear: () => {
      jobs.clear();
      queuedByType.clear();
      running.clear();
    },
  };
}
