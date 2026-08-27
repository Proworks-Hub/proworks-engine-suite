// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow state that outlives the process running it.
//
// The hardening directive asks for durable workflow state so PRIME survives a
// restart and can run several copies. Both goals are right. Putting a table
// inside PRIME is not: PRIME is pure and I/O-free, and that is exactly what
// lets it be a library today and a service later without its domain code
// changing. An architecture guard now refuses I/O imports there, so this had to
// arrive as a port.
//
// So it does. PRIME owns the state machine; a host owns the storage. Family
// Table would back this with IndexedDB, ProWorks with Postgres, a test with a
// Map — and the workflow logic cannot tell the difference.
//
// Two properties make multi-instance safe, and both live in the contract rather
// than in any one implementation:
//
//   VERSION — every save states the version it read. A second instance that
//   read the same version loses, and finds out, instead of silently
//   overwriting the first one's work.
//
//   LEASE — resuming an abandoned workflow is claimed for a period. Without it,
//   three PRIME instances noticing the same crashed workflow all resume it, and
//   the compensation for one step runs three times.
// ─────────────────────────────────────────────────────────────────────────────

export const workflowStatusSchema = z.enum([
  "running",
  "completed",
  /** A step failed and its compensations ran. Terminal. */
  "compensated",
  /** A step failed and compensation ALSO failed. Terminal, needs a human. */
  "failed",
  "cancelled",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const workflowStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "compensated",
]);
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

export const workflowStepRecordSchema = z
  .object({
    stepId: z.string().min(1),
    status: workflowStepStatusSchema,
    attempts: z.number().int().min(0).default(0),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    /** What the step produced, so a resumed run need not redo it. */
    output: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();
export type WorkflowStepRecord = z.infer<typeof workflowStepRecordSchema>;

export const workflowInstanceSchema = z
  .object({
    workflowId: z.string().min(1),
    workflowType: z.string().min(1),
    status: workflowStatusSchema,

    /** Whose work this is. Absent only for system-wide maintenance workflows. */
    tenant: tenantContextSchema.optional(),
    /** Required — a workflow nobody can trace is one nobody can debug. */
    trace: traceContextSchema,

    /** Accumulated across steps. Each step reads it and may add to it. */
    context: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(workflowStepRecordSchema).default([]),

    /**
     * Optimistic concurrency. Incremented on every save; a save that states a
     * stale version is rejected rather than applied.
     */
    version: z.number().int().min(0).default(0),

    /** Set while an instance is actively working on it. */
    claimedBy: z.string().min(1).optional(),
    /** When the claim expires, so a crashed instance does not hold it forever. */
    claimedUntil: z.string().optional(),

    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().optional(),
    /** Why it ended badly, kept for the human who has to look. */
    failureReason: z.string().optional(),
  })
  .strict();
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;

/**
 * Raised when a save states a version that is no longer current — another
 * instance changed the workflow first.
 *
 * A distinct type because the correct response is to reload and reconsider,
 * not to retry the same write, and a caller cannot tell those apart from a
 * generic error.
 */
export class WorkflowConflictError extends Error {
  readonly transient = true as const;
  constructor(
    readonly workflowId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Workflow ${workflowId} changed underneath: expected version ${expectedVersion}, found ${actualVersion}. ` +
        `Reload it and decide again rather than retrying this write.`,
    );
    this.name = "WorkflowConflictError";
  }
}

/**
 * Where workflow state lives. Implemented by a host, never by PRIME.
 */
export interface WorkflowStateStore {
  create(instance: WorkflowInstance): Promise<void> | void;

  load(workflowId: string): Promise<WorkflowInstance | null> | WorkflowInstance | null;

  /**
   * Persists a change, stating the version that was read.
   *
   * Must throw `WorkflowConflictError` when that version is stale. Silently
   * accepting the write is how two instances each believe they own a workflow
   * and one's work disappears.
   *
   * The IMPLEMENTATION increments the stored version, not the caller. Leaving
   * that to callers means one that forgets leaves the version unchanged, and
   * the next stale write passes too — concurrency control that depends on
   * everybody remembering is concurrency control that eventually is not there.
   */
  save(instance: WorkflowInstance, expectedVersion: number): Promise<void> | void;

  /**
   * Takes an exclusive lease, returning the instance if it was granted and
   * null if somebody else holds it.
   */
  claim(
    workflowId: string,
    owner: string,
    leaseMs: number,
  ): Promise<WorkflowInstance | null> | WorkflowInstance | null;

  /**
   * Workflows left running whose lease has expired — the ones a crashed
   * instance abandoned. This is what makes restart-resumption possible at all.
   */
  listResumable(limit?: number): Promise<WorkflowInstance[]> | WorkflowInstance[];
}
