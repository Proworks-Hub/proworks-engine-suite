// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Work that must not happen inside a request.
//
// Nesting a large sheet, parsing a batch of receipts, costing a complex job,
// generating an export — these take seconds to minutes. Doing them inline means
// a request that times out, a user watching a spinner, and a retry that starts
// the whole thing again.
//
// The queue is also where BULKHEADS live. If fifty thousand receipts arrive,
// that must not stop manufacturing plans being generated, and the only way to
// guarantee it is separate queues with separate workers. One engine's bad day
// stays that engine's bad day.
//
// PRIME starts jobs and does not wait for them. That is what keeps it a
// coordinator rather than a bottleneck: workers do the computation and scale
// independently, and PRIME's job is deciding what should happen next.
// ─────────────────────────────────────────────────────────────────────────────

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z
  .object({
    jobId: z.string().min(1),
    /**
     * Names the work AND selects the queue: `forgeiq.nest`, `receipt.parse`.
     * The prefix is the bulkhead — work is isolated by whoever does it.
     */
    jobType: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/),
    status: jobStatusSchema,

    tenant: tenantContextSchema.optional(),
    /** Required. A job nobody can tie back to a request is one nobody can explain. */
    trace: traceContextSchema,

    /**
     * A REFERENCE, not the data. A large payload in a queue row is a queue that
     * gets slow to scan and a row that gets expensive to move; the artifact
     * store holds the bytes.
     */
    inputRef: z.string().min(1).optional(),
    /** Inline input, for work small enough that a round trip would cost more. */
    input: z.unknown().optional(),
    resultRef: z.string().min(1).optional(),
    result: z.unknown().optional(),

    /** 0–1. Reported so a caller can show something honest rather than a guess. */
    progress: z.number().min(0).max(1).default(0),
    attempts: z.number().int().min(0).default(0),
    maxAttempts: z.number().int().min(1).default(3),

    /** Higher runs first. Equal priority is first-in, first-out. */
    priority: z.number().int().default(0),
    /** Not before this time — a retry backoff, or work scheduled ahead. */
    availableAt: z.string().optional(),

    claimedBy: z.string().min(1).optional(),
    claimedUntil: z.string().optional(),

    createdAt: z.string().min(1),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type Job = z.infer<typeof jobSchema>;

export interface EnqueueJobInput {
  jobType: string;
  tenant?: z.infer<typeof tenantContextSchema>;
  trace: z.infer<typeof traceContextSchema>;
  input?: unknown;
  inputRef?: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: string;
  /**
   * Supplied by a caller that may retry. Two enqueues with the same id produce
   * one job — the difference between a flaky network and the shop nesting the
   * same sheet twice.
   */
  jobId?: string;
}

/**
 * Where background work waits. A host binds an in-process queue in development
 * and a real broker or table in production.
 */
export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<Job> | Job;

  /**
   * Takes the next available job of the given types, leased to `worker`.
   * Returns null when there is nothing to do — which is the normal case and
   * not an error.
   */
  claim(jobTypes: readonly string[], worker: string, leaseMs: number): Promise<Job | null> | Job | null;

  /** Extends a lease on work still in progress, and reports progress. */
  heartbeat(jobId: string, worker: string, progress?: number): Promise<void> | void;

  complete(jobId: string, result?: unknown, resultRef?: string): Promise<void> | void;

  /**
   * Records a failure. Whether it is retried is the queue's decision, based on
   * attempts, `maxAttempts`, and whether the error looked transient — a worker
   * should not have to know the retry policy to report that something broke.
   */
  fail(jobId: string, error: string, options?: { retryable?: boolean }): Promise<void> | void;

  get(jobId: string): Promise<Job | null> | Job | null;

  /** For dashboards, and for answering "how deep is the queue?". */
  stats(jobTypes?: readonly string[]): Promise<JobQueueStats> | JobQueueStats;
}

export interface JobQueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  /** Age of the oldest queued job, in ms. The number that says a queue is stuck. */
  oldestQueuedMs: number | null;
}
