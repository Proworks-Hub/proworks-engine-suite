// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { WorkflowInstance, WorkflowStateStore } from "@proworks-hub/contracts";
import { WorkflowConflictError } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// A workflow store held in memory.
//
// Ships alongside the runner for the same reason `createInMemoryEventLog` ships
// alongside the event log: a port with no usable implementation is a port
// nobody can try. This one is enough to develop against and to prove the
// concurrency rules hold, and it is a Map rather than a connection, so PRIME
// stays pure.
//
// It is NOT durable, which is the entire point of the port it implements. A
// host binds something that survives a restart.
// ─────────────────────────────────────────────────────────────────────────────

export interface InMemoryWorkflowStateStore extends WorkflowStateStore {
  /** Everything held, for tests and debugging. */
  all(): WorkflowInstance[];
  size(): number;
  clear(): void;
}

export function createInMemoryWorkflowStateStore(options: { now?: () => Date } = {}): InMemoryWorkflowStateStore {
  const instances = new Map<string, WorkflowInstance>();
  const now = options.now ?? (() => new Date());

  const leaseExpired = (instance: WorkflowInstance): boolean =>
    !instance.claimedUntil || new Date(instance.claimedUntil).getTime() <= now().getTime();

  return {
    create(instance) {
      if (instances.has(instance.workflowId)) {
        throw new Error(`Workflow ${instance.workflowId} already exists`);
      }
      instances.set(instance.workflowId, structuredCloneish(instance));
    },

    load(workflowId) {
      const found = instances.get(workflowId);
      // Cloned on the way out so a caller mutating what it read cannot change
      // stored state behind the version check's back.
      return found ? structuredCloneish(found) : null;
    },

    save(instance, expectedVersion) {
      const current = instances.get(instance.workflowId);
      if (!current) throw new Error(`Workflow ${instance.workflowId} does not exist`);
      if (current.version !== expectedVersion) {
        throw new WorkflowConflictError(instance.workflowId, expectedVersion, current.version);
      }
      // The STORE increments, not the caller. A caller that forgot would leave
      // the version unchanged and the next stale write would also pass, which
      // is optimistic concurrency that quietly does not happen.
      instances.set(instance.workflowId, structuredCloneish({ ...instance, version: expectedVersion + 1 }));
    },

    claim(workflowId, owner, leaseMs) {
      const current = instances.get(workflowId);
      if (!current) return null;
      // Already ours, or nobody's, or abandoned by someone who crashed.
      const available = current.claimedBy === owner || !current.claimedBy || leaseExpired(current);
      if (!available) return null;

      const claimed: WorkflowInstance = {
        ...current,
        claimedBy: owner,
        claimedUntil: new Date(now().getTime() + leaseMs).toISOString(),
      };
      // Deliberately does NOT bump the version. A claim is coordination, not a
      // change to the workflow, and bumping it would make the claimer's own
      // next save conflict with itself.
      instances.set(workflowId, structuredCloneish(claimed));
      return structuredCloneish(claimed);
    },

    listResumable(limit = 10) {
      return [...instances.values()]
        .filter((i) => i.status === "running" && leaseExpired(i))
        .slice(0, limit)
        .map(structuredCloneish);
    },

    all: () => [...instances.values()].map(structuredCloneish),
    size: () => instances.size,
    clear: () => instances.clear(),
  };
}

/**
 * A deep copy that does not reach for `structuredClone`, which is missing in
 * older runtimes — and which the purity guard would flag as an ambient global.
 */
function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
